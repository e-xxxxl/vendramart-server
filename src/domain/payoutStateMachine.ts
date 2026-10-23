// A payout request has exactly one decision: the admin pays it (with a receipt) or declines it (with a reason).
// Once decided it never changes again.

export const PAYOUT_STATUSES = ["REQUESTED", "PAID", "DECLINED"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const ALLOWED: Record<PayoutStatus, PayoutStatus[]> = {
  REQUESTED: ["PAID", "DECLINED"],
  PAID: [],
  DECLINED: [],
};

export const canPayoutTransition = (from: PayoutStatus, to: PayoutStatus): boolean => ALLOWED[from].includes(to);

export class PayoutTransitionError extends Error {
  constructor(
    public from: PayoutStatus,
    public to: PayoutStatus,
  ) {
    super(`A payout that is ${from.toLowerCase()} cannot be marked ${to.toLowerCase()}`);
    this.name = "PayoutTransitionError";
  }
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canPayoutTransition(from, to)) throw new PayoutTransitionError(from, to);
}
