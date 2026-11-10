// End-to-end checks for Phase 4 (orders + payments) against the running
// stack (`docker compose up --build` in auth-service, api-gateway,
// catalog-service, inventory-service, cart-service, promotion-service,
// shipping-service, order-service and payment-service), then:  pnpm test:e2e
// Payments use payment-service's Razorpay keys (test keys) and its webhook
// secret: this suite signs webhooks itself, the way Razorpay would.
// GATEWAY_URL, AUTH_CONTAINER and RAZORPAY_WEBHOOK_SECRET override the defaults.
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Browser, eventually, GATEWAY, signedInAdmin, signedInUser } from "./helpers.js";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "dev-only-razorpay-webhook-secret";
const SKU = "TURM-1KG";

let admin: Browser;

beforeAll(async () => {
  admin = await signedInAdmin();
}, 60_000);

const phone = () => `9${randomInt(100_000_000, 999_999_999)}`;
const address = (over: Record<string, string> = {}) => ({
  name: "E2E Shopper",
  phone: phone(),
  line1: "12-3 Gandhi Road, Benz Circle",
  city: "Vijayawada",
  state: "Andhra Pradesh",
  pincode: "520010",
  ...over,
});

async function cartWith(b: Browser, sku = SKU, qty = 1) {
  const res = await b.call("POST", "/api/v1/cart/items", { kind: "product", sku, qty });
  expect(res.status).toBe(200);
  return res.data.cart;
}

function checkout(b: Browser, body: Record<string, unknown>, key: string | null = randomUUID()) {
  return b.call("POST", "/api/v1/checkout", body, key ? { "Idempotency-Key": key } : {});
}

