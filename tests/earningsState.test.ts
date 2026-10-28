import { describe, expect, it } from "vitest";
import { earningState, holdEndsAt, unlockedBefore, type EarningState } from "../src/domain/earnings.js";
import { PAYOUT_STATUSES, PayoutTransitionError, assertPayoutTransition, canPayoutTransition, type PayoutStatus } from "../src/domain/payoutStateMachine.js";
import { ORDER_STATUSES, type OrderStatus } from "../src/domain/orderStateMachine.js";

const T0 = new Date("2026-10-15T09:12:00.000Z"); // the vendor screen: delivered 15 Oct, 09:12
const at = (iso: string) => new Date(iso);
const state = (status: OrderStatus, now: Date, extra: { deliveredAt?: Date | null; payoutStatus?: "REQUESTED" | "PAID" | "DECLINED" | null } = {}) => earningState({ status, ...extra }, now).state;

describe("earningState before delivery", () => {
  it.each<[OrderStatus, EarningState]>([
    ["PENDING_PAYMENT", "NONE"],
    ["CANCELLED", "NONE"],
    ["PAID", "AWAITING_DELIVERY"],
    ["READY_FOR_PICKUP", "AWAITING_DELIVERY"],
    ["PICKED_UP", "AWAITING_DELIVERY"],
    ["FAILED_DELIVERY", "AWAITING_DELIVERY"], // may be retried, so nothing is lost yet, but nothing is earned either
  ])("%s is %s", (status, expected) => {
    expect(state(status, T0)).toBe(expected);
  });

  it("ignores a stray deliveredAt on an order that is not delivered", () => {
    expect(state("PICKED_UP", at("2030-01-01T00:00:00Z"), { deliveredAt: T0 })).toBe("AWAITING_DELIVERY");
  });
});

describe("the hold: 4 working days", () => {
  // T0 is Thursday 15 Oct 09:12 UTC, so the money unlocks on Wednesday 21 Oct at 09:12 UTC.
  const UNLOCK = "2026-10-21T09:12:00.000Z";

  it("is ON_HOLD straight after delivery, with the exact unlock time", () => {
    const r = earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-15T09:12:00.000Z"));
    expect(r.state).toBe("ON_HOLD");
    expect(r.unlocksAt!.toISOString()).toBe(UNLOCK);
  });

  it("stays ON_HOLD through the weekend and the days after it", () => {
    for (const now of ["2026-10-16T09:12:00.000Z", "2026-10-17T12:00:00.000Z", "2026-10-19T12:00:00.000Z", "2026-10-20T23:59:59.999Z"]) {
      expect(state("DELIVERED", at(now), { deliveredAt: T0 }), now).toBe("ON_HOLD");
    }
  });

  it("is still ON_HOLD one millisecond before the unlock moment", () => {
    expect(state("DELIVERED", at("2026-10-21T09:11:59.999Z"), { deliveredAt: T0 })).toBe("ON_HOLD");
  });

  it("is AVAILABLE at exactly the unlock moment, and stays available", () => {
    expect(state("DELIVERED", at(UNLOCK), { deliveredAt: T0 })).toBe("AVAILABLE");
    expect(state("DELIVERED", at("2027-01-01T00:00:00.000Z"), { deliveredAt: T0 })).toBe("AVAILABLE");
  });

  it("does not need the order to be marked COMPLETED: DELIVERED and past the hold is already available", () => {
    const later = new Date(holdEndsAt(T0).getTime() + 3_600_000);
    expect(state("DELIVERED", later, { deliveredAt: T0 })).toBe("AVAILABLE");
    expect(state("COMPLETED", later, { deliveredAt: T0 })).toBe("AVAILABLE");
  });

  it("COMPLETED inside the hold (completed by hand or by a clock fault) is still held", () => {
    expect(state("COMPLETED", at("2026-10-15T10:00:00Z"), { deliveredAt: T0 })).toBe("ON_HOLD");
  });

  it("never pays out early when a delivered order has no delivery time", () => {
    expect(state("DELIVERED", at("2030-01-01T00:00:00Z"), { deliveredAt: null })).toBe("ON_HOLD");
    expect(state("DELIVERED", at("2030-01-01T00:00:00Z"))).toBe("ON_HOLD");
  });

  it("unlockedBefore is the latest delivery time that has cleared the hold", () => {
    const now = at(UNLOCK);
    expect(unlockedBefore(now).toISOString()).toBe("2026-10-15T09:12:00.000Z");
    expect(state("DELIVERED", now, { deliveredAt: unlockedBefore(now) })).toBe("AVAILABLE");
    expect(state("DELIVERED", now, { deliveredAt: new Date(unlockedBefore(now).getTime() + 1) })).toBe("ON_HOLD");
  });
});

describe("payouts own the money once requested", () => {
  const later = at("2026-10-30T00:00:00Z"); // well past the hold

  it("REQUESTED while the admin has not decided", () => {
    expect(state("DELIVERED", later, { deliveredAt: T0, payoutStatus: "REQUESTED" })).toBe("REQUESTED");
    expect(state("COMPLETED", later, { deliveredAt: T0, payoutStatus: "REQUESTED" })).toBe("REQUESTED");
  });

  it("PAID once the admin has paid", () => {
    expect(state("COMPLETED", later, { deliveredAt: T0, payoutStatus: "PAID" })).toBe("PAID");
  });

  it("a DECLINED payout releases the money back to AVAILABLE", () => {
    expect(state("COMPLETED", later, { deliveredAt: T0, payoutStatus: "DECLINED" })).toBe("AVAILABLE");
  });

  it("a payout that somehow covers a held order does not release it: held money stays held", () => {
    // Defensive: payout status wins only for delivered orders, and a request can only take unlocked ones in the first place.
    expect(state("DELIVERED", at("2026-10-15T10:00:00Z"), { deliveredAt: T0, payoutStatus: "DECLINED" })).toBe("ON_HOLD");
  });

  it("a payout link on an undelivered or cancelled order changes nothing", () => {
    expect(state("PICKED_UP", later, { payoutStatus: "PAID" })).toBe("AWAITING_DELIVERY");
    expect(state("CANCELLED", later, { payoutStatus: "PAID" })).toBe("NONE");
  });

  it("covers every order status without throwing", () => {
    for (const s of ORDER_STATUSES) expect(() => earningState({ status: s, deliveredAt: T0 }, later)).not.toThrow();
  });
});

describe("payout state machine", () => {
  it("REQUESTED can become PAID or DECLINED and nothing else", () => {
    expect(canPayoutTransition("REQUESTED", "PAID")).toBe(true);
    expect(canPayoutTransition("REQUESTED", "DECLINED")).toBe(true);
    expect(canPayoutTransition("REQUESTED", "REQUESTED")).toBe(false);
  });

  it("PAID and DECLINED are final", () => {
    for (const from of ["PAID", "DECLINED"] as PayoutStatus[]) {
      for (const to of PAYOUT_STATUSES) expect(canPayoutTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it("assertPayoutTransition throws a readable PayoutTransitionError", () => {
    expect(() => assertPayoutTransition("REQUESTED", "PAID")).not.toThrow();
    try {
      assertPayoutTransition("PAID", "DECLINED");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PayoutTransitionError);
      expect((e as Error).message).toBe("A payout that is paid cannot be marked declined");
    }
  });
});
