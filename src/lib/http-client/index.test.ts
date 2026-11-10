import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyServiceToken } from "../auth-guard/index.js";
import { CircuitBreaker, HttpClient, UpstreamError } from "./index.js";

describe("CircuitBreaker", () => {
  it("opens after N failures, then lets one trial call through after the reset time", () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    breaker.failure();
    expect(breaker.allow()).toBe(true);
    breaker.failure();
    expect(breaker.allow()).toBe(false);
    now = 1000;
    expect(breaker.allow()).toBe(true); // half-open trial
    expect(breaker.allow()).toBe(false); // only one
    breaker.success();
    expect(breaker.allow()).toBe(true);
  });
});

describe("HttpClient", () => {
  let server: Server;
  let base: string;
  const hits = new Map<string, number>();
  let lastAuth: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
      lastAuth = req.headers.authorization;
      if (req.url === "/flaky" && hits.get("/flaky")! < 3) return void res.writeHead(503).end();
      if (req.url === "/down") return void res.writeHead(503).end();
      if (req.url === "/slow") return void setTimeout(() => res.end("{}"), 500);
      res.writeHead(req.url === "/missing" ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url, id: req.headers["x-request-id"] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("retries a GET on 503 and passes the request ID", async () => {
    const client = new HttpClient({ target: "test", baseUrl: base, retries: 2 });
    const res = await client.get<{ id: string }>("/flaky", { requestId: "req-1" });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe("req-1");
    expect(hits.get("/flaky")).toBe(3);
  });

  it("never repeats a POST without an idempotency key", async () => {
    const client = new HttpClient({ target: "test", baseUrl: base, retries: 2 });
    await expect(client.post("/down", {})).rejects.toMatchObject({ reason: "status", status: 503 });
    expect(hits.get("/down")).toBe(1);
  });

  it("returns 4xx answers to the caller and times out slow ones", async () => {
    const client = new HttpClient({ target: "test", baseUrl: base, timeoutMs: 100, retries: 0 });
    expect((await client.get("/missing")).status).toBe(404);
    await expect(client.get("/slow")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("signs a service token addressed to the target", async () => {
    const secret = "s".repeat(40);
    const client = new HttpClient({ target: "inventory-service", baseUrl: base, serviceToken: { secret, from: "catalog-service" } });
    await client.get("/ok");
    const token = lastAuth!.replace("Bearer ", "");
    await expect(verifyServiceToken(token, secret, "inventory-service")).resolves.toEqual({ service: "catalog-service" });
  });
});
