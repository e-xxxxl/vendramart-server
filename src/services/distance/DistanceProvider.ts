import type { LatLng } from "../../domain/geo.js";

/** Anything that can say how far it is to drive between two points. Google Routes in production. */
export interface DistanceProvider {
  /** Road distance in metres from `origin` to `destination`. */
  driveDistanceMeters(origin: LatLng, destination: LatLng): Promise<number>;
}
