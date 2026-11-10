import type { EventHandlers } from "../lib/events/index.js";
import { logger } from "../logger.js";
import { type Lifecycle, lockOrder, type Tx } from "./lifecycle.js";
import { formatINR } from "./money.js";
import { StockShortError, type Upstream } from "./upstream.js";

// What a set of order items needs from stock, summed per product.
export function stockFor(items: { qty: number; components: unknown }[]) {
  const grams = new Map<string, number>();
  for (const item of items) {
    for (const c of item.components as { productId: string; grams: number }[]) {
      grams.set(c.productId, (grams.get(c.productId) ?? 0) + c.grams * item.qty);
    }
  }
  return [...grams.entries()].map(([refId, quantity]) => ({ kind: "product" as const, refId, quantity }));
}

// Events order-service acts on (§8). Delivery is at least once and maybe out
// of order, so each handler looks at the order's current state first (§8).
export function orderHandlers(lifecycle: Lifecycle, upstream: Upstream): EventHandlers<Tx> {
  return {
    // The webhook (or /verify, or reconciliation) saw the money arrive (§6.8).
    "payment.captured": async (tx, data, event) => {
      const requestId = event.correlationId ?? undefined;
      const order = await lockOrder(tx, { id: data.orderId });
      if (!order) {
        logger.error({ orderId: data.orderId, paymentId: data.paymentId }, "payment captured for an unknown order");
        return;
      }
      const how = data.method ? `${data.method} via ${data.provider}` : data.provider;

      if (order.status === "PENDING_PAYMENT") {
        await lifecycle.confirm(tx, order, { actor: "system", reason: `Paid ${formatINR(data.amountPaise)} (${how})`, requestId }, { paymentId: data.paymentId });
        return;
      }

      if (order.status === "CANCELLED") {
        // Late payment (§6.7): the order timed out while the customer was
        // paying. Hold the stock again; if it's still there, confirm.
        if (order.cancelReason === "payment_timeout") {
          const key = `${order.id}:late`;
          const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
          try {
            await upstream.reserveStock(key, stockFor(items), requestId);
            await lifecycle.note(tx, order.id, "The payment arrived after the order had timed out. The stock was still there, so the order is confirmed.");
            await lifecycle.confirm(
              tx,
              order,
              { actor: "system", reason: `Late payment of ${formatINR(data.amountPaise)} (${how})`, requestId },
              { paymentId: data.paymentId, reservationKey: key, cancelledAt: null, cancelReason: null },
            );
            return;
          } catch (err) {
            // Inventory down: throwing makes payment-service deliver this again.
            if (!(err instanceof StockShortError)) throw err;
            logger.warn({ orderId: order.id }, "late payment but stock ran out; refunding");
          }
        }
        // Money is never kept without an order: refund it in full.
        const refunding = await lifecycle.move(
          tx,
          order,
          "REFUND_PENDING",
          { actor: "system", reason: "Paid after the order was cancelled; refunding in full", requestId },
          { paymentId: data.paymentId },
        );
        await lifecycle.publishCancelled(tx, refunding, "paid_after_cancel", true, requestId);
        return;
      }

      // Already confirmed: a repeat from the webhook, /verify or reconciliation.
      if (!order.paymentId) await tx.order.update({ where: { id: order.id }, data: { paymentId: data.paymentId } });
    },

    // A failed attempt doesn't end the order: Razorpay lets the customer try
    // again on the same order until the stock hold runs out.
    "payment.failed": async (tx, data) => {
      const order = await tx.order.findUnique({ where: { id: data.orderId } });
      if (!order) return;
      await lifecycle.note(tx, order.id, `A payment attempt failed${data.reason ? `: ${data.reason}` : ""}.`);
    },

    "payment.refunded": async (tx, data, event) => {
      const order = await lockOrder(tx, { id: data.orderId });
      if (!order) return;
      await lifecycle.note(tx, order.id, `Refunded ${formatINR(data.amountPaise)} (${formatINR(data.totalRefundedPaise)} in total).`);
      if (data.fullyRefunded && order.status === "REFUND_PENDING") {
        await lifecycle.move(tx, order, "REFUNDED", { actor: "system", reason: "Refund completed", requestId: event.correlationId ?? undefined });
      }
    },

    // Someone paid a different amount than the order: never confirm it (§6.8).
    "payment.amount_mismatch": async (tx, data) => {
      logger.error(data, "payment amount does not match the order");
      await lifecycle.note(
        tx,
        data.orderId,
        `Payment amount mismatch: expected ${formatINR(data.expectedPaise)}, received ${formatINR(data.receivedPaise)}. The order was not confirmed; check it in Razorpay.`,
      );
    },

    // The 15-minute stock hold ran out before the money arrived (§6.4).
    "reservation.expired": async (tx, data, event) => {
      const order = await lockOrder(tx, { reservationKey: data.orderId });
      if (!order || order.status !== "PENDING_PAYMENT") return;
      await lifecycle.cancel(tx, order, { actor: "system", reason: "payment_timeout", requestId: event.correlationId ?? undefined });
    },
  };
}