// What Razorpay would POST for this order, signed with the webhook secret.
async function webhook(event: string, entity: Record<string, unknown>, eventId = `evt_${randomUUID().replaceAll("-", "")}`) {
  const body = JSON.stringify({ entity: "event", event, payload: { payment: { entity } }, created_at: Math.floor(Date.now() / 1000) });
  const res = await fetch(`${GATEWAY}/api/v1/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
      "X-Razorpay-Event-Id": eventId,
    },
    body,
  });
  return { status: res.status, data: await res.json() };
}

const captured = (razorpayOrderId: string, amount: number, id = `pay_e2e${randomUUID().replaceAll("-", "").slice(0, 10)}`) => ({
  id,
  entity: "payment",
  amount,
  currency: "INR",
  status: "captured",
  order_id: razorpayOrderId,
  method: "upi",
});

const orderOf = (b: Browser, number: string, token?: string) =>
  b.call("GET", `/api/v1/orders/${number}${token ? `?t=${encodeURIComponent(token)}` : ""}`);

const statusOf = async (number: string) => (await admin.call("GET", `/api/v1/admin/orders/${number}`)).data.order;

describe("prepaid checkout", () => {
  it("places a pending order, confirms it from the webhook exactly once, and clears the cart", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest, SKU, 2);
    const key = randomUUID();
    const body = { address: address(), email: "guest-e2e@example.com", paymentMethod: "prepaid", expectedTotalPaise: cart.totals.totalPaise };

    const placed = await checkout(guest, body, key);
    expect(placed.status).toBe(201);
    const { order, payment, viewToken } = placed.data;
    expect(order).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: "prepaid", totals: { totalPaise: cart.totals.totalPaise } });
    expect(order.number).toMatch(/^TEJ-\d{2}-\d{6}$/);
    expect(payment).toMatchObject({ razorpayOrderId: expect.stringMatching(/^order_/), amountPaise: cart.totals.totalPaise, currency: "INR" });

    // The same key again: the same order and the same Razorpay order, never a second one.
    const replay = await checkout(guest, body, key);
    expect(replay.data.order.number).toBe(order.number);
    expect(replay.data.payment.razorpayOrderId).toBe(payment.razorpayOrderId);

    // Stock is held while the customer pays.
    const detail = await statusOf(order.number);
    expect(detail.items[0]).toMatchObject({ ref: SKU, qty: 2, gstRateBp: expect.any(Number) });
    expect(detail.tax.cgstPaise + detail.tax.sgstPaise).toBe(detail.totals.taxPaise);
    expect(detail.tax.igstPaise).toBe(0);
    const held = await admin.call("GET", `/api/v1/admin/reservations?status=held`);
    expect(held.data.items.some((r: { orderId: string }) => r.orderId === detail.id)).toBe(true);

    // The guest sees it with the link token, nobody else does.
    expect((await orderOf(guest, order.number, viewToken)).status).toBe(200);
    expect((await orderOf(new Browser(), order.number)).status).toBe(404);
    expect((await orderOf(new Browser(), order.number, "1.forged")).status).toBe(404);

    // Razorpay reports the payment twice (it retries); both are accepted.
    const pay = captured(payment.razorpayOrderId, cart.totals.totalPaise);
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    expect(await webhook("payment.captured", pay, eventId)).toMatchObject({ status: 200, data: { status: "accepted" } });
    expect(await webhook("payment.captured", pay, eventId)).toMatchObject({ status: 200, data: { status: "duplicate" } });
    await webhook("order.paid", pay);

    const confirmed = await eventually(async () => {
      const o = await statusOf(order.number);
      return o.status === "CONFIRMED" && o;
    });
    expect(confirmed.history.filter((h: { to: string }) => h.to === "CONFIRMED")).toHaveLength(1);
    expect(confirmed.payment).toMatchObject({ status: "captured", providerPaymentId: pay.id, method: "upi" });

    // Stock committed, and the bought lines leave the cart.
    await eventually(async () => {
      const r = await admin.call("GET", `/api/v1/admin/reservations?status=committed`);
      return r.data.items.some((x: { orderId: string }) => x.orderId === detail.id);
    });
    await eventually(async () => (await guest.call("GET", "/api/v1/cart")).data.cart.lines.length === 0);
  }, 60_000);

  it("refuses a forged webhook and never confirms a wrong amount", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest);
    const placed = await checkout(guest, { address: address(), email: "guest-e2e@example.com", paymentMethod: "prepaid", expectedTotalPaise: cart.totals.totalPaise });
    const { order, payment } = placed.data;

    const forged = await fetch(`${GATEWAY}/api/v1/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": "0".repeat(64) },
      body: JSON.stringify({ event: "payment.captured", payload: { payment: { entity: captured(payment.razorpayOrderId, cart.totals.totalPaise) } } }),
    });
    expect(forged.status).toBe(400);

    await webhook("payment.captured", captured(payment.razorpayOrderId, 100));
    await eventually(async () => (await statusOf(order.number)).notes.some((n: { body: string }) => n.body.includes("mismatch")));
    expect((await statusOf(order.number)).status).toBe("PENDING_PAYMENT");
  }, 60_000);

  it("refunds a payment that arrives after the customer cancelled", async () => {
    const user = (await signedInUser()).browser;
    const cart = await cartWith(user);
    const placed = await checkout(user, { address: address(), paymentMethod: "prepaid", expectedTotalPaise: cart.totals.totalPaise });
    expect(placed.status).toBe(201);
    const { order, payment } = placed.data;

    // The owner can see it in their list; cancelling before paying needs no refund.
    expect((await user.call("GET", "/api/v1/orders")).data.items.map((o: { number: string }) => o.number)).toContain(order.number);
    const cancelled = await user.call("POST", `/api/v1/orders/${order.number}/cancel`, { reason: "Changed my mind" });
    expect(cancelled).toMatchObject({ status: 200, data: { order: { status: "CANCELLED" } } });

    // …then the money arrives anyway: it must go back (§6.7).
    await webhook("payment.captured", captured(payment.razorpayOrderId, cart.totals.totalPaise));
    const o = await eventually(async () => {
      const x = await statusOf(order.number);
      return x.status === "REFUND_PENDING" && x;
    });
    // payment-service has a refund under way for the full amount.
    await eventually(async () => {
      const p = (await admin.call("GET", `/api/v1/admin/payments/${o.payment.id}`)).data.payment;
      return p.refunds.length === 1 && p.refunds[0].amountPaise === cart.totals.totalPaise;
    });
  }, 60_000);
});

describe("checkout safety", () => {
  it("needs an Idempotency-Key and the total the shopper saw", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest);
    const body = { address: address(), email: "guest-e2e@example.com", paymentMethod: "prepaid", expectedTotalPaise: cart.totals.totalPaise };
    expect((await checkout(guest, body, null)).data.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const changed = await checkout(guest, { ...body, expectedTotalPaise: cart.totals.totalPaise - 100 });
    expect(changed).toMatchObject({ status: 409, data: { code: "TOTAL_CHANGED", totalPaise: cart.totals.totalPaise } });
  });

  it("explains bad addresses, missing email and an empty cart", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest);
    const base = { paymentMethod: "prepaid", expectedTotalPaise: cart.totals.totalPaise };
    expect((await checkout(guest, { ...base, address: address() })).data.fields).toHaveProperty("email");
    expect((await checkout(guest, { ...base, email: "a@example.com", address: address({ state: "Atlantis" }) })).data.fields).toHaveProperty("address.state");
    expect((await checkout(guest, { ...base, email: "a@example.com", address: address({ pincode: "999999" }) })).data.code).toBe("NOT_DELIVERABLE");
    expect((await checkout(new Browser(), { ...base, email: "a@example.com", address: address() })).data.code).toBe("CART_EMPTY");
  });

  it("taxes a delivery outside Andhra Pradesh as IGST", async () => {
    const guest = new Browser();
    await cartWith(guest);
    // Shipping depends on the PIN code, so price the cart for it first.
    const cart = (await guest.call("PUT", "/api/v1/cart/pincode", { pincode: "600001" })).data.cart;
    const placed = await checkout(guest, {
      address: address({ city: "Chennai", state: "Tamil Nadu", pincode: "600001" }),
      email: "guest-e2e@example.com",
      paymentMethod: "prepaid",
      expectedTotalPaise: cart.totals.totalPaise,
    });
    expect(placed.status).toBe(201);
    const o = await statusOf(placed.data.order.number);
    expect(o).toMatchObject({ placeOfSupply: "33", tax: { cgstPaise: 0, sgstPaise: 0, igstPaise: o.totals.taxPaise } });
  });
});

