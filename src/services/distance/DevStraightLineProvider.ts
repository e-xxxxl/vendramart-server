import { haversineKm, type LatLng } from "../../domain/geo.js";
import type { DistanceProvider } from "./DistanceProvider.js";

/**
 * Development and test stand-in used when no Google server key is set: straight-line distance
 * times 1.3, a rough allowance for roads. NEVER used in production (see index.ts), because it
 * would under- or over-charge customers.
 */
export class DevStraightLineProvider implements DistanceProvider {
  async driveDistanceMeters(origin: LatLng, destination: LatLng): Promise<number> {
    return Math.round(haversineKm(origin, destination) * 1.3 * 1000);
  }
}
