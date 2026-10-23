import { describe, expect, it } from "vitest";
import { HOLD_HOURS, HOLD_MS, holdEndsAt, holdHasEnded } from "../src/domain/earnings.js";

describe("the 24-hour hold", () => {
  const delivered = new Date("2026-10-15T09:12:00.000Z"); // the vendor screen: delivered 15 Oct, 09:12

  it("is exactly 24 hours", () => {
    expect(HOLD_HOURS).toBe(24);
    expect(HOLD_MS).toBe(86_400_000);
  });

  it("unlocks at deliveredAt plus 24 hours (the vendor screen says unlocks 16 Oct, 09:12)", () => {
    expect(holdEndsAt(delivered).toISOString()).toBe("2026-10-16T09:12:00.000Z");
  });

  it("has not ended one millisecond early, has ended at the exact moment, and stays ended", () => {
    expect(holdHasEnded(delivered, new Date("2026-10-16T09:11:59.999Z"))).toBe(false);
    expect(holdHasEnded(delivered, new Date("2026-10-16T09:12:00.000Z"))).toBe(true);
    expect(holdHasEnded(delivered, new Date("2026-10-30T00:00:00.000Z"))).toBe(true);
  });

  it("is not confused by deliveries before a clock change, because it counts real milliseconds", () => {
    const lateNight = new Date("2026-03-28T23:30:00.000Z");
    expect(holdEndsAt(lateNight).getTime() - lateNight.getTime()).toBe(HOLD_MS);
  });

  it("does not change the date it was given", () => {
    const copy = new Date(delivered);
    holdEndsAt(delivered);
    expect(delivered.getTime()).toBe(copy.getTime());
  });
});
