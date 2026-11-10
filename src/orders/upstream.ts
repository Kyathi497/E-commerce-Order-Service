import { HttpException, Injectable } from "@nestjs/common";
import { config, SERVICE_NAME } from "../config.js";
import { AppError } from "../lib/common/index.js";
import { HttpClient } from "../lib/http-client/index.js";
import { logger } from "../logger.js";
import type { CartLine, CatalogLine, Evaluation, Quote } from "./pricing.js";

const client = (target: string, baseUrl: string, timeoutMs = 2000) =>
  new HttpClient({ target, baseUrl, timeoutMs, serviceToken: { secret: config.SERVICE_TOKEN_SECRET, from: SERVICE_NAME } });

export interface StoredCart {
  id: string;
  lines: CartLine[];
  couponCode: string | null;
  pincode: string | null;
}

export interface Address {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface EvalRequest {
  lines: { key: string; productId: string | null; categoryId: string | null; bundleId: string | null; qty: number; lineTotalPaise: number }[];
  shippingPaise: number;
  couponCode?: string;
  userId?: string;
  email?: string;
  previousOrders?: number;
}

export interface PaymentAnswer {
  payment: {
    id: string;
    provider: "razorpay" | "test" | "cod";
    providerOrderId: string | null;
    status: string;
    amountPaise: number;
    currency: string;
  };
  checkout: { mode: "live" | "test"; keyId: string | null; razorpayOrderId: string } | null;
}

export interface Shortage {
  kind: string;
  refId: string;
  name: string | null;
  requested: number;
  available: number;
}

export class StockShortError extends Error {
  constructor(readonly short: Shortage[]) {
    super("stock short");
  }
}

const unavailable = (what: string) =>
  new AppError(503, "CHECKOUT_UNAVAILABLE", `We couldn't ${what} just now. Nothing was charged; please try again in a minute.`);

// The services the checkout saga calls (§6.7, §7). Each answer is checked
// here, so checkout.service.ts only sees well-formed results or AppErrors.
@Injectable()
export class Upstream {
  private readonly auth = client("auth-service", config.AUTH_URL);
  private readonly cart = client("cart-service", config.CART_URL);
  private readonly catalog = client("catalog-service", config.CATALOG_URL);
  private readonly inventory = client("inventory-service", config.INVENTORY_URL, 5000);
  private readonly promotion = client("promotion-service", config.PROMOTION_URL, 5000);
  private readonly shipping = client("shipping-service", config.SHIPPING_URL);
  // payment-service waits on Razorpay (5 s) itself.
  private readonly payment = client("payment-service", config.PAYMENT_URL, 8000);

  async findCart(who: { userId?: string; cartToken?: string }, requestId?: string): Promise<StoredCart | null> {
    try {
      const res = await this.cart.post<{ cart: StoredCart | null }>("/internal/carts/lookup", who, { requestId });
      if (res.status !== 200) throw new Error(`cart lookup answered ${res.status}`);
      return res.data.cart;
    } catch (err) {
      logger.error({ err, requestId }, "cart lookup failed");
      throw unavailable("load your cart");
    }
  }

  // After the order is confirmed: what was bought leaves the cart.
  async removeOrdered(cartId: string, body: { placedAt: string; couponCode: string | null; lines: CartLine[] }, requestId?: string) {
    const res = await this.cart.post(`/internal/carts/${encodeURIComponent(cartId)}/remove-ordered`, body, { requestId, idempotencyKey: cartId });
    if (res.status !== 200 && res.status !== 404) throw new Error(`remove-ordered answered ${res.status}`);
  }

  async user(userId: string, requestId?: string) {
    try {
      const res = await this.auth.get<{ user: { id: string; email: string; name: string; phone: string | null; status: string } }>(
        `/internal/users/${encodeURIComponent(userId)}`,
        { requestId },
      );
      if (res.status === 404) throw new AppError(401, "UNAUTHENTICATED", "Please log in to continue.");
      if (res.status !== 200) throw new Error(`user answered ${res.status}`);
      return res.data.user;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error({ err, requestId }, "user lookup failed");
      throw unavailable("load your account");
    }
  }

  async address(userId: string, addressId: string, requestId?: string): Promise<Address> {
    try {
      const res = await this.auth.get<{ address: Address }>(
        `/internal/users/${encodeURIComponent(userId)}/addresses/${encodeURIComponent(addressId)}`,
        { requestId },
      );
      if (res.status === 404) {
        throw new AppError(422, "ADDRESS_NOT_FOUND", "We couldn't find that address. Please choose another.", {
          addressId: "We couldn't find that address.",
        });
      }
      if (res.status !== 200) throw new Error(`address answered ${res.status}`);
      return res.data.address;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error({ err, requestId }, "address lookup failed");
      throw unavailable("load your saved address");
    }
  }

  async price(lines: CartLine[], requestId?: string): Promise<CatalogLine[]> {
    try {
      const res = await this.catalog.post<{ lines: CatalogLine[] }>(
        "/internal/price-lines",
        { lines: lines.map((l) => ({ type: l.kind === "product" ? "sku" : "bundle", ref: l.ref, qty: l.qty })) },
        { requestId },
      );
      if (res.status !== 200) throw new Error(`price-lines answered ${res.status}`);
      return res.data.lines;
    } catch (err) {
      logger.error({ err, requestId }, "catalog pricing failed");
      throw unavailable("load today's prices");
    }
  }

