import { describe, expect, it } from "vitest";
import { calculateLineEarnings } from "../src/domain/commission.js";
import { ORDER_STATUSES, TERMINAL, allowedNext, assertTransition, canTransition, TransitionError, type Actor, type OrderStatus } from "../src/domain/orderStateMachine.js";

describe("calculateLineEarnings", () => {
  it("matches the vendor earnings screen (10%)", () => {
    expect(calculateLineEarnings(1850000, 1, 1000)).toEqual({ lineTotalKobo: 1850000, commissionKobo: 185000, vendorEarningKobo: 1665000 }); // King's Oil: N18,500 -> N1,850 -> N16,650
    expect(calculateLineEarnings(1500000, 2, 1000)).toEqual({ lineTotalKobo: 3000000, commissionKobo: 300000, vendorEarningKobo: 2700000 }); // Bean flour x2: N30,000 -> N3,000 -> N27,000
    expect(calculateLineEarnings(620000, 3, 1000)).toEqual({ lineTotalKobo: 1860000, commissionKobo: 186000, vendorEarningKobo: 1674000 }); // Mayonnaise x3: N18,600 -> N1,860 -> N16,740
  });

  it("matches the doc example: N10,000 at 10% shows N9,000 to the vendor", () => {
    expect(calculateLineEarnings(1000000, 1, 1000).vendorEarningKobo).toBe(900000);
  });

  it("commission plus earning always equals the sale, with no kobo lost or invented", () => {
    for (const bps of [0, 1, 250, 999, 1000, 1250, 3333, 10000]) {
      for (const price of [100, 101, 199, 12345, 507000, 1530000]) {
        for (const qty of [1, 2, 3, 7]) {
          const r = calculateLineEarnings(price, qty, bps);
          expect(r.commissionKobo + r.vendorEarningKobo).toBe(r.lineTotalKobo);
          expect(Number.isInteger(r.commissionKobo)).toBe(true);
        }
      }
    }
  });

  it("rounds a half kobo of commission up, so it favours the platform by under one kobo", () => {
    expect(calculateLineEarnings(5, 1, 1000)).toMatchObject({ commissionKobo: 1, vendorEarningKobo: 4 }); // 0.5 -> 1
    expect(calculateLineEarnings(4, 1, 1000)).toMatchObject({ commissionKobo: 0, vendorEarningKobo: 4 });
  });

  it("handles 0% and 100%", () => {
    expect(calculateLineEarnings(1500000, 1, 0)).toMatchObject({ commissionKobo: 0, vendorEarningKobo: 1500000 });
    expect(calculateLineEarnings(1500000, 1, 10000)).toMatchObject({ commissionKobo: 1500000, vendorEarningKobo: 0 });
  });

  it("never includes delivery: the inputs have no delivery field", () => {
    // The function only sees price, quantity and rate, so a delivery fee cannot leak into earnings.
    expect(calculateLineEarnings.length).toBe(3);
  });

  it("rejects bad input", () => {
    expect(() => calculateLineEarnings(1500.5, 1, 1000)).toThrow(RangeError);
    expect(() => calculateLineEarnings(1500, 0, 1000)).toThrow(RangeError);
    expect(() => calculateLineEarnings(1500, 1.5, 1000)).toThrow(RangeError);
    expect(() => calculateLineEarnings(1500, 1, 10001)).toThrow(RangeError);
    expect(() => calculateLineEarnings(-1, 1, 1000)).toThrow(RangeError);
  });
});

