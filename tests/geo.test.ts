import { describe, expect, it } from "vitest";
import { haversineKm, resolveCity } from "../src/domain/geo.js";

const ibadan = { id: "ibadan", center: { lat: 7.3775, lng: 3.947 }, radiusKm: 30 };
const lagos = { id: "lagos", center: { lat: 6.5244, lng: 3.3792 }, radiusKm: 40 };

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm(ibadan.center, ibadan.center)).toBeCloseTo(0, 6);
  });

  it("matches the Ibadan to Lagos centre-to-centre straight-line distance (about 113.7 km)", () => {
    // Worked by hand: dLat 0.853 deg = 94.9 km, dLng 0.568 deg x cos(7 deg) = 62.7 km, hypot = 113.7 km.
    // (The road distance is longer, about 128 km; that is what Google Routes returns in Phase 3.)
    expect(haversineKm(ibadan.center, lagos.center)).toBeCloseTo(113.7, 0);
  });

  it("gives about 111.2 km per degree of latitude", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
  });

  it("is symmetric", () => {
    expect(haversineKm(ibadan.center, lagos.center)).toBeCloseTo(haversineKm(lagos.center, ibadan.center), 9);
  });
});

describe("resolveCity", () => {
  it("finds the city whose radius contains the point", () => {
    expect(resolveCity([ibadan, lagos], { lat: 7.4318, lng: 3.9144 })?.id).toBe("ibadan"); // Bodija
    expect(resolveCity([ibadan, lagos], { lat: 6.6, lng: 3.35 })?.id).toBe("lagos");
  });

  it("returns null outside every city", () => {
    expect(resolveCity([ibadan, lagos], { lat: 0, lng: 0 })).toBeNull();
    // Ogbomoso is roughly 100 km north of Ibadan, beyond its 30 km radius
    expect(resolveCity([ibadan, lagos], { lat: 8.13, lng: 4.24 })).toBeNull();
  });

  it("picks the nearest centre when radii overlap", () => {
    const a = { id: "a", center: { lat: 7.0, lng: 4.0 }, radiusKm: 60 };
    const b = { id: "b", center: { lat: 7.3, lng: 4.0 }, radiusKm: 60 };
    expect(resolveCity([a, b], { lat: 7.25, lng: 4.0 })?.id).toBe("b");
  });

  it("includes a point exactly on the edge", () => {
    const c = { id: "c", center: { lat: 0, lng: 0 }, radiusKm: haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0.1 }) };
    expect(resolveCity([c], { lat: 0, lng: 0.1 })?.id).toBe("c");
  });
});
