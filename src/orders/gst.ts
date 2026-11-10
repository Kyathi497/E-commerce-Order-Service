// GST on tax-inclusive prices (§6.7). Every price already includes GST, so
// tax is taken back out of each line: tax = amount × rate / (100% + rate).
// Inside Andhra Pradesh (the store's state) it is split into CGST + SGST,
// otherwise it is all IGST. Rates are in basis points (5% = 500).
// Confirm the HSN codes and rates with the CA before launch.

// GST state codes, for the place of supply.
export const STATES: { code: string; name: string }[] = [
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "18", name: "Assam" },
  { code: "10", name: "Bihar" },
  { code: "04", name: "Chandigarh" },
  { code: "22", name: "Chhattisgarh" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "07", name: "Delhi" },
  { code: "30", name: "Goa" },
  { code: "24", name: "Gujarat" },
  { code: "06", name: "Haryana" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "01", name: "Jammu and Kashmir" },
  { code: "20", name: "Jharkhand" },
  { code: "29", name: "Karnataka" },
  { code: "32", name: "Kerala" },
  { code: "38", name: "Ladakh" },
  { code: "31", name: "Lakshadweep" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "27", name: "Maharashtra" },
  { code: "14", name: "Manipur" },
  { code: "17", name: "Meghalaya" },
  { code: "15", name: "Mizoram" },
  { code: "13", name: "Nagaland" },
  { code: "21", name: "Odisha" },
  { code: "34", name: "Puducherry" },
  { code: "03", name: "Punjab" },
  { code: "08", name: "Rajasthan" },
  { code: "11", name: "Sikkim" },
  { code: "33", name: "Tamil Nadu" },
  { code: "36", name: "Telangana" },
  { code: "16", name: "Tripura" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "05", name: "Uttarakhand" },
  { code: "19", name: "West Bengal" },
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const BY_NAME = new Map(STATES.map((s) => [squash(s.name), s]));
// Names people commonly type.
for (const [alias, code] of [
  ["ap", "37"],
  ["newdelhi", "07"],
  ["nctofdelhi", "07"],
  ["orissa", "21"],
  ["pondicherry", "34"],
  ["jk", "01"],
  ["tn", "33"],
  ["ts", "36"],
] as const) {
  BY_NAME.set(alias, STATES.find((s) => s.code === code)!);
}

// The state for a name as typed ("andhra pradesh", "Tamil Nadu"), or null.
export const findState = (name: string) => BY_NAME.get(squash(name)) ?? null;

export const taxIncluded = (amountPaise: number, rateBp: number) =>
  rateBp <= 0 || amountPaise <= 0 ? 0 : Math.round((amountPaise * rateBp) / (10_000 + rateBp));

export interface TaxLine {
  // What the customer pays for the line, after discounts.
  amountPaise: number;
  rateBp: number;
}

export interface TaxBreakup {
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  intraState: boolean;
  // Per rate, for the invoice.
  rates: { rateBp: number; taxablePaise: number; taxPaise: number }[];
  // Tax in each line, in the same order as the input.
  lineTax: number[];
  shippingTaxPaise: number;
}

// Shipping is part of a composite supply, so it is taxed at the rate of the
// principal supply: the highest rate among the goods.
export function gstBreakup(lines: TaxLine[], shippingPaise: number, placeOfSupply: string, storeState: string): TaxBreakup {
  const lineTax = lines.map((l) => taxIncluded(l.amountPaise, l.rateBp));
  const shippingRate = lines.reduce((top, l) => Math.max(top, l.rateBp), 0);
  const shippingTaxPaise = taxIncluded(shippingPaise, shippingRate);

  const byRate = new Map<number, { taxablePaise: number; taxPaise: number }>();
  const add = (rateBp: number, amount: number, tax: number) => {
    if (amount <= 0) return;
    const r = byRate.get(rateBp) ?? { taxablePaise: 0, taxPaise: 0 };
    r.taxablePaise += amount - tax;
    r.taxPaise += tax;
    byRate.set(rateBp, r);
  };
  lines.forEach((l, i) => add(l.rateBp, l.amountPaise, lineTax[i]!));
  add(shippingRate, shippingPaise, shippingTaxPaise);

  const taxPaise = lineTax.reduce((a, b) => a + b, 0) + shippingTaxPaise;
  const intraState = placeOfSupply === storeState;
  const cgstPaise = intraState ? Math.floor(taxPaise / 2) : 0;
  return {
    taxPaise,
    cgstPaise,
    sgstPaise: intraState ? taxPaise - cgstPaise : 0,
    igstPaise: intraState ? 0 : taxPaise,
    intraState,
    rates: [...byRate.entries()].sort(([a], [b]) => a - b).map(([rateBp, r]) => ({ rateBp, ...r })),
    lineTax,
    shippingTaxPaise,
  };
}
