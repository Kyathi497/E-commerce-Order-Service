# order-service

Orders and the checkout saga (plan §6.7). Port 4006, MySQL on host port 3313.

## Run

```sh
docker network create tej-net   # once per machine
docker compose up --build       # service + MySQL (3313)
```

Checkout calls auth, cart, catalog, inventory, promotion, shipping and payment over `tej-net`, so start those too.
Hot reload: `docker compose up mysql`, then `pnpm install && pnpm dev` (uses `.env`, see `.env.example`).

## Checkout (`POST /api/v1/checkout`, needs `Idempotency-Key`)

1. Reads the shopper's cart from cart-service (by account, or the `tej_cart` cookie) and the account / saved
   address from auth-service. The browser only sends the address, `paymentMethod` and the total it showed.
2. Prices it again: catalog prices, shipping quote for the delivery PIN code, offers and coupon, GST.
   A different total from `expectedTotalPaise` answers `409 TOTAL_CHANGED`.
3. Holds the coupon use (promotion) and the stock (inventory), both keyed by the order id.
4. Saves the order with snapshots of items, prices, tax and address, plus `order.created`, in one transaction.
5. Prepaid: payment-service creates the Razorpay order and the answer carries what Razorpay Checkout needs.
   COD: limits checked (≤ ₹2,000, PIN code supports COD, one open COD order per phone), then straight to CONFIRMED.

A failure undoes the holds. The order id is derived from the shopper + Idempotency-Key, so a repeated or racing
request lands on the same order and never makes a second one.

## What moves an order

| Event in | Effect |
|---|---|
| `payment.captured` | PENDING_PAYMENT → CONFIRMED (`order.confirmed`: inventory commits, promotion confirms the coupon) |
| `payment.captured` on a timed-out order | stock held again → CONFIRMED; if it's gone → REFUND_PENDING + refund |
| `payment.captured` on a cancelled order | REFUND_PENDING, payment-service refunds in full |
| `payment.failed` | noted only; the customer can retry on the same Razorpay order |
| `payment.refunded` (full) | REFUND_PENDING → REFUNDED |
| `reservation.expired` | PENDING_PAYMENT → CANCELLED (`payment_timeout`) |

A sweeper also cancels anything still unpaid after `PENDING_TIMEOUT_MINUTES`, and removes bought lines from the
shopper's cart once an order is confirmed. Allowed status moves are in `src/orders/states.ts`.

## API

| Endpoint | |
|---|---|
| `POST /api/v1/checkout` | place an order (above) |
| `GET /api/v1/orders` | the signed-in shopper's orders |
| `GET /api/v1/orders/:number[?t=token]` | owner, or a guest with the link token from checkout |
| `POST /api/v1/orders/:number/cancel[?t=token]` | before it's packed |
| `POST /api/v1/orders/track` `{orderNumber, phone}` | guest tracking (rate-limited) |
| `GET /api/v1/admin/orders` `?status&paymentMethod&q&pincode&from&to` | list / search |
| `GET /api/v1/admin/orders/export.csv` | same filters |
| `GET /api/v1/admin/orders/:number` | full detail, history, notes, payment |
| `POST /api/v1/admin/orders/:number/status` `{status, version, reason?}` | move it along |
| `POST /api/v1/admin/orders/:number/cancel` `{reason, version}` | cancel (refunds a paid order) |
| `POST /api/v1/admin/orders/:number/notes` `{body}` | internal note |
| `GET /api/v1/admin/events/order/deliveries`, `POST …/:eventId/retry` | event deliveries |

GST: prices include tax; it's taken back out per line (CGST + SGST inside Andhra Pradesh, IGST outside), shipping at
the highest rate in the order. **Confirm HSN codes and rates with the CA before launch.**

## Commands

- `pnpm test`: unit tests · `pnpm test:e2e`: end-to-end (whole stack running)
- `pnpm migrate:dev` / `pnpm migrate:deploy`: Prisma migrations

## Shared code

`src/lib/common`, `auth-guard`, `http-client`, `events` and `contracts` are shared libraries copied into this
service. If you fix a bug in one, make the same fix in every other service that has a copy.