describe("cash on delivery", () => {
  it("confirms straight away, allows one open COD order per phone, and restocks on cancel", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest);
    const where = address();
    const placed = await checkout(guest, { address: where, email: "cod-e2e@example.com", paymentMethod: "cod", expectedTotalPaise: cart.totals.totalPaise });
    expect(placed.status).toBe(201);
    expect(placed.data).toMatchObject({ order: { status: "CONFIRMED", paymentMethod: "cod" }, payment: null });
    const number = placed.data.order.number;

    // A second COD order for the same phone is refused while the first is open.
    const again = new Browser();
    const cart2 = await cartWith(again);
    const second = await checkout(again, { address: where, email: "cod-e2e@example.com", paymentMethod: "cod", expectedTotalPaise: cart2.totals.totalPaise });
    expect(second).toMatchObject({ status: 422, data: { code: "COD_UNAVAILABLE" } });

    // payment-service records the cash to collect.
    const o = await eventually(async () => {
      const x = await statusOf(number);
      return x.payment?.provider === "cod" && x;
    });
    expect(o.payment).toMatchObject({ status: "created", amountPaise: cart.totals.totalPaise });

    // Admin moves it along, then the guest cancels before it's packed: stock goes back.
    const prepared = await admin.call("POST", `/api/v1/admin/orders/${number}/status`, { status: "PREPARING", version: o.version });
    expect(prepared.data.order.status).toBe("PREPARING");
    expect((await admin.call("POST", `/api/v1/admin/orders/${number}/status`, { status: "DELIVERED", version: prepared.data.order.version })).status).toBe(409);
    await eventually(async () => {
      const r = await admin.call("GET", `/api/v1/admin/reservations?status=committed`);
      return r.data.items.some((x: { orderId: string }) => x.orderId === o.id);
    });
    const cancelled = await guest.call("POST", `/api/v1/orders/${number}/cancel?t=${encodeURIComponent(placed.data.viewToken)}`, {});
    expect(cancelled.data.order.status).toBe("CANCELLED");
    await eventually(async () => {
      const r = await admin.call("GET", `/api/v1/admin/reservations?status=released`);
      return r.data.items.some((x: { orderId: string }) => x.orderId === o.id);
    });
  }, 60_000);

  it("refuses COD above the limit", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest, SKU, 10);
    expect(cart.totals.totalPaise).toBeGreaterThan(200_000);
    const res = await checkout(guest, { address: address(), email: "cod-e2e@example.com", paymentMethod: "cod", expectedTotalPaise: cart.totals.totalPaise });
    expect(res).toMatchObject({ status: 422, data: { code: "COD_UNAVAILABLE" } });
  });
});

describe("tracking and admin", () => {
  it("lets a guest track with number + phone, and admins search and export", async () => {
    const guest = new Browser();
    const cart = await cartWith(guest);
    const where = address();
    const placed = await checkout(guest, { address: where, email: "track-e2e@example.com", paymentMethod: "cod", expectedTotalPaise: cart.totals.totalPaise });
    const number = placed.data.order.number;

    const tracked = await new Browser().call("POST", "/api/v1/orders/track", { orderNumber: number.toLowerCase(), phone: where.phone });
    expect(tracked.data.order).toMatchObject({ number, status: "CONFIRMED" });
    expect(tracked.data.order).not.toHaveProperty("shippingAddress");
    expect((await new Browser().call("POST", "/api/v1/orders/track", { orderNumber: number, phone: phone() })).status).toBe(404);

    const found = await admin.call("GET", `/api/v1/admin/orders?q=${where.phone}`);
    expect(found.data.items.map((o: { number: string }) => o.number)).toEqual([number]);
    const csv = await admin.call("GET", `/api/v1/admin/orders/export.csv?q=${number}`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.data)).toContain(number);

    // Shoppers never reach admin.
    expect((await (await signedInUser()).browser.call("GET", "/api/v1/admin/orders")).status).toBe(403);
  });
});
