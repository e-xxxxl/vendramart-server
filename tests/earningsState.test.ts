import { describe, expect, it } from "vitest";
import { HOLD_MS, earningState, unlockedBefore, type EarningState } from "../src/domain/earnings.js";
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

describe("the 24-hour hold", () => {
  it("is ON_HOLD straight after delivery, with the exact unlock time (screen: unlocks 16 Oct, 09:12)", () => {
    const r = earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-15T09:12:00.000Z"));
    expect(r.state).toBe("ON_HOLD");
    expect(r.unlocksAt!.toISOString()).toBe("2026-10-16T09:12:00.000Z");
    expect(r.hoursLeft).toBe(24);
  });

  it("shows 18 hours left six hours in (screen: On hold, 18h left)", () => {
    const r = earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-15T15:12:00.000Z"));
    expect(r).toMatchObject({ state: "ON_HOLD", hoursLeft: 18 });
  });

  it("rounds hours left up so the last minutes read as 1h, never 0h", () => {
    expect(earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-16T09:11:00.000Z")).hoursLeft).toBe(1);
    expect(earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-16T08:12:00.001Z")).hoursLeft).toBe(1);
    expect(earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-16T08:12:00.000Z")).hoursLeft).toBe(1);
    expect(earningState({ status: "DELIVERED", deliveredAt: T0 }, at("2026-10-16T08:11:59.999Z")).hoursLeft).toBe(2);
  });

  it("is still ON_HOLD one millisecond before 24 hours", () => {
    expect(state("DELIVERED", at("2026-10-16T09:11:59.999Z"), { deliveredAt: T0 })).toBe("ON_HOLD");
  });

  it("is AVAILABLE at exactly 24 hours, and stays available", () => {
    expect(state("DELIVERED", at("2026-10-16T09:12:00.000Z"), { deliveredAt: T0 })).toBe("AVAILABLE");
    expect(state("DELIVERED", at("2027-01-01T00:00:00.000Z"), { deliveredAt: T0 })).toBe("AVAILABLE");
  });

  it("does not need the order to be marked COMPLETED: DELIVERED 25 hours ago is already available", () => {
    expect(state("DELIVERED", new Date(T0.getTime() + HOLD_MS + 3_600_000), { deliveredAt: T0 })).toBe("AVAILABLE");
    expect(state("COMPLETED", new Date(T0.getTime() + HOLD_MS + 3_600_000), { deliveredAt: T0 })).toBe("AVAILABLE");
  });

  it("COMPLETED inside the hold (completed by hand or by a clock fault) is still held", () => {
    expect(state("COMPLETED", at("2026-10-15T10:00:00Z"), { deliveredAt: T0 })).toBe("ON_HOLD");
  });

  it("never pays out early when a delivered order has no delivery time", () => {
    expect(state("DELIVERED", at("2030-01-01T00:00:00Z"), { deliveredAt: null })).toBe("ON_HOLD");
    expect(state("DELIVERED", at("2030-01-01T00:00:00Z"))).toBe("ON_HOLD");
  });

  it("is unaffected by timezones or daylight saving, because it counts milliseconds", () => {
    const d = at("2026-03-28T23:30:00.000Z");
    expect(earningState({ status: "DELIVERED", deliveredAt: d }, new Date(d.getTime() + HOLD_MS - 1)).state).toBe("ON_HOLD");
    expect(earningState({ status: "DELIVERED", deliveredAt: d }, new Date(d.getTime() + HOLD_MS)).state).toBe("AVAILABLE");
  });

  it("unlockedBefore is the latest delivery time that has cleared the hold", () => {
    const now = at("2026-10-16T09:12:00.000Z");
    expect(unlockedBefore(now).toISOString()).toBe("2026-10-15T09:12:00.000Z");
    expect(state("DELIVERED", now, { deliveredAt: unlockedBefore(now) })).toBe("AVAILABLE");
    expect(state("DELIVERED", now, { deliveredAt: new Date(unlockedBefore(now).getTime() + 1) })).toBe("ON_HOLD");
  });
});

describe("payouts own the money once requested", () => {
  const later = at("2026-10-20T00:00:00Z"); // well past the hold

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
