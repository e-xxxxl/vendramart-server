import { assertKobo, percentOf } from "./money.js";
/**
 * Commission is taken per line item from the GOODS price only. Worked on each line (not on the
 * order total) so the amounts a vendor sees per item always add up to what they are paid.
 * `commissionBps` is the admin's percentage as basis points (1000 = 10%), snapshotted on the order.
 */
export function calculateLineEarnings(unitPriceKobo, qty, commissionBps) {
    assertKobo(unitPriceKobo, "unit price");
    if (!Number.isSafeInteger(qty) || qty < 1)
        throw new RangeError(`quantity must be a whole number of at least 1, got ${qty}`);
    const lineTotalKobo = unitPriceKobo * qty;
    const commissionKobo = percentOf(lineTotalKobo, commissionBps);
    return { lineTotalKobo, commissionKobo, vendorEarningKobo: lineTotalKobo - commissionKobo };
}
