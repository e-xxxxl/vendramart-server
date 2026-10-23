import type { LatLng } from "../../domain/geo.js";
import { DistanceCache } from "../../models/DistanceCache.js";
import type { DistanceProvider } from "./DistanceProvider.js";

// 5 decimal places is about 1 metre, far finer than a street address, so this only merges true repeats.
const round = (n: number) => n.toFixed(5);
export const cacheKey = (a: LatLng, b: LatLng) => `${round(a.lat)},${round(a.lng)}>${round(b.lat)},${round(b.lng)}`;

/** Remembers road distances for 30 days (TTL index on DistanceCache) so repeat routes cost nothing. */
export class CachedDistanceProvider implements DistanceProvider {
  constructor(private inner: DistanceProvider) {}

  async driveDistanceMeters(origin: LatLng, destination: LatLng): Promise<number> {
    const key = cacheKey(origin, destination);
    const hit = await DistanceCache.findOne({ key });
    if (hit) return hit.meters;

    const meters = await this.inner.driveDistanceMeters(origin, destination);
    // A concurrent request may have just stored the same key; either value is fine.
    await DistanceCache.updateOne({ key }, { $set: { meters, fetchedAt: new Date() } }, { upsert: true }).catch(() => {});
    return meters;
  }
}
