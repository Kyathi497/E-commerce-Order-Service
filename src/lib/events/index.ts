import {
  Body,
  Controller,
  type DynamicModule,
  Get,
  HttpCode,
  Inject,
  Module,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type { Logger } from "pino";
import { InternalOnly, Roles } from "../auth-guard/index.js";
import { AppError } from "../common/index.js";
import { type Envelope, envelope, EVENTS, type EventData, type EventType, isEventType } from "../contracts/index.js";
import type { Db, Sql } from "./db.js";
import { Outbox, type OutboxOptions, OutboxRelay } from "./outbox.js";

export type { Db, Sql } from "./db.js";
export { nextAttempt, Outbox, OutboxRelay } from "./outbox.js";

export type EventHandlers<Tx extends Sql = Sql> = {
  [T in EventType]?: (tx: Tx, data: EventData<T>, event: Envelope<EventData<T>>) => Promise<void>;
};

export interface EventsOptions extends OutboxOptions {
  db: Db;
  logger: Logger;
  // Handlers for the events this service consumes (served at POST /internal/events).
  handlers?: EventHandlers<never>;
  // Start the relay (off in tests that drive tick() themselves).
  relay?: boolean;
}

const OPTIONS = Symbol("EVENTS_OPTIONS");

// Receives events from other services' relays (§8).
@Controller("internal/events")
class InboxController {
  constructor(@Inject(OPTIONS) private readonly options: EventsOptions) {}

  @InternalOnly()
  @Post()
  @HttpCode(200)
  async receive(@Body() body: unknown) {
    const parsed = envelope.safeParse(body);
    if (!parsed.success) throw new AppError(422, "BAD_EVENT", "Invalid event.");
    const event = parsed.data;
    const handler = isEventType(event.type) ? this.options.handlers?.[event.type] : undefined;
    // Not ours, or a version we don't know: accept so the producer stops retrying.
    if (!handler || EVENTS[event.type as EventType].version !== event.version) {
      return { status: "ignored" };
    }
    const data = EVENTS[event.type as EventType].data.safeParse(event.data);
    if (!data.success) throw new AppError(422, "BAD_EVENT", "Invalid event data.");

    // The inbox row and the handler's writes commit together: a repeated
    // delivery finds the row and does nothing, and a failed handler leaves
    // no row, so the producer's retry runs it again.
    const status = await this.options.db.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT IGNORE INTO ProcessedEvent (eventId, type, processedAt) VALUES (${event.id}, ${event.type}, UTC_TIMESTAMP(3))`;
      if (inserted === 0) return "duplicate";
      await (handler as (tx: Sql, data: unknown, event: Envelope) => Promise<void>)(tx, data.data, event);
      return "processed";
    });
    this.options.logger.info({ eventId: event.id, type: event.type, source: event.source, status }, "event received");
    return { status };
  }
}

interface DeliveryRow {
  eventId: string;
  consumer: string;
  status: string;
  attempts: number | bigint;
  lastError: string | null;
  type: string;
  createdAt: string;
}

// Failed or stuck deliveries, and a replay button (§7). Mounted at a
// per-service path such as admin/events/catalog so the gateway can route it.
function adminController(path: string) {
  @Roles("admin")
  @Controller(path)
  class EventsAdminController {
    constructor(@Inject(OPTIONS) private readonly options: EventsOptions) {}

    @Get("deliveries")
    async list(@Query("status") status = "failed") {
      if (!["pending", "delivered", "failed"].includes(status)) {
        throw new AppError(422, "VALIDATION_FAILED", "Please check the highlighted fields.", {
          status: "Use pending, delivered or failed.",
        });
      }
      const rows = await this.options.db.$queryRaw<DeliveryRow[]>`
        SELECT d.eventId, d.consumer, d.status, d.attempts, d.lastError, e.type,
               DATE_FORMAT(e.createdAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt
        FROM OutboxDelivery d JOIN OutboxEvent e ON e.id = d.eventId
        WHERE d.status = ${status}
        ORDER BY e.createdAt DESC
        LIMIT 100`;
      return { items: rows.map((r) => ({ ...r, attempts: Number(r.attempts) })) };
    }

    @Post(":eventId/retry")
    @HttpCode(200)
    async retry(@Param("eventId") eventId: string) {
      const count = await this.options.db.$executeRaw`
        UPDATE OutboxDelivery SET status = 'pending', attempts = 0, nextAttemptAt = UTC_TIMESTAMP(3)
        WHERE eventId = ${eventId} AND status = 'failed'`;
      if (count === 0) throw new AppError(404, "NOT_FOUND", "No failed deliveries for that event.");
      return { retried: count };
    }
  }
  return EventsAdminController;
}

class RelayLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap() {
    if (this.enabled) this.relay.start();
  }

  // Finish in-flight deliveries; anything unsent stays in the outbox (§11).
  onApplicationShutdown() {
    return this.relay.stop();
  }
}

@Module({})
export class EventsModule {
  static forRootAsync(options: {
    // Where the admin endpoints live, e.g. "admin/events/catalog".
    adminPath: string;
    // Serve POST /internal/events (the service consumes events).
    receive: boolean;
    imports?: ModuleMetadata["imports"];
    inject?: unknown[];
    useFactory: (...deps: never[]) => EventsOptions;
  }): DynamicModule {
    return {
      module: EventsModule,
      global: true,
      imports: options.imports ?? [],
      controllers: [adminController(options.adminPath), ...(options.receive ? [InboxController] : [])],
      providers: [
        {
          provide: OPTIONS,
          inject: (options.inject ?? []) as never[],
          useFactory: options.useFactory as (...args: unknown[]) => EventsOptions,
        },
        { provide: Outbox, inject: [OPTIONS], useFactory: (o: EventsOptions) => new Outbox(o) },
        { provide: OutboxRelay, inject: [OPTIONS], useFactory: (o: EventsOptions) => new OutboxRelay(o.db, o, o.logger) },
        {
          provide: RelayLifecycle,
          inject: [OutboxRelay, OPTIONS],
          useFactory: (relay: OutboxRelay, o: EventsOptions) => new RelayLifecycle(relay, o.relay ?? true),
        },
      ],
      exports: [Outbox, OutboxRelay],
    };
  }
}
