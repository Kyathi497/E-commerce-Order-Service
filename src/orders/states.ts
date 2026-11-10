// The order state machine (§6.7), in one place. Anything not listed here is
// an illegal move and answers 409.
//
//  PENDING_PAYMENT ──paid──▶ CONFIRMED ─▶ PREPARING ─▶ PACKED ─▶ SHIPPED ─▶ OUT_FOR_DELIVERY ─▶ DELIVERED
//        │  (cod starts at CONFIRMED)  │            │                 │                               │
//        └────────────▶ CANCELLED ◀───┴────────────┘                 └─▶ RTO       RETURN_REQUESTED ◀┘
//                          │  ▲ (late payment, stock re-reserved)                     │
//                          ▼  │                                                       ▼
//                    REFUND_PENDING ─▶ REFUNDED                                    RETURNED ─▶ REFUND_PENDING

export type Status =
  | "PENDING_PAYMENT"
  | "CONFIRMED"
  | "PREPARING"
  | "PACKED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "RETURN_REQUESTED"
  | "RETURNED"
  | "RTO";

const MOVES: Record<Status, Status[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PREPARING", "PACKED", "CANCELLED"],
  PREPARING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED", "RTO"],
  OUT_FOR_DELIVERY: ["DELIVERED", "RTO"],
  DELIVERED: ["RETURN_REQUESTED"],
  // A payment that arrives after the order timed out revives it (§6.7 late
  // payment), or is refunded.
  CANCELLED: ["CONFIRMED", "REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED"],
  REFUNDED: [],
  RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
  RETURNED: ["REFUND_PENDING"],
  RTO: ["REFUND_PENDING"],
};

export const canMove = (from: Status, to: Status) => MOVES[from].includes(to);

export const STATUSES = Object.keys(MOVES) as Status[];

// Moves only the system makes, never the owner by hand: payment, refunds and
// the late-payment revival follow money, which only payment-service knows.
const SYSTEM_ONLY: [Status, Status][] = [
  ["PENDING_PAYMENT", "CONFIRMED"],
  ["CANCELLED", "CONFIRMED"],
  ["CANCELLED", "REFUND_PENDING"],
  ["REFUND_PENDING", "REFUNDED"],
  ["RETURNED", "REFUND_PENDING"],
  ["RTO", "REFUND_PENDING"],
];

export const adminCanMove = (from: Status, to: Status) =>
  canMove(from, to) && to !== "CANCELLED" && !SYSTEM_ONLY.some(([a, b]) => a === from && b === to);

// The customer can cancel until the order is packed (§6.7).
export const CUSTOMER_CANCELLABLE: Status[] = ["PENDING_PAYMENT", "CONFIRMED", "PREPARING"];
export const ADMIN_CANCELLABLE: Status[] = ["PENDING_PAYMENT", "CONFIRMED", "PREPARING", "PACKED"];

// Still on its way to the customer: counts towards the open-COD limit.
export const OPEN: Status[] = ["PENDING_PAYMENT", "CONFIRMED", "PREPARING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY"];

// Placed and paid for (or COD): counts as a previous order for first-order offers.
export const PLACED: Status[] = [
  "CONFIRMED",
  "PREPARING",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURN_REQUESTED",
  "RETURNED",
];

// What the customer sees, in their words.
export const CUSTOMER_LABEL: Record<Status, string> = {
  PENDING_PAYMENT: "Waiting for payment",
  CONFIRMED: "Confirmed",
  PREPARING: "Being prepared",
  PACKED: "Packed",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  REFUND_PENDING: "Refund in progress",
  REFUNDED: "Refunded",
  RETURN_REQUESTED: "Return requested",
  RETURNED: "Returned",
  RTO: "Returned to us",
};
