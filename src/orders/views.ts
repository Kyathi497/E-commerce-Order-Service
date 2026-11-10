import type { Order, OrderItem, OrderNote, OrderStatusHistory } from "../generated/prisma/client.js";
import { CUSTOMER_CANCELLABLE, CUSTOMER_LABEL, type Status } from "./states.js";

const totals = (o: Order) => ({
  subtotalPaise: o.subtotalPaise,
  discountPaise: o.discountPaise,
  shippingPaise: o.shippingPaise,
  shippingDiscountPaise: o.shippingDiscountPaise,
  taxPaise: o.taxPaise,
  totalPaise: o.totalPaise,
});

const itemView = (i: OrderItem) => ({
  kind: i.kind,
  ref: i.ref,
  name: i.name,
  detail: i.detail,
  qty: i.qty,
  unitPaise: i.unitPaise,
  mrpPaise: i.mrpPaise,
  discountPaise: i.discountPaise,
  lineTotalPaise: i.lineTotalPaise,
});

// What the customer sees of their order.
export function customerView(o: Order & { items: OrderItem[]; history?: OrderStatusHistory[] }) {
  const status = o.status as Status;
  return {
    number: o.orderNumber,
    status,
    statusLabel: CUSTOMER_LABEL[status],
    paymentMethod: o.paymentMethod,
    placedAt: o.placedAt,
    confirmedAt: o.confirmedAt,
    cancelledAt: o.cancelledAt,
    currency: o.currency,
    totals: totals(o),
    couponCode: o.couponCode,
    items: [...o.items].sort((a, b) => a.position - b.position).map(itemView),
    shippingAddress: o.shippingAddress,
    contact: { name: o.contactName, phone: o.contactPhone, email: o.contactEmail },
    ...(o.history && {
      timeline: o.history
        .map((h) => ({ status: h.toStatus, label: CUSTOMER_LABEL[h.toStatus as Status], at: h.at }))
        .sort((a, b) => a.at.getTime() - b.at.getTime()),
    }),
    canCancel: CUSTOMER_CANCELLABLE.includes(status),
  };
}

// One row of a list.
export function summaryView(o: Order & { items: OrderItem[] }) {
  const status = o.status as Status;
  return {
    number: o.orderNumber,
    status,
    statusLabel: CUSTOMER_LABEL[status],
    paymentMethod: o.paymentMethod,
    placedAt: o.placedAt,
    totalPaise: o.totalPaise,
    itemCount: o.items.reduce((n, i) => n + i.qty, 0),
    items: o.items.map((i) => `${i.qty}× ${i.name} (${i.detail})`),
  };
}

export function adminSummaryView(o: Order & { items: OrderItem[] }) {
  const address = o.shippingAddress as { city?: string; pincode?: string };
  return {
    ...summaryView(o),
    id: o.id,
    contact: { name: o.contactName, phone: o.contactPhone, email: o.contactEmail },
    city: address.city ?? null,
    pincode: address.pincode ?? null,
    couponCode: o.couponCode,
  };
}

// Everything, for the owner (§6.7 admin order detail).
export function adminView(
  o: Order & { items: OrderItem[]; history: OrderStatusHistory[]; notes: OrderNote[] },
  payment: Record<string, unknown> | null | undefined,
) {
  return {
    id: o.id,
    number: o.orderNumber,
    status: o.status,
    version: o.version,
    paymentMethod: o.paymentMethod,
    userId: o.userId,
    contact: { name: o.contactName, phone: o.contactPhone, email: o.contactEmail },
    placedAt: o.placedAt,
    confirmedAt: o.confirmedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    currency: o.currency,
    totals: totals(o),
    tax: o.taxBreakup,
    placeOfSupply: o.placeOfSupply,
    couponCode: o.couponCode,
    shippingAddress: o.shippingAddress,
    billingAddress: o.billingAddress,
    customerNote: o.customerNote,
    reservationKey: o.reservationKey,
    items: [...o.items]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ ...itemView(i), refId: i.refId, hsnCode: i.hsnCode, gstRateBp: i.gstRateBp, taxPaise: i.taxPaise, components: i.components })),
    history: [...o.history]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((h) => ({ from: h.fromStatus, to: h.toStatus, actor: h.actor, reason: h.reason, at: h.at })),
    notes: [...o.notes].sort((a, b) => a.at.getTime() - b.at.getTime()).map((n) => ({ kind: n.kind, actorId: n.actorId, body: n.body, at: n.at })),
    // null: no payment yet (COD before collection); undefined: payment-service unreachable.
    payment: payment === undefined ? { unavailable: true } : payment,
  };
}
