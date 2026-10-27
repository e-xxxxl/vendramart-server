import { DistanceCache } from "../../models/DistanceCache.js";
// 5 decimal places is about 1 metre, far finer than a street address, so this only merges true repeats.
const round = (n) => n.toFixed(5);
export const cacheKey = (a, b) => `${round(a.lat)},${round(a.lng)}>${round(b.lat)},${round(b.lng)}`;
/** Remembers road distances for 30 days (TTL index on DistanceCache) so repeat routes cost nothing. */
export class CachedDistanceProvider {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    async driveDistanceMeters(origin, destination) {
        const key = cacheKey(origin, destination);
        const hit = await DistanceCache.findOne({ key });
        if (hit)
            return hit.meters;
        const meters = await this.inner.driveDistanceMeters(origin, destination);
        // A concurrent request may have just stored the same key; either value is fine.
        await DistanceCache.updateOne({ key }, { $set: { meters, fetchedAt: new Date() } }, { upsert: true }).catch(() => { });
        return meters;
    }
}
