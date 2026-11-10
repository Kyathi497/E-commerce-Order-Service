import { z } from "zod";

// Event contracts shared by every service (§8). Each service keeps its own
// copy: when an event changes, bump its version and update every copy.

export const envelope = z.object({
  id: z.uuid(),
  type: z.string().min(1).max(64),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  source: z.string().min(1).max(64),
  correlationId: z.string().max(128).nullish(),
  data: z.unknown(),
});

export type Envelope<D = unknown> = Omit<z.infer<typeof envelope>, "data"> & { data: D };

const product = z.object({
  productId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["draft", "active", "archived"]),
});

const stockLevel = z.object({
  stockItemId: z.uuid(),
  kind: z.enum(["product", "packaging"]),
  refId: z.string(),
  name: z.string(),
  available: z.number().int(),
  threshold: z.number().int(),
});

const paymentMethod = z.enum(["prepaid", "cod"]);

const orderRef = z.object({
  orderId: z.uuid(),
  orderNumber: z.string(),
});

export const EVENTS = {
  "product.created": { version: 1, data: product },
  "product.updated": { version: 1, data: product },
  "product.archived": { version: 1, data: product },
  "price.changed": {
    version: 1,
    data: z.object({
      productId: z.uuid().nullable(),
      skuId: z.uuid().nullable(),
      bundleId: z.uuid().nullable(),
      oldPaise: z.number().int(),
      newPaise: z.number().int(),
    }),
  },
  "bundle.updated": {
    version: 1,
    data: z.object({ bundleId: z.uuid(), slug: z.string(), status: z.enum(["draft", "active", "archived"]) }),
  },
  "category.updated": { version: 1, data: z.object({ categoryId: z.uuid(), slug: z.string() }) },
  "stock.low": { version: 1, data: stockLevel },
  "stock.out": { version: 1, data: stockLevel },
  "stock.restocked": { version: 1, data: stockLevel },
  "reservation.expired": { version: 1, data: z.object({ reservationId: z.uuid(), orderId: z.string() }) },

  // Order events (§6.7). `reservationKey` is the orderId inventory holds the
  // stock under: the order id, or a new key when a late payment re-reserves.
  "order.created": {
    version: 1,
    data: orderRef.extend({ paymentMethod, totalPaise: z.number().int(), userId: z.string().nullable() }),
  },
  "order.confirmed": {
    version: 1,
    data: orderRef.extend({
      paymentMethod,
      totalPaise: z.number().int(),
      reservationKey: z.string(),
      couponCode: z.string().nullable(),
      userId: z.string().nullable(),
      email: z.string().nullable(),
    }),
  },
  "order.cancelled": {
    version: 1,
    data: orderRef.extend({
      paymentMethod,
      reservationKey: z.string(),
      couponCode: z.string().nullable(),
      reason: z.string(),
      // The customer paid and gets their money back (payment-service refunds it).
      refund: z.boolean(),
    }),
  },
  "order.status_changed": {
    version: 1,
    data: orderRef.extend({ from: z.string().nullable(), to: z.string(), reason: z.string().nullable() }),
  },

  // Payment events (§6.8).
  "payment.captured": {
    version: 1,
    data: z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      provider: z.enum(["razorpay", "test", "cod"]),
      providerPaymentId: z.string().nullable(),
      amountPaise: z.number().int(),
      method: z.string().nullable(),
    }),
  },
  "payment.failed": {
    version: 1,
    data: z.object({ paymentId: z.uuid(), orderId: z.uuid(), reason: z.string().nullable() }),
  },
  "payment.refunded": {
    version: 1,
    data: z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      refundId: z.uuid(),
      amountPaise: z.number().int(),
      totalRefundedPaise: z.number().int(),
      fullyRefunded: z.boolean(),
    }),
  },
  "payment.amount_mismatch": {
    version: 1,
    data: z.object({ paymentId: z.uuid(), orderId: z.uuid(), expectedPaise: z.number().int(), receivedPaise: z.number().int() }),
  },
} as const;

export type EventType = keyof typeof EVENTS;
export type EventData<T extends EventType> = z.infer<(typeof EVENTS)[T]["data"]>;

export const isEventType = (type: string): type is EventType => Object.hasOwn(EVENTS, type);
