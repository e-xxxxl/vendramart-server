import { describe, expect, it } from "vitest";
import { calculateDeliveryFee, formatTenthsKm, metersToTenthsKm } from "../src/domain/deliveryFee.js";

const PER_KM = 20000; // N200 per km, in kobo (the admin screen default)

describe("calculateDeliveryFee", () => {
  it("reproduces the checkout screen: 3.2 km and 6.4 km at N200 per km", () => {
    const a = calculateDeliveryFee({ distanceMeters: 3200, pricePerKmKobo: PER_KM });
    const b = calculateDeliveryFee({ distanceMeters: 6400, pricePerKmKobo: PER_KM });
    expect(a.feeKobo).toBe(64000); // N640
    expect(b.feeKobo).toBe(128000); // N1,280
    expect(a.feeKobo + b.feeKobo).toBe(192000); // N1,920 on the order summary (9.6 km)
  });

  it("matches the workflow doc example: 8 km at N200 per km is N1,600", () => {
    expect(calculateDeliveryFee({ distanceMeters: 8000, pricePerKmKobo: PER_KM }).feeKobo).toBe(160000);
  });

  it("matches the admin screen preview: 6.4 km costs N1,280", () => {
    expect(calculateDeliveryFee({ distanceMeters: 6400, pricePerKmKobo: PER_KM }).feeKobo).toBe(128000);
  });

  describe("0.1 km rounding", () => {
    it("rounds to the nearest tenth of a km, half up", () => {
      expect(metersToTenthsKm(3149)).toBe(31);
      expect(metersToTenthsKm(3150)).toBe(32);
      expect(metersToTenthsKm(3199)).toBe(32);
      expect(metersToTenthsKm(49)).toBe(0);
      expect(metersToTenthsKm(50)).toBe(1);
    });

    it("accepts fractional metres from a maps API", () => {
      expect(metersToTenthsKm(3149.6)).toBe(32);
      expect(metersToTenthsKm(3149.4)).toBe(31);
    });

    it("bills from the rounded distance, not the raw one, so the line item always multiplies out", () => {
      const r = calculateDeliveryFee({ distanceMeters: 3149, pricePerKmKobo: PER_KM });
      expect(r.distanceTenthsKm).toBe(31);
      expect(r.billedMeters).toBe(3100);
      expect(r.feeKobo).toBe(62000); // 3.1 km x N200, not 3.149 x N200 = N629.80
    });

    it("always satisfies fee = tenths x price / 10 for whole-naira prices", () => {
      for (let m = 0; m <= 60000; m += 137) {
        const r = calculateDeliveryFee({ distanceMeters: m, pricePerKmKobo: PER_KM });
        expect(r.feeKobo).toBe((r.distanceTenthsKm * PER_KM) / 10);
      }
    });

    it("formats tenths for display", () => {
      expect(formatTenthsKm(32)).toBe("3.2");
      expect(formatTenthsKm(96)).toBe("9.6");
      expect(formatTenthsKm(0)).toBe("0.0");
      expect(formatTenthsKm(1000)).toBe("100.0");
    });
  });

  describe("minimum delivery fee", () => {
    it("is not applied when no minimum is set (null or undefined)", () => {
      expect(calculateDeliveryFee({ distanceMeters: 500, pricePerKmKobo: PER_KM, minFeeKobo: null })).toMatchObject({ feeKobo: 10000, minFeeApplied: false, minFeeKobo: null });
      expect(calculateDeliveryFee({ distanceMeters: 500, pricePerKmKobo: PER_KM })).toMatchObject({ feeKobo: 10000, minFeeApplied: false });
    });

    it("raises a short trip up to the minimum", () => {
      const r = calculateDeliveryFee({ distanceMeters: 500, pricePerKmKobo: PER_KM, minFeeKobo: 50000 });
      expect(r).toMatchObject({ feeKobo: 50000, minFeeApplied: true, minFeeKobo: 50000 });
    });

    it("does not touch a trip already above the minimum", () => {
      const r = calculateDeliveryFee({ distanceMeters: 6400, pricePerKmKobo: PER_KM, minFeeKobo: 50000 });
      expect(r).toMatchObject({ feeKobo: 128000, minFeeApplied: false });
    });

    it("is not 'applied' when the fee equals the minimum exactly", () => {
      const r = calculateDeliveryFee({ distanceMeters: 2500, pricePerKmKobo: PER_KM, minFeeKobo: 50000 });
      expect(r).toMatchObject({ feeKobo: 50000, minFeeApplied: false });
    });

    it("applies to a zero-distance trip", () => {
      expect(calculateDeliveryFee({ distanceMeters: 0, pricePerKmKobo: PER_KM, minFeeKobo: 30000 }).feeKobo).toBe(30000);
      expect(calculateDeliveryFee({ distanceMeters: 0, pricePerKmKobo: PER_KM }).feeKobo).toBe(0);
    });

    it("a minimum of zero is the same as none", () => {
      expect(calculateDeliveryFee({ distanceMeters: 500, pricePerKmKobo: PER_KM, minFeeKobo: 0 })).toMatchObject({ feeKobo: 10000, minFeeApplied: false });
    });
  });

  describe("integer safety", () => {
    it("rounds a half kobo up when the price per km is not a multiple of 10 kobo", () => {
      // 1 tenth x 20055 / 10 = 2005.5 kobo
      expect(calculateDeliveryFee({ distanceMeters: 100, pricePerKmKobo: 20055 }).feeKobo).toBe(2006);
      expect(calculateDeliveryFee({ distanceMeters: 100, pricePerKmKobo: 20054 }).feeKobo).toBe(2005);
    });

    it("handles a price with kobo (N200.50 per km)", () => {
      expect(calculateDeliveryFee({ distanceMeters: 3300, pricePerKmKobo: 20050 }).feeKobo).toBe(66165);
    });

    it("never returns a fractional kobo", () => {
      for (const price of [19999, 20001, 20055, 33333, 1]) {
        for (let m = 0; m < 30000; m += 111) {
          expect(Number.isInteger(calculateDeliveryFee({ distanceMeters: m, pricePerKmKobo: price }).feeKobo)).toBe(true);
        }
      }
    });

    it("copes with a very long trip", () => {
      expect(calculateDeliveryFee({ distanceMeters: 250000, pricePerKmKobo: PER_KM }).feeKobo).toBe(5_000_000);
    });

    it("is zero when the price per km is zero", () => {
      expect(calculateDeliveryFee({ distanceMeters: 8000, pricePerKmKobo: 0 }).feeKobo).toBe(0);
    });
  });

  describe("rejects bad input instead of guessing", () => {
    it.each([
      ["negative distance", { distanceMeters: -1, pricePerKmKobo: PER_KM }],
      ["NaN distance", { distanceMeters: NaN, pricePerKmKobo: PER_KM }],
      ["Infinity distance", { distanceMeters: Infinity, pricePerKmKobo: PER_KM }],
      ["fractional price per km", { distanceMeters: 1000, pricePerKmKobo: 200.5 }],
      ["negative price per km", { distanceMeters: 1000, pricePerKmKobo: -1 }],
      ["fractional minimum", { distanceMeters: 1000, pricePerKmKobo: PER_KM, minFeeKobo: 10.5 }],
      ["negative minimum", { distanceMeters: 1000, pricePerKmKobo: PER_KM, minFeeKobo: -5 }],
    ])("%s", (_name, input) => {
      expect(() => calculateDeliveryFee(input)).toThrow(RangeError);
    });
  });
});
