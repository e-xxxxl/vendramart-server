import { haversineKm } from "../../domain/geo.js";
/**
 * Development and test stand-in used when no Google server key is set: straight-line distance
 * times 1.3, a rough allowance for roads. NEVER used in production (see index.ts), because it
 * would under- or over-charge customers.
 */
export class DevStraightLineProvider {
    async driveDistanceMeters(origin, destination) {
        return Math.round(haversineKm(origin, destination) * 1.3 * 1000);
    }
}
