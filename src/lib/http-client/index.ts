import { signServiceToken } from "../auth-guard/index.js";

// Calls from one service to another (§7): a timeout on every call, retries
// only when repeating is safe, a circuit breaker per dependency, and the
// request ID passed along so one checkout can be followed through the logs.

export interface HttpClientOptions {
  // The dependency's name, used for the breaker, logs and the token audience.
  target: string;
  baseUrl?: string;
  timeoutMs?: number;
  // Extra attempts for GETs and requests with an Idempotency-Key.
  retries?: number;
  // Open the breaker after this many failures in a row, for resetMs.
  breakerFailures?: number;
  breakerResetMs?: number;
  // Signs a service token for every call when set.
  serviceToken?: { secret: string; from: string };
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  requestId?: string;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export class UpstreamError extends Error {
  constructor(
    readonly target: string,
    readonly reason: "timeout" | "network" | "circuit_open" | "status",
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(`${target}: ${reason}${status ? ` ${status}` : ""}`);
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // While open every call fails at once. After resetMs one call is let
  // through (half-open); its result closes or reopens the breaker.
  allow() {
    if (this.failures < this.threshold) return true;
    if (this.now() < this.openUntil) return false;
    this.openUntil = this.now() + this.resetMs;
    return true;
  }

  success() {
    this.failures = 0;
    this.openUntil = 0;
  }

  failure() {
    this.failures++;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.resetMs;
  }

  get open() {
    return this.failures >= this.threshold && this.now() < this.openUntil;
  }
}

export class HttpClient {
  readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly options: HttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.retries = options.retries ?? 2;
    this.breaker = new CircuitBreaker(options.breakerFailures ?? 5, options.breakerResetMs ?? 30_000);
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, { ...options, body });
  }

  // Resolves for any HTTP status below 500; the caller decides what a 4xx
  // means. Throws UpstreamError for timeouts, network errors, 5xx and an
  // open breaker.
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const safeToRepeat = method === "GET" || method === "HEAD" || !!options.idempotencyKey;
    const attempts = safeToRepeat ? this.retries + 1 : 1;
    let lastError: UpstreamError | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(100 * 2 ** attempt + Math.random() * 100);
      if (!this.breaker.allow()) throw new UpstreamError(this.options.target, "circuit_open");
      try {
        const res = await this.send<T>(method, path, options);
        this.breaker.success();
        return res;
      } catch (err) {
        lastError = err as UpstreamError;
        this.breaker.failure();
        const retryable = lastError.reason !== "status" || RETRYABLE_STATUS.has(lastError.status ?? 0);
        if (!retryable) break;
      }
    }
    throw lastError!;
  }

  private async send<T>(method: string, path: string, options: RequestOptions): Promise<HttpResponse<T>> {
    const url = this.options.baseUrl ? new URL(path, this.options.baseUrl).toString() : path;
    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.requestId) headers["x-request-id"] = options.requestId;
    if (this.options.serviceToken) {
      const { secret, from } = this.options.serviceToken;
      headers.Authorization = `Bearer ${await signServiceToken(secret, from, this.options.target)}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      throw new UpstreamError(this.options.target, timedOut ? "timeout" : "network");
    }

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON; keep the text
    }
    if (res.status >= 500) throw new UpstreamError(this.options.target, "status", res.status, data);
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
