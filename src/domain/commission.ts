import { assertKobo, percentOf, type Kobo } from "./money.js";

export interface LineEarnings {
  lineTotalKobo: Kobo;
  /** The platform's cut of this line. */
  commissionKobo: Kobo;
  /** What the vendor earns from this line: sale price minus commission. Delivery fees are never part of it. */
  vendorEarningKobo: Kobo;
}

/**
 * Commission is taken per line item from the GOODS price only. Worked on each line (not on the
 * order total) so the amounts a vendor sees per item always add up to what they are paid.
 * `commissionBps` is the admin's percentage as basis points (1000 = 10%), snapshotted on the order.
 */
export function calculateLineEarnings(unitPriceKobo: Kobo, qty: number, commissionBps: number): LineEarnings {
  assertKobo(unitPriceKobo, "unit price");
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError(`quantity must be a whole number of at least 1, got ${qty}`);
  const lineTotalKobo = unitPriceKobo * qty;
  const commissionKobo = percentOf(lineTotalKobo, commissionBps);
  return { lineTotalKobo, commissionKobo, vendorEarningKobo: lineTotalKobo - commissionKobo };
}
