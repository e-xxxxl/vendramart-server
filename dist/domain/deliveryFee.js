import { assertKobo, divRoundHalfUp } from "./money.js";
/** Nearest 0.1 km, as tenths. 3149 m = 31 (3.1 km), 3150 m = 32 (3.2 km). */
export function metersToTenthsKm(distanceMeters) {
    if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
        throw new RangeError(`distance must be a non-negative number of metres, got ${distanceMeters}`);
    }
    return divRoundHalfUp(Math.round(distanceMeters), 100);
}
/**
 * Delivery fee = road distance (km) x price per km, with an optional minimum.
 *
 * The distance is rounded to 0.1 km FIRST and the fee is computed from that rounded figure, so the
 * checkout line "3.2 km x N200 per km = N640" is always arithmetically true. All maths is integer.
 */
export function calculateDeliveryFee({ distanceMeters, pricePerKmKobo, minFeeKobo }) {
    assertKobo(pricePerKmKobo, "price per km");
    const min = minFeeKobo == null ? null : assertKobo(minFeeKobo, "minimum delivery fee");
    const distanceTenthsKm = metersToTenthsKm(distanceMeters);
    // tenths of a km x kobo per km / 10, rounded half up to a whole kobo.
    const raw = divRoundHalfUp(distanceTenthsKm * pricePerKmKobo, 10);
    const feeKobo = min !== null && raw < min ? min : raw;
    return {
        distanceTenthsKm,
        billedMeters: distanceTenthsKm * 100,
        pricePerKmKobo,
        minFeeKobo: min,
        minFeeApplied: min !== null && raw < min,
        feeKobo,
    };
}
/** "3.2" for display. Takes tenths of a km. */
export const formatTenthsKm = (tenths) => (tenths / 10).toFixed(1);