  // Null when shipping-service can't be reached: the flat rate is used (§7).
  async quote(body: { pincode: string; subtotalPaise: number; weightGrams: number; units: number }, requestId?: string): Promise<Quote | null> {
    try {
      const res = await this.shipping.post<Quote>("/internal/shipping/quote", body, { requestId });
      if (res.status !== 200) throw new Error(`quote answered ${res.status}`);
      return res.data;
    } catch (err) {
      logger.warn({ err, requestId }, "shipping quote failed; charging the fallback rate");
      return null;
    }
  }

  // Null when promotion-service can't be reached.
  async evaluate(body: EvalRequest, requestId?: string): Promise<Evaluation | null> {
    try {
      const res = await this.promotion.post<Evaluation>("/internal/promotions/evaluate", body, { requestId });
      if (res.status !== 200) throw new Error(`evaluate answered ${res.status}`);
      return res.data;
    } catch (err) {
      logger.warn({ err, requestId }, "promotion check failed");
      return null;
    }
  }

  // Holds one use of the coupon for this order (§6.6). Idempotent by orderId.
  async reserveCoupon(body: EvalRequest & { orderId: string; couponCode: string; phone: string }, requestId?: string) {
    let res;
    try {
      res = await this.promotion.post<{ redemption: { discountPaise: number }; evaluation: Evaluation | null } & { error?: string; code?: string }>(
        "/internal/redemptions",
        body,
        { requestId, idempotencyKey: body.orderId },
      );
    } catch (err) {
      logger.error({ err, requestId }, "coupon reservation failed");
      throw new AppError(503, "PROMOTIONS_UNAVAILABLE", "We couldn't check your coupon just now. Remove it to check out without it, or try again in a minute.");
    }
    if (res.status === 201 || res.status === 200) return res.data;
    if (res.status === 422 || res.status === 409) {
      const message = res.data.error ?? "This coupon can't be used on this order.";
      throw new HttpException({ error: message, code: res.data.code ?? "COUPON_NOT_APPLICABLE", fields: { coupon: message } }, 422);
    }
    logger.error({ status: res.status, data: res.data, requestId }, "coupon reservation refused");
    throw new AppError(503, "PROMOTIONS_UNAVAILABLE", "We couldn't check your coupon just now. Please try again in a minute.");
  }

  async releaseCoupon(orderId: string, requestId?: string) {
    const res = await this.promotion.post(`/internal/redemptions/${encodeURIComponent(orderId)}/release`, {}, { requestId, idempotencyKey: orderId });
    if (res.status !== 200 && res.status !== 404) throw new Error(`coupon release answered ${res.status}`);
  }

  // Holds stock while the customer pays (§6.4). Idempotent by key.
  async reserveStock(key: string, lines: { kind: "product"; refId: string; quantity: number }[], requestId?: string) {
    let res;
    try {
      res = await this.inventory.post<{ reservation: { id: string; status: string }; short?: Shortage[]; code?: string }>(
        "/internal/reservations",
        { orderId: key, lines },
        { requestId, idempotencyKey: key },
      );
    } catch (err) {
      logger.error({ err, requestId }, "stock reservation failed");
      throw unavailable("check stock");
    }
    if (res.status === 201 || res.status === 200) return res.data.reservation;
    if (res.status === 409 && res.data.code === "STOCK_SHORT") throw new StockShortError(res.data.short ?? []);
    logger.error({ status: res.status, data: res.data, requestId }, "stock reservation refused");
    throw unavailable("check stock");
  }

  async releaseStock(key: string, requestId?: string) {
    const res = await this.inventory.post<{ code?: string }>(`/internal/reservations/${encodeURIComponent(key)}/release`, {}, { requestId, idempotencyKey: key });
    // Already expired or released is fine.
    if (res.status !== 200 && res.status !== 404 && res.data?.code !== "RESERVATION_ENDED") {
      throw new Error(`stock release answered ${res.status}`);
    }
  }

  // Creates the Razorpay order (or a test one) for a prepaid order (§6.8). Idempotent by orderId.
  async createPayment(
    body: { orderId: string; orderNumber: string; amountPaise: number; customer: { name: string; email: string | null; phone: string } },
    requestId?: string,
  ): Promise<PaymentAnswer> {
    try {
      const res = await this.payment.post<PaymentAnswer>("/internal/payments", body, { requestId, idempotencyKey: body.orderId });
      if (res.status !== 200 && res.status !== 201) throw new Error(`create payment answered ${res.status}: ${JSON.stringify(res.data)}`);
      return res.data;
    } catch (err) {
      logger.error({ err, requestId, orderId: body.orderId }, "payment creation failed");
      throw new AppError(
        503,
        "PAYMENT_UNAVAILABLE",
        "We couldn't start the payment just now. Your items are held for 15 minutes; please try again in a minute.",
      );
    }
  }

  // The order's payment, for admin views. Null if payment-service can't be reached.
  async paymentFor(orderId: string, requestId?: string) {
    try {
      const res = await this.payment.get<{ payment: Record<string, unknown> }>(`/internal/payments/by-order/${encodeURIComponent(orderId)}`, { requestId });
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`payment answered ${res.status}`);
      return res.data.payment;
    } catch (err) {
      logger.warn({ err, requestId, orderId }, "payment lookup failed");
      return undefined;
    }
  }
}
