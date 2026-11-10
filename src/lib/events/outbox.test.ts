import { describe, expect, it } from "vitest";
import { nextAttempt, Outbox } from "./outbox.js";

describe("nextAttempt", () => {
  const delays = [10, 60, 600, 3600];

  it("follows the schedule, then repeats the last delay", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => nextAttempt(n, delays, 86_400).delaySeconds)).toEqual([10, 60, 600, 3600, 3600, 3600]);
  });

  it("gives up once about a day of waiting has passed", () => {
    // 10 + 60 + 600 = 670 s, then hourly: the 28th failure comes after 24 h of waiting.
    expect(nextAttempt(27, delays, 86_400).giveUp).toBe(false);
    expect(nextAttempt(28, delays, 86_400).giveUp).toBe(true);
  });
});

describe("Outbox", () => {
  it("writes one delivery per consumer that is running", async () => {
    const statements: string[] = [];
    const tx = {
      $executeRaw: async (q: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(q.join("?").replace(/\s+/g, " ").trim() + " | " + JSON.stringify(values));
        return 1;
      },
      $queryRaw: async () => [] as never,
    };
    const outbox = new Outbox({
      source: "catalog-service",
      consumers: { "inventory-service": "http://inventory/internal/events", frontend: undefined },
      routes: { "product.created": ["inventory-service", "frontend"] },
      serviceTokenSecret: "x".repeat(32),
    });
    const productId = "0b6a3c55-5a52-4a8e-9a43-5f3b8ac3a8d1";
    await outbox.publish(tx, "product.created", { productId, slug: "turmeric", name: "Turmeric", status: "active" });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("INSERT INTO OutboxEvent");
    expect(statements[1]).toContain('"inventory-service"');
  });

  it("refuses data that doesn't match the event's contract", async () => {
    const outbox = new Outbox({ source: "x", consumers: {}, routes: {}, serviceTokenSecret: "x".repeat(32) });
    const tx = { $executeRaw: async () => 1, $queryRaw: async () => [] as never };
    await expect(outbox.publish(tx, "product.created", { productId: "not-a-uuid" } as never)).rejects.toThrow();
  });
});
