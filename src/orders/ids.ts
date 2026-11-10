import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// The order id comes from the shopper and their Idempotency-Key (§9), so a
// retried checkout lands on the same id everywhere: inventory and promotion
// hold stock and coupons by it, and the order row's primary key refuses a
// second copy even when two retries race.
export function idempotencyHash(identity: string, key: string) {
  return createHash("sha256").update(`${identity}\n${key}`).digest("hex");
}

// A version-4-shaped UUID made from the hash.
export function orderIdFrom(hash: string) {
  const h = hash.slice(0, 32).split("");
  h[12] = "4";
  h[16] = "89ab"[parseInt(h[16]!, 16) & 3]!;
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// TEJ-26-000123: two-digit year, then the year's running count.
export const formatOrderNumber = (year: number, n: number) => `TEJ-${String(year % 100).padStart(2, "0")}-${String(n).padStart(6, "0")}`;

export const ORDER_NUMBER = /^TEJ-\d{2}-\d{6,}$/;

// A signed link that lets a guest see their own order (§6.7), e.g. on the
// confirmation page or from an email: <expiry>.<hmac(number|expiry)>.
export function orderLinkToken(secret: string, orderNumber: string, days: number, now = Date.now()) {
  const exp = Math.floor(now / 1000) + days * 24 * 3600;
  return `${exp.toString(36)}.${sign(secret, orderNumber, exp)}`;
}

export function checkOrderLinkToken(secret: string, orderNumber: string, token: string, now = Date.now()) {
  const m = /^([0-9a-z]{1,10})\.([\w-]{43})$/.exec(token);
  if (!m) return false;
  const exp = parseInt(m[1]!, 36);
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const a = Buffer.from(sign(secret, orderNumber, exp));
  const b = Buffer.from(m[2]!);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sign = (secret: string, orderNumber: string, exp: number) =>
  createHmac("sha256", secret).update(`${orderNumber}|${exp}`).digest("base64url");
