import { describe, expect, it } from "vitest";
import { HOLD_WORKING_DAYS, holdEndsAt, holdHasEnded, unlockedBefore } from "../src/domain/earnings.js";

const iso = (d: Date) => d.toISOString();
const at = (s: string) => new Date(s);
const DAY = 86_400_000;

// 15 Oct 2026 is a Thursday. Lagos is UTC+1 all year, so 09:12 UTC is 10:12 in Lagos.
describe("the hold: 4 working days after delivery", () => {
  const thursday = at("2026-10-15T09:12:00.000Z");

  it("is 4 working days", () => {
    expect(HOLD_WORKING_DAYS).toBe(4);
  });

  it("counts Monday to Friday, at the same time of day (delivered Thursday, unlocks the Wednesday after)", () => {
    // Fri 16 (1), Mon 19 (2), Tue 20 (3), Wed 21 (4)
    expect(iso(holdEndsAt(thursday))).toBe("2026-10-21T09:12:00.000Z");
  });

  it("is simply 4 days later when no weekend is in the way (delivered Monday, unlocks Friday)", () => {
    expect(iso(holdEndsAt(at("2026-10-12T09:12:00.000Z")))).toBe("2026-10-16T09:12:00.000Z");
  });

  it("skips the weekend (delivered Wednesday, unlocks the Tuesday after; delivered Friday, the Thursday after)", () => {
    expect(iso(holdEndsAt(at("2026-10-14T09:12:00.000Z")))).toBe("2026-10-20T09:12:00.000Z");
    expect(iso(holdEndsAt(at("2026-10-16T14:00:00.000Z")))).toBe("2026-10-22T14:00:00.000Z");
  });

  it("treats a Saturday or Sunday delivery as the start of Monday (unlocks Friday 00:00 Lagos time)", () => {
    expect(iso(holdEndsAt(at("2026-10-17T10:00:00.000Z")))).toBe("2026-10-22T23:00:00.000Z"); // Saturday
    expect(iso(holdEndsAt(at("2026-10-18T10:00:00.000Z")))).toBe("2026-10-22T23:00:00.000Z"); // Sunday
    expect(iso(holdEndsAt(at("2026-10-18T23:00:00.000Z")))).toBe("2026-10-22T23:00:00.000Z"); // Monday 00:00 in Lagos
  });

  it("works on the Lagos calendar, not the UTC one (23:30 UTC on a Friday is already Saturday in Lagos)", () => {
    expect(iso(holdEndsAt(at("2026-10-16T22:59:59.999Z")))).toBe("2026-10-22T22:59:59.999Z"); // Friday 23:59 Lagos
    expect(iso(holdEndsAt(at("2026-10-16T23:00:00.000Z")))).toBe("2026-10-22T23:00:00.000Z"); // Saturday 00:00 Lagos
  });

  it("has not ended one millisecond early, has ended at the exact moment, and stays ended", () => {
    expect(holdHasEnded(thursday, at("2026-10-21T09:11:59.999Z"))).toBe(false);
    expect(holdHasEnded(thursday, at("2026-10-21T09:12:00.000Z"))).toBe(true);
    expect(holdHasEnded(thursday, at("2026-12-30T00:00:00.000Z"))).toBe(true);
  });

  it("holds a Thursday delivery through the weekend and Monday, and frees it on Wednesday", () => {
    expect(holdHasEnded(thursday, at("2026-10-19T12:00:00.000Z"))).toBe(false);
    expect(holdHasEnded(thursday, at("2026-10-21T12:00:00.000Z"))).toBe(true);
  });

  it("never moves backwards: a later delivery never unlocks before an earlier one", () => {
    const start = at("2026-10-01T00:00:00.000Z").getTime();
    let previous = 0;
    for (let t = start; t < start + 21 * DAY; t += 37 * 60_000) {
      const ends = holdEndsAt(new Date(t)).getTime();
      expect(ends).toBeGreaterThanOrEqual(previous);
      previous = ends;
    }
  });

  it("always takes between 4 and 6 days", () => {
    const start = at("2026-10-01T00:00:00.000Z").getTime();
    for (let t = start; t < start + 21 * DAY; t += 53 * 60_000) {
      const span = holdEndsAt(new Date(t)).getTime() - t;
      expect(span).toBeGreaterThanOrEqual(4 * DAY);
      expect(span).toBeLessThanOrEqual(6 * DAY);
    }
  });

  it("does not change the date it was given", () => {
    const copy = new Date(thursday);
    holdEndsAt(thursday);
    expect(thursday.getTime()).toBe(copy.getTime());
  });
});

describe("unlockedBefore: the database's way of asking what has unlocked", () => {
  it("is the exact latest delivery whose hold has ended, to the millisecond, at any time of the week", () => {
    const start = at("2026-10-05T00:00:00.000Z").getTime();
    for (let t = start; t < start + 14 * DAY; t += 3 * 3_600_000 + 1234) {
      const now = new Date(t);
      const latest = unlockedBefore(now);
      expect(holdEndsAt(latest).getTime()).toBeLessThanOrEqual(now.getTime());
      expect(holdEndsAt(new Date(latest.getTime() + 1)).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("agrees with holdHasEnded for deliveries either side of it", () => {
    const now = at("2026-10-21T09:12:00.000Z"); // a Wednesday
    expect(iso(unlockedBefore(now))).toBe("2026-10-15T09:12:00.000Z"); // the Thursday before
    expect(holdHasEnded(unlockedBefore(now), now)).toBe(true);
    expect(holdHasEnded(new Date(unlockedBefore(now).getTime() + 1), now)).toBe(false);
  });
});
