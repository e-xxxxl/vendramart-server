import type { OrderStatus } from "./orderStateMachine.js";

// The 24-hour hold on vendor earnings and the earning states built on it. Everything is derived from
// timestamps and the payout link, so nothing depends on a scheduled job having run: a vendor's money becomes
// "available" the instant deliveredAt + 24h passes, whether or not the order has been marked COMPLETED yet.

export const HOLD_HOURS = 24;
export const HOLD_MS = HOLD_HOURS * 60 * 60 * 1000;

/** The exact moment earnings unlock: deliveredAt plus 24 hours. */
export const holdEndsAt = (deliveredAt: Date): Date => new Date(deliveredAt.getTime() + HOLD_MS);

/** True once the hold has fully passed. At exactly deliveredAt + 24h it is true. */
export const holdHasEnded = (deliveredAt: Date, now: Date): boolean => now.getTime() >= holdEndsAt(deliveredAt).getTime();

/** The latest `deliveredAt` that has already cleared the hold at `now`. A delivery at or before this is unlocked. */
export const unlockedBefore = (now: Date): Date => new Date(now.getTime() - HOLD_MS);

export const EARNING_STATES = ["NONE", "AWAITING_DELIVERY", "ON_HOLD", "AVAILABLE", "REQUESTED", "PAID"] as const;
/**
 * NONE               nothing is owed (unpaid or cancelled order)
 * AWAITING_DELIVERY  paid by the customer but not delivered yet (includes a failed delivery that may be retried)
 * ON_HOLD            delivered, inside the 24 hour hold
 * AVAILABLE          delivered, hold over, not part of a payout: can be requested
 * REQUESTED          locked in a payout the admin has not decided yet
 * PAID               included in a payout the admin has paid
 */
export type EarningState = (typeof EARNING_STATES)[number];

/** Payout status as far as earnings are concerned. A DECLINED payout releases its orders, so it counts as no payout. */
export type PayoutLink = "REQUESTED" | "PAID" | "DECLINED" | null | undefined;

export interface EarningInput {
  status: OrderStatus;
  deliveredAt?: Date | null;
  payoutStatus?: PayoutLink;
}

export interface EarningResult {
  state: EarningState;
  /** Only for ON_HOLD. */
  unlocksAt?: Date;
  /** Only for ON_HOLD: whole hours left, rounded up, so "1 minute left" reads as 1h and never as 0h. */
  hoursLeft?: number;
}

const DELIVERED_STATES: OrderStatus[] = ["DELIVERED", "COMPLETED"];
const NOT_YET_DELIVERED: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"];

/** Where one sub-order's earnings stand right now. Pure: same inputs, same answer. */
export function earningState({ status, deliveredAt, payoutStatus }: EarningInput, now: Date): EarningResult {
  if (NOT_YET_DELIVERED.includes(status)) return { state: "AWAITING_DELIVERY" };
  if (!DELIVERED_STATES.includes(status)) return { state: "NONE" }; // PENDING_PAYMENT, CANCELLED

  // Delivered. A payout that is still open or already paid owns the money.
  if (payoutStatus === "PAID") return { state: "PAID" };
  if (payoutStatus === "REQUESTED") return { state: "REQUESTED" };

  // No delivery time on a delivered order would be a data fault; treat it as still on hold rather than pay out early.
  if (!deliveredAt) return { state: "ON_HOLD", hoursLeft: HOLD_HOURS };
  if (holdHasEnded(deliveredAt, now)) return { state: "AVAILABLE" };

  const unlocksAt = holdEndsAt(deliveredAt);
  return { state: "ON_HOLD", unlocksAt, hoursLeft: Math.ceil((unlocksAt.getTime() - now.getTime()) / 3_600_000) };
}
