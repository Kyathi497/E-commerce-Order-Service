// Turns what catalog, promotion and shipping answered into the order's lines
// and totals (§6.7). No I/O: checkout.service.ts makes the calls. The sums
// match cart-service's, so the total the shopper saw is the total charged.
import { gstBreakup, type TaxBreakup } from "./gst.js";

export type CartKind = "product" | "combo";

export interface CartLine {
  kind: CartKind;
  ref: string;
  qty: number;
}

// catalog-service POST /internal/price-lines, one entry per line.
export type CatalogLine =
  | {
      status: "ok";
      name: string;
      detail: string;
      unitPaise: number;
      mrpPaise: number;
      lineTotalPaise: number;
      gstRateBp: number;
      hsnCode: string | null;
      productId: string | null;
      categoryId: string | null;
      bundleId: string | null;
      components: { productId: string; grams: number }[];
    }
  | { status: "not_found" | "unavailable" };

export type OkLine = Extract<CatalogLine, { status: "ok" }>;

// promotion-service POST /internal/promotions/evaluate.
export interface Evaluation {
  discountPaise: number;
  shippingDiscountPaise: number;
  lines: { key: string; discountPaise: number }[];
  coupon:
    | { code: string; applied: true; description: string | null; discountPaise: number; freeShipping: boolean }
    | { code: string; applied: false; reason: string; message: string }
    | null;
}

// shipping-service POST /internal/shipping/quote.
export interface Quote {
  shippingPaise: number;
  serviceability: {
    pincode: string;
    serviceable: boolean | null;
    codAvailable: boolean;
    minDays: number | null;
    maxDays: number | null;
    message: string;
  } | null;
}

// The cart's own line keys (p:<SKU>, c:<slug>), which promotions answer by.
export const lineKey = (l: { kind: CartKind; ref: string }) => (l.kind === "product" ? `p:${l.ref}` : `c:${l.ref}`);

// Grams of raw stock and the number of jars/boxes, for the parcel weight.
export function parcel(lines: CartLine[], catalog: OkLine[]) {
  let grams = 0;
  let units = 0;
  lines.forEach((l, i) => {
    grams += catalog[i]!.components.reduce((g, x) => g + x.grams, 0) * l.qty;
    units += l.qty;
  });
  return { grams, units };
}

// Raw stock to hold, summed per product: a 1 kg jar and a hamper's 180 g jar
// of turmeric both draw from the same turmeric (§6.4).
export function stockNeeded(lines: CartLine[], catalog: OkLine[]) {
  const grams = new Map<string, number>();
  lines.forEach((l, i) => {
    for (const c of catalog[i]!.components) grams.set(c.productId, (grams.get(c.productId) ?? 0) + c.grams * l.qty);
  });
  return [...grams.entries()].map(([refId, quantity]) => ({ kind: "product" as const, refId, quantity }));
}

export interface OrderItemDraft {
  kind: "sku" | "bundle";
  ref: string;
  refId: string | null;
  name: string;
  detail: string;
  hsnCode: string | null;
  gstRateBp: number;
  unitPaise: number;
  mrpPaise: number;
  qty: number;
  discountPaise: number;
  lineTotalPaise: number;
  taxPaise: number;
  components: { productId: string; grams: number }[];
  position: number;
}

export interface Priced {
  items: OrderItemDraft[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  shippingDiscountPaise: number;
  taxPaise: number;
  totalPaise: number;
  tax: TaxBreakup;
}

export function priceOrder(input: {
  lines: CartLine[];
  catalog: OkLine[];
  evaluation: Evaluation | null;
  // Before any free-shipping discount.
  shippingPaise: number;
  placeOfSupply: string;
  storeState: string;
}): Priced {
  const { lines, catalog, evaluation } = input;
  const discounts = new Map(evaluation?.lines.map((l) => [l.key, l.discountPaise]) ?? []);
  const drafts = lines.map((l, i) => {
    const c = catalog[i]!;
    const discountPaise = Math.min(discounts.get(lineKey(l)) ?? 0, c.lineTotalPaise);
    return {
      kind: l.kind === "product" ? ("sku" as const) : ("bundle" as const),
      ref: l.ref,
      refId: c.productId ?? c.bundleId,
      name: c.name,
      detail: c.detail,
      hsnCode: c.hsnCode,
      gstRateBp: c.gstRateBp,
      unitPaise: c.unitPaise,
      mrpPaise: c.mrpPaise,
      qty: l.qty,
      discountPaise,
      lineTotalPaise: c.lineTotalPaise - discountPaise,
      components: c.components,
      position: i,
    };
  });

  const subtotalPaise = catalog.reduce((s, c) => s + c.lineTotalPaise, 0);
  const discountPaise = evaluation?.discountPaise ?? 0;
  const shippingDiscountPaise = Math.min(evaluation?.shippingDiscountPaise ?? 0, input.shippingPaise);
  const shippingPaise = input.shippingPaise - shippingDiscountPaise;
  const totalPaise = subtotalPaise - discountPaise + shippingPaise;

  const tax = gstBreakup(
    drafts.map((d) => ({ amountPaise: d.lineTotalPaise, rateBp: d.gstRateBp })),
    shippingPaise,
    input.placeOfSupply,
    input.storeState,
  );
  return {
    items: drafts.map((d, i) => ({ ...d, taxPaise: tax.lineTax[i]! })),
    subtotalPaise,
    discountPaise,
    shippingPaise,
    shippingDiscountPaise,
    taxPaise: tax.taxPaise,
    totalPaise,
    tax,
  };
}