describe("order state machine", () => {
  it("allows exactly the happy path, one actor per step", () => {
    const path: [OrderStatus, OrderStatus, Actor][] = [
      ["PENDING_PAYMENT", "PAID", "SYSTEM"],
      ["PAID", "READY_FOR_PICKUP", "VENDOR"],
      ["READY_FOR_PICKUP", "PICKED_UP", "HANDLER"],
      ["PICKED_UP", "DELIVERED", "HANDLER"],
      ["DELIVERED", "COMPLETED", "SYSTEM"],
    ];
    for (const [from, to, actor] of path) expect(canTransition(from, to, actor), `${from} -> ${to}`).toBe(true);
  });

  it("does not let the wrong actor do a step", () => {
    expect(canTransition("PENDING_PAYMENT", "PAID", "CUSTOMER")).toBe(false); // a customer cannot mark their own order paid
    expect(canTransition("PENDING_PAYMENT", "PAID", "ADMIN")).toBe(false);
    expect(canTransition("PENDING_PAYMENT", "PAID", "VENDOR")).toBe(false);
    expect(canTransition("PAID", "READY_FOR_PICKUP", "HANDLER")).toBe(false);
    expect(canTransition("PAID", "READY_FOR_PICKUP", "CUSTOMER")).toBe(false);
    expect(canTransition("READY_FOR_PICKUP", "PICKED_UP", "VENDOR")).toBe(false);
    expect(canTransition("PICKED_UP", "DELIVERED", "VENDOR")).toBe(false);
    expect(canTransition("PICKED_UP", "DELIVERED", "CUSTOMER")).toBe(false);
    expect(canTransition("DELIVERED", "COMPLETED", "ADMIN")).toBe(false);
  });

  it("does not allow skipping steps or going backwards", () => {
    expect(canTransition("PAID", "PICKED_UP", "HANDLER")).toBe(false);
    expect(canTransition("PAID", "DELIVERED", "HANDLER")).toBe(false);
    expect(canTransition("READY_FOR_PICKUP", "DELIVERED", "HANDLER")).toBe(false);
    expect(canTransition("PENDING_PAYMENT", "READY_FOR_PICKUP", "VENDOR")).toBe(false);
    expect(canTransition("DELIVERED", "PICKED_UP", "HANDLER")).toBe(false);
    expect(canTransition("PICKED_UP", "READY_FOR_PICKUP", "HANDLER")).toBe(false);
    expect(canTransition("PAID", "PENDING_PAYMENT", "SYSTEM")).toBe(false);
  });

  it("never leaves a finished order (COMPLETED and CANCELLED are terminal)", () => {
    for (const from of TERMINAL) for (const to of ORDER_STATUSES) for (const actor of ["SYSTEM", "CUSTOMER", "VENDOR", "ADMIN", "HANDLER"] as Actor[]) {
      expect(canTransition(from, to, actor), `${actor}: ${from} -> ${to}`).toBe(false);
    }
  });

  it("handles failed delivery: the handler reports it, only the admin decides what next", () => {
    expect(canTransition("PICKED_UP", "FAILED_DELIVERY", "HANDLER")).toBe(true);
    expect(canTransition("PICKED_UP", "FAILED_DELIVERY", "VENDOR")).toBe(false);
    expect(canTransition("FAILED_DELIVERY", "PICKED_UP", "ADMIN")).toBe(true); // retry
    expect(canTransition("FAILED_DELIVERY", "CANCELLED", "ADMIN")).toBe(true);
    expect(canTransition("FAILED_DELIVERY", "PICKED_UP", "HANDLER")).toBe(false);
    expect(canTransition("FAILED_DELIVERY", "DELIVERED", "HANDLER")).toBe(false);
  });

  it("lets an unpaid order be cancelled by the customer or the system, and a paid one only by the admin", () => {
    expect(canTransition("PENDING_PAYMENT", "CANCELLED", "CUSTOMER")).toBe(true);
    expect(canTransition("PENDING_PAYMENT", "CANCELLED", "SYSTEM")).toBe(true);
    expect(canTransition("PAID", "CANCELLED", "CUSTOMER")).toBe(false);
    expect(canTransition("PAID", "CANCELLED", "VENDOR")).toBe(false);
    expect(canTransition("PAID", "CANCELLED", "ADMIN")).toBe(true);
    expect(canTransition("READY_FOR_PICKUP", "CANCELLED", "ADMIN")).toBe(true);
    expect(canTransition("PICKED_UP", "CANCELLED", "ADMIN")).toBe(false); // already on the road
  });

  it("allowedNext lists what each actor can do from a status", () => {
    expect(allowedNext("PAID", "VENDOR")).toEqual(["READY_FOR_PICKUP"]);
    expect(allowedNext("PICKED_UP", "HANDLER").sort()).toEqual(["DELIVERED", "FAILED_DELIVERY"]);
    expect(allowedNext("PICKED_UP", "VENDOR")).toEqual([]);
    expect(allowedNext("COMPLETED", "ADMIN")).toEqual([]);
  });

  it("assertTransition throws a TransitionError that names who tried what", () => {
    expect(() => assertTransition("PAID", "READY_FOR_PICKUP", "VENDOR")).not.toThrow();
    try {
      assertTransition("PAID", "DELIVERED", "HANDLER");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect((e as Error).message).toBe("HANDLER cannot move an order from PAID to DELIVERED");
    }
  });
});
