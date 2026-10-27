// All money is integer kobo. This is the only place that rounds or validates amounts.
/** Throws unless the value is a safe, non-negative integer number of kobo. */
export function assertKobo(value, what = "amount") {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${what} must be a non-negative whole number of kobo, got ${value}`);
    }
    return value;
}
/** Integer division rounding half up, for non-negative integers. Avoids float drift entirely. */
export function divRoundHalfUp(numerator, denominator) {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0 || numerator < 0) {
        throw new RangeError(`divRoundHalfUp needs non-negative integers and a positive divisor, got ${numerator}/${denominator}`);
    }
    return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
/** Sum of integer kobo amounts. */
export function sumKobo(values) {
    return values.reduce((total, v) => total + assertKobo(v), 0);
}
/** Percentage held as basis points (1000 = 10%). Returns round-half-up kobo. */
export function percentOf(amountKobo, basisPoints) {
    assertKobo(amountKobo);
    if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
        throw new RangeError(`basis points must be an integer from 0 to 10000, got ${basisPoints}`);
    }
    return divRoundHalfUp(amountKobo * basisPoints, 10000);
}
