// A payout request has exactly one decision: the admin pays it (with a receipt) or declines it (with a reason).
// Once decided it never changes again.
export const PAYOUT_STATUSES = ["REQUESTED", "PAID", "DECLINED"];
const ALLOWED = {
    REQUESTED: ["PAID", "DECLINED"],
    PAID: [],
    DECLINED: [],
};
export const canPayoutTransition = (from, to) => ALLOWED[from].includes(to);
export class PayoutTransitionError extends Error {
    from;
    to;
    constructor(from, to) {
        super(`A payout that is ${from.toLowerCase()} cannot be marked ${to.toLowerCase()}`);
        this.from = from;
        this.to = to;
        this.name = "PayoutTransitionError";
    }
}
export function assertPayoutTransition(from, to) {
    if (!canPayoutTransition(from, to))
        throw new PayoutTransitionError(from, to);
}
