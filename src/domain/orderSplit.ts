import { assertKobo, sumKobo, type Kobo } from "./money.js";

// THE one place that decides how a cart becomes deliveries. Today: one group (one sub-order, one
// delivery leg, one fee) per vendor, as shown on the checkout screen. If the client later wants a
// different policy (for example one delivery for the whole cart), change this function and the
// fee step that consumes the groups; nothing else needs to know.

export interface CartLine {
  productId: string;
  vendorId: string;
  qty: number;
  unitPriceKobo: Kobo;
}

export interface DeliveryGroup<L extends CartLine = CartLine> {
  vendorId: string;
  lines: L[];
  itemsTotalKobo: Kobo;
}

export const lineTotalKobo = (line: Pick<CartLine, "qty" | "unitPriceKobo">): Kobo => {
  if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw new RangeError(`quantity must be a whole number of at least 1, got ${line.qty}`);
  return assertKobo(line.unitPriceKobo, "unit price") * line.qty;
};

/** Groups cart lines by vendor, keeping the order vendors first appear in the cart. */
export function splitByVendor<L extends CartLine>(lines: L[]): DeliveryGroup<L>[] {
  const groups = new Map<string, L[]>();
  for (const line of lines) {
    const bucket = groups.get(line.vendorId);
    if (bucket) bucket.push(line);
    else groups.set(line.vendorId, [line]);
  }
  return [...groups.entries()].map(([vendorId, vendorLines]) => ({
    vendorId,
    lines: vendorLines,
    itemsTotalKobo: sumKobo(vendorLines.map(lineTotalKobo)),
  }));
}
