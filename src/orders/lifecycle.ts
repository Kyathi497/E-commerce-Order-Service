import { Injectable } from "@nestjs/common";
import type { Order, Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/common/index.js";
import { Outbox } from "../lib/events/index.js";
import { canMove, type Status } from "./states.js";

export type Tx = Prisma.TransactionClient;

export interface Change {
  // system, customer, or admin:<user id>
  actor: string;
  reason?: string | null;
  requestId?: string;
}

const PAID_STATES: Status[] = ["CONFIRMED", "PREPARING", "PACKED"];

// Takes the order's row lock for the rest of the transaction, so two events
// about one order (a webhook and a timeout, say) are handled one at a time.
export async function lockOrder(tx: Tx, where: { id: string } | { orderNumber: string } | { reservationKey: string }) {
  if ("id" in where) await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${where.id} FOR UPDATE`;
  else if ("orderNumber" in where) await tx.$queryRaw`SELECT id FROM \`Order\` WHERE orderNumber = ${where.orderNumber} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM \`Order\` WHERE reservationKey = ${where.reservationKey} FOR UPDATE`;
  return tx.order.findUnique({ where });
}

// Every status change goes through here (§6.7): the state machine is
// checked, history is written and the events go out with the change.
@Injectable()
export class Lifecycle {
  constructor(private readonly outbox: Outbox) {}

  async move(tx: Tx, order: Order, to: Status, change: Change, data: Prisma.OrderUpdateManyMutationInput = {}) {
    const from = order.status as Status;
    if (!canMove(from, to)) {
      throw new AppError(409, "ILLEGAL_TRANSITION", `An order that is ${label(from)} can't be marked ${label(to)}.`);
    }
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: order.status, version: order.version },
      data: { ...data, status: to, version: { increment: 1 } },
    });
    if (count === 0) throw new AppError(409, "ORDER_CHANGED", "This order just changed. Please refresh and try again.");
    await tx.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: from, toStatus: to, actor: change.actor, reason: change.reason ?? null },
    });
    await this.outbox.publish(
      tx,
      "order.status_changed",
      { orderId: order.id, orderNumber: order.orderNumber, from, to, reason: change.reason ?? null },
      { correlationId: change.requestId },
    );
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  }

  // Paid (or COD placed): stock is committed, the coupon use confirmed, the
  // customer told (§6.7).
  async confirm(tx: Tx, order: Order, change: Change, data: Prisma.OrderUpdateManyMutationInput = {}) {
    const confirmed = await this.move(tx, order, "CONFIRMED", change, { confirmedAt: new Date(), ...data });
    await this.publishConfirmed(tx, confirmed, change.requestId);
    return confirmed;
  }

  async publishConfirmed(tx: Tx, order: Order, requestId?: string) {
    await this.outbox.publish(
      tx,
      "order.confirmed",
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentMethod: order.paymentMethod,
        totalPaise: order.totalPaise,
        reservationKey: order.reservationKey,
        couponCode: order.couponCode,
        userId: order.userId,
        email: order.contactEmail,
      },
      { correlationId: requestId },
    );
  }

  // Stock and coupon go back. A prepaid order that was paid moves on to
  // REFUND_PENDING and payment-service refunds it.
  async cancel(tx: Tx, order: Order, change: Change & { reason: string }) {
    const refund = order.paymentMethod === "prepaid" && PAID_STATES.includes(order.status as Status);
    let cancelled = await this.move(tx, order, "CANCELLED", change, { cancelledAt: new Date(), cancelReason: change.reason.slice(0, 64) });
    if (refund) cancelled = await this.move(tx, cancelled, "REFUND_PENDING", { ...change, reason: "Refund for a paid order" });
    await this.publishCancelled(tx, cancelled, change.reason, refund, change.requestId);
    return cancelled;
  }

  async publishCancelled(tx: Tx, order: Order, reason: string, refund: boolean, requestId?: string) {
    await this.outbox.publish(
      tx,
      "order.cancelled",
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentMethod: order.paymentMethod,
        reservationKey: order.reservationKey,
        couponCode: order.couponCode,
        reason,
        refund,
      },
      { correlationId: requestId },
    );
  }

  async note(tx: Tx, orderId: string, body: string, actorId: string | null = null, kind: "internal" | "system" = "system") {
    await tx.orderNote.create({ data: { orderId, kind, actorId, body: body.slice(0, 1000) } });
  }
}

const label = (s: Status) => s.toLowerCase().replaceAll("_", " ");
