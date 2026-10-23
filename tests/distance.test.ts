import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { haversineKm } from "../src/domain/geo.js";
import { DistanceCache } from "../src/models/DistanceCache.js";
import { getPricing, Settings } from "../src/models/Settings.js";
import { CachedDistanceProvider, cacheKey } from "../src/services/distance/CachedDistanceProvider.js";
import { DevStraightLineProvider } from "../src/services/distance/DevStraightLineProvider.js";
import { GoogleRoutesProvider } from "../src/services/distance/GoogleRoutesProvider.js";
import { IBADAN, OJA_BA, clearDb, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("GoogleRoutesProvider", () => {
  it("calls the Routes API with the right URL, key, field mask and coordinates, and returns metres", async () => {
    const fetchMock = vi.fn(async () => reply(200, { routes: [{ distanceMeters: 3214 }] }));
    const provider = new GoogleRoutesProvider("SERVER-KEY", fetchMock as never);
    const meters = await provider.driveDistanceMeters(IBADAN, OJA_BA);

    expect(meters).toBe(3214);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("SERVER-KEY");
    expect(headers["X-Goog-FieldMask"]).toBe("routes.distanceMeters");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      origin: { location: { latLng: { latitude: IBADAN.lat, longitude: IBADAN.lng } } },
      destination: { location: { latLng: { latitude: OJA_BA.lat, longitude: OJA_BA.lng } } },
      travelMode: "DRIVE",
    });
  });

  it("turns an HTTP error into a safe 503 and never shows the provider's message or key to the shopper", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new GoogleRoutesProvider("SERVER-KEY", (async () => reply(403, "API key SERVER-KEY is restricted")) as never);
    const err = await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(err.message).not.toContain("SERVER-KEY");
    expect(err.message).toMatch(/could not work out the delivery distance/);
    vi.restoreAllMocks();
  });

  it("turns a network failure or timeout into the same safe 503", async () => {
    const provider = new GoogleRoutesProvider("K", (async () => {
      throw new Error("ETIMEDOUT");
    }) as never);
    expect(await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e)).toMatchObject({ status: 503 });
  });

  it("aborts a request that hangs past the timeout", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as never;
    const provider = new GoogleRoutesProvider("K", hang, 30);
    const started = Date.now();
    expect(await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e)).toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports 'no driving route' as a 422 the shopper can act on", async () => {
    for (const body of [{}, { routes: [] }, { routes: [{}] }, { routes: [{ distanceMeters: "far" }] }]) {
      const provider = new GoogleRoutesProvider("K", (async () => reply(200, body)) as never);
      const err = await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e);
      expect(err, JSON.stringify(body)).toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      expect(err.message).toMatch(/driving route/);
    }
  });

  it("treats a non-JSON 200 as no route rather than crashing", async () => {
    const provider = new GoogleRoutesProvider("K", (async () => reply(200, "<html>oops</html>")) as never);
    expect(await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e)).toMatchObject({ status: 422 });
  });
});

describe("CachedDistanceProvider", () => {
  const counting = (meters = 4321) => {
    const inner = { calls: 0, async driveDistanceMeters() { this.calls++; return meters; } };
    return inner;
  };

  it("asks the inner provider once and serves repeats from the cache", async () => {
    const inner = counting();
    const cached = new CachedDistanceProvider(inner);
    expect(await cached.driveDistanceMeters(IBADAN, OJA_BA)).toBe(4321);
    expect(await cached.driveDistanceMeters(IBADAN, OJA_BA)).toBe(4321);
    expect(await cached.driveDistanceMeters(IBADAN, OJA_BA)).toBe(4321);
    expect(inner.calls).toBe(1);
    expect(await DistanceCache.countDocuments()).toBe(1);
  });

  it("treats coordinates that differ by less than about a metre as the same place", async () => {
    const inner = counting();
    const cached = new CachedDistanceProvider(inner);
    await cached.driveDistanceMeters(IBADAN, OJA_BA);
    await cached.driveDistanceMeters({ lat: IBADAN.lat + 0.000001, lng: IBADAN.lng }, OJA_BA);
    expect(inner.calls).toBe(1);
  });

  it("treats a genuinely different route, or the reverse direction, as a separate lookup", async () => {
    const inner = counting();
    const cached = new CachedDistanceProvider(inner);
    await cached.driveDistanceMeters(IBADAN, OJA_BA);
    await cached.driveDistanceMeters(OJA_BA, IBADAN); // one-way streets can differ
    await cached.driveDistanceMeters(IBADAN, { lat: OJA_BA.lat + 0.01, lng: OJA_BA.lng });
    expect(inner.calls).toBe(3);
    expect(cacheKey(IBADAN, OJA_BA)).not.toBe(cacheKey(OJA_BA, IBADAN));
  });

  it("never caches a failure, so the next request tries again", async () => {
    let n = 0;
    const flaky = { async driveDistanceMeters() { if (n++ === 0) throw new Error("down"); return 999; } };
    const cached = new CachedDistanceProvider(flaky);
    await expect(cached.driveDistanceMeters(IBADAN, OJA_BA)).rejects.toThrow("down");
    expect(await cached.driveDistanceMeters(IBADAN, OJA_BA)).toBe(999);
    expect(await DistanceCache.countDocuments()).toBe(1);
  });

  it("has a TTL index so stale distances expire after 30 days", async () => {
    await DistanceCache.init();
    const indexes = await DistanceCache.collection.indexes();
    expect(indexes.find((i) => i.key.fetchedAt === 1)?.expireAfterSeconds).toBe(60 * 60 * 24 * 30);
  });
});

describe("DevStraightLineProvider", () => {
  it("is a rough road estimate: straight line times 1.3", async () => {
    const meters = await new DevStraightLineProvider().driveDistanceMeters(IBADAN, OJA_BA);
    expect(meters).toBeCloseTo(haversineKm(IBADAN, OJA_BA) * 1300, -1);
    expect(Number.isInteger(meters)).toBe(true);
  });
});

describe("pricing settings", () => {
  it("creates the defaults on first read: N200 per km, no minimum, 10%", async () => {
    expect(await getPricing()).toEqual({ pricePerKmKobo: 20000, minDeliveryFeeKobo: null, commissionBps: 1000 });
  });

  it("stays a single document even when read concurrently", async () => {
    await Promise.all(Array.from({ length: 10 }, () => getPricing()));
    expect(await Settings.countDocuments()).toBe(1);
  });

  it("returns what the admin saved", async () => {
    await getPricing();
    await Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 25000, minDeliveryFeeKobo: 50000, commissionBps: 1250 });
    expect(await getPricing()).toEqual({ pricePerKmKobo: 25000, minDeliveryFeeKobo: 50000, commissionBps: 1250 });
  });

  it("treats a missing minimum (null) as valid, since 'no minimum' is the normal state", async () => {
    await getPricing();
    await expect(Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: null }, { runValidators: true })).resolves.toBeTruthy();
    await expect(Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: 50000 }, { runValidators: true })).resolves.toBeTruthy();
    await expect(Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: 500.5 }, { runValidators: true })).rejects.toThrow();
  });

  it("refuses fractional or out-of-range values at the model level", async () => {
    await getPricing();
    await expect(Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 200.5 }, { runValidators: true })).rejects.toThrow();
    await expect(Settings.updateOne({ key: "singleton" }, { commissionBps: 10001 }, { runValidators: true })).rejects.toThrow();
    await expect(Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: -1 }, { runValidators: true })).rejects.toThrow();
  });
});
