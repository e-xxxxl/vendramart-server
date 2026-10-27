import { assertKobo, sumKobo } from "./money.js";
export const lineTotalKobo = (line) => {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1)
        throw new RangeError(`quantity must be a whole number of at least 1, got ${line.qty}`);
    return assertKobo(line.unitPriceKobo, "unit price") * line.qty;
};
/** Groups cart lines by vendor, keeping the order vendors first appear in the cart. */
export function splitByVendor(lines) {
    const groups = new Map();
    for (const line of lines) {
        const bucket = groups.get(line.vendorId);
        if (bucket)
            bucket.push(line);
        else
            groups.set(line.vendorId, [line]);
    }
    return [...groups.entries()].map(([vendorId, vendorLines]) => ({
        vendorId,
        lines: vendorLines,
        itemsTotalKobo: sumKobo(vendorLines.map(lineTotalKobo)),
    }));
}
