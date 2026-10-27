// The 24-hour hold on vendor earnings and the earning states built on it. Everything is derived from
// timestamps and the payout link, so nothing depends on a scheduled job having run: a vendor's money becomes
// "available" the instant deliveredAt + 24h passes, whether or not the order has been marked COMPLETED yet.
export const HOLD_HOURS = 24;
export const HOLD_MS = HOLD_HOURS * 60 * 60 * 1000;
/** The exact moment earnings unlock: deliveredAt plus 24 hours. */
export const holdEndsAt = (deliveredAt) => new Date(deliveredAt.getTime() + HOLD_MS);
/** True once the hold has fully passed. At exactly deliveredAt + 24h it is true. */
export const holdHasEnded = (deliveredAt, now) => now.getTime() >= holdEndsAt(deliveredAt).getTime();
/** The latest `deliveredAt` that has already cleared the hold at `now`. A delivery at or before this is unlocked. */
export const unlockedBefore = (now) => new Date(now.getTime() - HOLD_MS);
export const EARNING_STATES = ["NONE", "AWAITING_DELIVERY", "ON_HOLD", "AVAILABLE", "REQUESTED", "PAID"];
const DELIVERED_STATES = ["DELIVERED", "COMPLETED"];
const NOT_YET_DELIVERED = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"];
/** Where one sub-order's earnings stand right now. Pure: same inputs, same answer. */
export function earningState({ status, deliveredAt, payoutStatus }, now) {
    if (NOT_YET_DELIVERED.includes(status))
        return { state: "AWAITING_DELIVERY" };
    if (!DELIVERED_STATES.includes(status))
        return { state: "NONE" }; // PENDING_PAYMENT, CANCELLED
    // Delivered. A payout that is still open or already paid owns the money.
    if (payoutStatus === "PAID")
        return { state: "PAID" };
    if (payoutStatus === "REQUESTED")
        return { state: "REQUESTED" };
    // No delivery time on a delivered order would be a data fault; treat it as still on hold rather than pay out early.
    if (!deliveredAt)
        return { state: "ON_HOLD", hoursLeft: HOLD_HOURS };
    if (holdHasEnded(deliveredAt, now))
        return { state: "AVAILABLE" };
    const unlocksAt = holdEndsAt(deliveredAt);
    return { state: "ON_HOLD", unlocksAt, hoursLeft: Math.ceil((unlocksAt.getTime() - now.getTime()) / 3_600_000) };
}
