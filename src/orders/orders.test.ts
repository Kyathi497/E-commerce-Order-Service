import { describe, expect, it } from "vitest";
import { findState, gstBreakup, taxIncluded } from "./gst.js";
import { checkOrderLinkToken, formatOrderNumber, idempotencyHash, orderIdFrom, orderLinkToken } from "./ids.js";
import { type OkLine, priceOrder, stockNeeded } from "./pricing.js";
import { adminCanMove, canMove, STATUSES } from "./states.js";

describe("order states", () => {
  it("follows the happy path and refuses skipping payment", () => {
    const path = ["PENDING_PAYMENT", "CONFIRMED", "PREPARING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
    for (let i = 1; i < path.length; i++) expect(canMove(path[i - 1]!, path[i]!), `${path[i - 1]} → ${path[i]}`).toBe(true);
    expect(canMove("PENDING_PAYMENT", "PACKED")).toBe(false);
    expect(canMove("DELIVERED", "CANCELLED")).toBe(false);
    expect(canMove("SHIPPED", "CANCELLED")).toBe(false);
  });

  it("lets a timed-out order be revived by a late payment, or refunded", () => {
    expect(canMove("CANCELLED", "CONFIRMED")).toBe(true);
    expect(canMove("CANCELLED", "REFUND_PENDING")).toBe(true);
    expect(canMove("REFUNDED", "CONFIRMED")).toBe(false);
  });

  it("keeps money moves away from the admin's status button", () => {
    expect(adminCanMove("CONFIRMED", "PREPARING")).toBe(true);
    expect(adminCanMove("PACKED", "SHIPPED")).toBe(true);
    expect(adminCanMove("PENDING_PAYMENT", "CONFIRMED")).toBe(false);
    expect(adminCanMove("REFUND_PENDING", "REFUNDED")).toBe(false);
    // Cancelling has its own endpoint, which handles stock, coupon and refund.
    expect(STATUSES.some((s) => adminCanMove(s, "CANCELLED"))).toBe(false);
  });
});

describe("GST on tax-inclusive prices", () => {
  it("takes the tax back out of the price", () => {
    // ₹105 at 5% contains ₹5 of GST.
    expect(taxIncluded(10_500, 500)).toBe(500);
    expect(taxIncluded(11_800, 1800)).toBe(1800);
    expect(taxIncluded(10_000, 0)).toBe(0);
  });

  it("splits CGST + SGST inside Andhra Pradesh and IGST outside", () => {
    const lines = [{ amountPaise: 10_500, rateBp: 500 }];
    const inside = gstBreakup(lines, 0, "37", "37");
    expect(inside).toMatchObject({ taxPaise: 500, cgstPaise: 250, sgstPaise: 250, igstPaise: 0, intraState: true });
    const outside = gstBreakup(lines, 0, "33", "37");
    expect(outside).toMatchObject({ taxPaise: 500, cgstPaise: 0, sgstPaise: 0, igstPaise: 500, intraState: false });
  });

  it("taxes shipping at the highest rate in the order, and an odd paisa goes to SGST", () => {
    const b = gstBreakup(
      [
        { amountPaise: 10_500, rateBp: 500 },
        { amountPaise: 11_200, rateBp: 1200 },
      ],
      7000,
      "37",
      "37",
    );
    expect(b.shippingTaxPaise).toBe(taxIncluded(7000, 1200));
    expect(b.taxPaise).toBe(500 + 1200 + b.shippingTaxPaise);
    expect(b.cgstPaise + b.sgstPaise).toBe(b.taxPaise);
    expect(b.sgstPaise - b.cgstPaise).toBeLessThanOrEqual(1);
    expect(b.rates.map((r) => r.rateBp)).toEqual([500, 1200]);
  });

  it("knows states as people type them", () => {
    expect(findState("andhra pradesh")?.code).toBe("37");
    expect(findState("Tamil Nadu")?.code).toBe("33");
    expect(findState("Orissa")?.code).toBe("21");
    expect(findState("Atlantis")).toBeNull();
  });
});

describe("order ids, numbers and guest links", () => {
  it("derives the same UUID from the same shopper and key, and a different one otherwise", () => {
    const a = orderIdFrom(idempotencyHash("user:1", "key-12345678"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(orderIdFrom(idempotencyHash("user:1", "key-12345678"))).toBe(a);
    expect(orderIdFrom(idempotencyHash("user:2", "key-12345678"))).not.toBe(a);
  });

  it("formats order numbers", () => {
    expect(formatOrderNumber(2026, 123)).toBe("TEJ-26-000123");
    expect(formatOrderNumber(2027, 1_234_567)).toBe("TEJ-27-1234567");
  });

  it("accepts its own link token for the right order until it expires", () => {
    const secret = "x".repeat(32);
    const now = Date.UTC(2026, 9, 26);
    const token = orderLinkToken(secret, "TEJ-26-000001", 30, now);
    expect(checkOrderLinkToken(secret, "TEJ-26-000001", token, now)).toBe(true);
    expect(checkOrderLinkToken(secret, "TEJ-26-000002", token, now)).toBe(false);
    expect(checkOrderLinkToken("y".repeat(32), "TEJ-26-000001", token, now)).toBe(false);
    expect(checkOrderLinkToken(secret, "TEJ-26-000001", token, now + 31 * 24 * 3600 * 1000)).toBe(false);
    expect(checkOrderLinkToken(secret, "TEJ-26-000001", "garbage", now)).toBe(false);
  });
});

describe("pricing an order", () => {
  const turmeric = "11111111-1111-4111-8111-111111111111";
  const ginger = "22222222-2222-4222-8222-222222222222";
  const line = (over: Partial<OkLine>): OkLine => ({
    status: "ok",
    name: "Turmeric",
    detail: "1 kg",
    unitPaise: 50_000,
    mrpPaise: 50_000,
    lineTotalPaise: 50_000,
    gstRateBp: 500,
    hsnCode: "0910",
    productId: turmeric,
    categoryId: null,
    bundleId: null,
    components: [{ productId: turmeric, grams: 1000 }],
    ...over,
  });

  it("matches the cart's sums and puts each discount on its line", () => {
    const lines = [
      { kind: "product" as const, ref: "TURM-1KG", qty: 2 },
      { kind: "combo" as const, ref: "gift-hamper", qty: 1 },
    ];
    const catalog = [
      line({ lineTotalPaise: 100_000 }),
      line({
        name: "Gift hamper",
        lineTotalPaise: 80_000,
        unitPaise: 80_000,
        productId: null,
        bundleId: "33333333-3333-4333-8333-333333333333",
        components: [
          { productId: turmeric, grams: 180 },
          { productId: ginger, grams: 180 },
        ],
      }),
    ];
    const priced = priceOrder({
      lines,
      catalog,
      evaluation: {
        discountPaise: 18_000,
        shippingDiscountPaise: 7000,
        lines: [
          { key: "p:TURM-1KG", discountPaise: 10_000 },
          { key: "c:gift-hamper", discountPaise: 8000 },
        ],
        coupon: null,
      },
      shippingPaise: 7000,
      placeOfSupply: "37",
      storeState: "37",
    });
    expect(priced).toMatchObject({ subtotalPaise: 180_000, discountPaise: 18_000, shippingPaise: 0, shippingDiscountPaise: 7000, totalPaise: 162_000 });
    expect(priced.items.map((i) => [i.kind, i.lineTotalPaise])).toEqual([
      ["sku", 90_000],
      ["bundle", 72_000],
    ]);
    expect(priced.items.reduce((s, i) => s + i.lineTotalPaise, 0) + priced.shippingPaise).toBe(priced.totalPaise);

    expect(stockNeeded(lines, catalog)).toEqual([
      { kind: "product", refId: turmeric, quantity: 2180 },
      { kind: "product", refId: ginger, quantity: 180 },
    ]);
  });
});
