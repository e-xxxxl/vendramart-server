import { describe, expect, it } from "vitest";
import { assertKobo, divRoundHalfUp, percentOf, sumKobo } from "../src/domain/money.js";
import { lineTotalKobo, splitByVendor, type CartLine } from "../src/domain/orderSplit.js";

describe("money helpers", () => {
  it("assertKobo accepts whole non-negative numbers and rejects everything else", () => {
    expect(assertKobo(0)).toBe(0);
    expect(assertKobo(1500000)).toBe(1500000);
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) expect(() => assertKobo(bad)).toThrow(RangeError);
  });

  it("divRoundHalfUp rounds .5 up and avoids float drift", () => {
    expect(divRoundHalfUp(1, 2)).toBe(1);
    expect(divRoundHalfUp(5, 10)).toBe(1);
    expect(divRoundHalfUp(4, 10)).toBe(0);
    expect(divRoundHalfUp(25, 10)).toBe(3);
    expect(divRoundHalfUp(24, 10)).toBe(2);
    expect(divRoundHalfUp(0, 7)).toBe(0);
    expect(() => divRoundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => divRoundHalfUp(-1, 2)).toThrow(RangeError);
  });

  it("sumKobo adds exactly (no 0.1 + 0.2 problem) and validates every term", () => {
    expect(sumKobo([10, 20, 30])).toBe(60);
    expect(sumKobo([])).toBe(0);
    expect(() => sumKobo([10, 0.5])).toThrow(RangeError);
  });

  it("percentOf works in basis points: 10% of the screen sale amounts", () => {
    expect(percentOf(1500000, 1000)).toBe(150000); // N15,000 -> N1,500
    expect(percentOf(1850000, 1000)).toBe(185000); // N18,500 -> N1,850
    expect(percentOf(1860000, 1000)).toBe(186000); // N18,600 -> N1,860
    expect(percentOf(1000000, 1000)).toBe(100000); // doc example: N10,000 -> N1,000
  });

  it("percentOf rounds half up and rejects bad basis points", () => {
    expect(percentOf(1, 5000)).toBe(1); // 0.5 kobo -> 1
    expect(percentOf(3, 1000)).toBe(0); // 0.3 -> 0
    expect(percentOf(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOf(100, 0)).toBe(0);
    expect(percentOf(100, 10000)).toBe(100);
    expect(() => percentOf(100, 10001)).toThrow(RangeError);
    expect(() => percentOf(100, 12.5)).toThrow(RangeError);
    expect(() => percentOf(100.5, 1000)).toThrow(RangeError);
  });
});

const line = (productId: string, vendorId: string, qty: number, unitPriceKobo: number): CartLine => ({ productId, vendorId, qty, unitPriceKobo });

describe("splitByVendor", () => {
  it("makes one group per vendor, as on the checkout screen", () => {
    const groups = splitByVendor([line("bean-flour", "bodija", 1, 1500000), line("palm-oil", "ojaba", 1, 1530000)]);
    expect(groups.map((g) => g.vendorId)).toEqual(["bodija", "ojaba"]);
    expect(groups.map((g) => g.itemsTotalKobo)).toEqual([1500000, 1530000]);
    expect(groups.reduce((s, g) => s + g.itemsTotalKobo, 0)).toBe(3030000); // N30,300 subtotal
  });

  it("merges lines of the same vendor even when they are not adjacent, keeping first-seen order", () => {
    const groups = splitByVendor([line("a", "v1", 1, 100), line("b", "v2", 1, 200), line("c", "v1", 2, 300)]);
    expect(groups.map((g) => g.vendorId)).toEqual(["v1", "v2"]);
    expect(groups[0]!.lines.map((l) => l.productId)).toEqual(["a", "c"]);
    expect(groups[0]!.itemsTotalKobo).toBe(100 + 600);
  });

  it("multiplies quantity by unit price", () => {
    expect(splitByVendor([line("a", "v1", 3, 1500000)])[0]!.itemsTotalKobo).toBe(4500000);
    expect(lineTotalKobo({ qty: 2, unitPriceKobo: 1250000 })).toBe(2500000);
  });

  it("returns nothing for an empty cart", () => {
    expect(splitByVendor([])).toEqual([]);
  });

  it("rejects a zero, negative or fractional quantity and a fractional price", () => {
    expect(() => splitByVendor([line("a", "v1", 0, 100)])).toThrow(RangeError);
    expect(() => splitByVendor([line("a", "v1", -1, 100)])).toThrow(RangeError);
    expect(() => splitByVendor([line("a", "v1", 1.5, 100)])).toThrow(RangeError);
    expect(() => splitByVendor([line("a", "v1", 1, 99.5)])).toThrow(RangeError);
  });

  it("keeps extra fields on the lines it is given", () => {
    const groups = splitByVendor([{ ...line("a", "v1", 1, 100), name: "Garri" }]);
    expect(groups[0]!.lines[0]!.name).toBe("Garri");
  });
});
