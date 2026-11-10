import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { type Envelope, EVENTS, type EventData, type EventType } from "../contracts/index.js";
import { HttpClient, UpstreamError } from "../http-client/index.js";
import type { Db, Sql } from "./db.js";

export interface OutboxOptions {
  // This service's name: the envelope `source` and the service-token issuer.
  source: string;
  // Consumer name → its POST /internal/events URL. No URL = not subscribed
  // (that consumer isn't deployed here), so no delivery row is written.
  consumers: Record<string, string | undefined>;
  // Event type → the consumers that receive it.
  routes: Partial<Record<EventType, string[]>>;
  serviceTokenSecret: string;
  // Seconds to wait before attempt 2, 3, …; the last value repeats.
  retryDelaysSeconds?: number[];
  // Stop retrying after this long and mark the delivery failed.
  maxAgeSeconds?: number;
  pollMs?: number;
  batchSize?: number;
  timeoutMs?: number;
}

export const DEFAULT_RETRY_DELAYS = [10, 60, 600, 3600];

// After `failed` attempts: how long to wait before the next one, or whether
// to give up. Retries run for at least maxAgeSeconds in total (about 24 h by
// default). Counting attempts rather than the event's age means an admin
// retry gets a full new round.
export function nextAttempt(failed: number, delays: number[], maxAgeSeconds: number) {
  const delayAt = (i: number) => delays[Math.min(i, delays.length - 1)]!;
  let waited = 0;
  for (let i = 0; i < failed - 1; i++) waited += delayAt(i);
  return { giveUp: waited >= maxAgeSeconds, delaySeconds: delayAt(failed - 1) };
}

export class Outbox {
  constructor(private readonly options: OutboxOptions) {}

  // Call inside the transaction that makes the change, so the change and its
  // event are saved together or not at all.
  async publish<T extends EventType>(tx: Sql, type: T, data: EventData<T>, meta: { correlationId?: string } = {}) {
    const { version, data: schema } = EVENTS[type];
    const payload = schema.parse(data);
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO OutboxEvent (id, type, version, payload, correlationId, createdAt)
      VALUES (${id}, ${type}, ${version}, ${JSON.stringify(payload)}, ${meta.correlationId ?? null}, UTC_TIMESTAMP(3))`;
    for (const consumer of this.subscribers(type)) {
      await tx.$executeRaw`
        INSERT INTO OutboxDelivery (eventId, consumer, status, attempts, nextAttemptAt)
        VALUES (${id}, ${consumer}, 'pending', 0, UTC_TIMESTAMP(3))`;
    }
    return id;
  }

  subscribers(type: EventType) {
    return (this.options.routes[type] ?? []).filter((c) => this.options.consumers[c]);
  }
}

interface Claimed {
  eventId: string;
  consumer: string;
  attempts: number | bigint;
  type: string;
  version: number | bigint;
  payload: unknown;
  correlationId: string | null;
  occurredAt: string;
}

const LEASE_SECONDS = 60;

// Sends pending deliveries. Runs in every replica: rows are claimed with
// SKIP LOCKED and leased for a minute, so two relays never send the same row
// at once, and a relay that dies mid-send only delays it by the lease.
export class OutboxRelay {
  private readonly clients = new Map<string, HttpClient>();
  private readonly delays: number[];
  private readonly maxAge: number;
  private readonly pollMs: number;
  private readonly batch: number;
  private stopped = true;
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly options: OutboxOptions,
    private readonly logger: Logger,
  ) {
    this.delays = options.retryDelaysSeconds?.length ? options.retryDelaysSeconds : DEFAULT_RETRY_DELAYS;
    this.maxAge = options.maxAgeSeconds ?? 24 * 3600;
    this.pollMs = options.pollMs ?? 1000;
    this.batch = options.batchSize ?? 20;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = this.loop();
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  // Send now instead of at the next poll (call after a commit).
  kick() {
    this.wake?.();
  }

  private async loop() {
    while (!this.stopped) {
      let sent = 0;
      try {
        sent = await this.tick();
      } catch (err) {
        this.logger.error({ err }, "outbox relay tick failed");
      }
      if (sent < this.batch && !this.stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  // Claims and sends one batch. Returns how many deliveries it tried.
  async tick() {
    const claimed = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Claimed[]>`
        SELECT d.eventId, d.consumer, d.attempts, e.type, e.version, e.payload, e.correlationId,
               DATE_FORMAT(e.createdAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt
        FROM OutboxDelivery d JOIN OutboxEvent e ON e.id = d.eventId
        WHERE d.status = 'pending' AND d.nextAttemptAt <= UTC_TIMESTAMP(3)
        ORDER BY d.nextAttemptAt
        LIMIT ${this.batch}
        FOR UPDATE OF d SKIP LOCKED`;
      for (const r of rows) {
        await tx.$executeRaw`
          UPDATE OutboxDelivery SET nextAttemptAt = UTC_TIMESTAMP(3) + INTERVAL ${LEASE_SECONDS} SECOND
          WHERE eventId = ${r.eventId} AND consumer = ${r.consumer}`;
      }
      return rows;
    });
    await Promise.all(claimed.map((row) => this.deliver(row)));
    return claimed.length;
  }

  private async deliver(row: Claimed) {
    const url = this.options.consumers[row.consumer];
    const event: Envelope = {
      id: row.eventId,
      type: row.type,
      version: Number(row.version),
      occurredAt: row.occurredAt,
      source: this.options.source,
      correlationId: row.correlationId,
      data: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    };

    let error: string | null = url ? null : "consumer has no URL configured";
    if (url) {
      try {
        const res = await this.client(row.consumer).post(url, event, { requestId: row.correlationId ?? undefined });
        if (res.status >= 300) error = `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`;
      } catch (err) {
        error = err instanceof UpstreamError ? err.message : String(err);
      }
    }

    if (!error) {
      await this.db.$executeRaw`
        UPDATE OutboxDelivery
        SET status = 'delivered', attempts = attempts + 1, deliveredAt = UTC_TIMESTAMP(3), lastError = NULL
        WHERE eventId = ${row.eventId} AND consumer = ${row.consumer}`;
      return;
    }

    const attempts = Number(row.attempts) + 1;
    const { giveUp, delaySeconds } = nextAttempt(attempts, this.delays, this.maxAge);
    await this.db.$executeRaw`
      UPDATE OutboxDelivery
      SET status = ${giveUp ? "failed" : "pending"}, attempts = ${attempts}, lastError = ${error.slice(0, 500)},
          nextAttemptAt = UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND
      WHERE eventId = ${row.eventId} AND consumer = ${row.consumer}`;
    const log = { eventId: row.eventId, type: row.type, consumer: row.consumer, attempts, error };
    // A failed delivery needs a person: this line is what the alert watches (§12).
    if (giveUp) this.logger.error(log, "event delivery failed; giving up until an admin retries it");
    else this.logger.warn({ ...log, retryInSeconds: delaySeconds }, "event delivery failed; will retry");
  }

  private client(consumer: string) {
    let client = this.clients.get(consumer);
    if (!client) {
      client = new HttpClient({
        target: consumer,
        timeoutMs: this.options.timeoutMs ?? 5000,
        // The outbox is the retry mechanism; one attempt per claim.
        retries: 0,
        serviceToken: { secret: this.options.serviceTokenSecret, from: this.options.source },
      });
      this.clients.set(consumer, client);
    }
    return client;
  }
}
