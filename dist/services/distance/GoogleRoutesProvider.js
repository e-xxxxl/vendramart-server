import { AppError } from "../../utils/AppError.js";
const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
/**
 * Road distance from the Google Routes API (the successor to the legacy Distance Matrix API).
 * Called from the server only, with a server-side key that never reaches the browser.
 */
export class GoogleRoutesProvider {
    apiKey;
    fetchImpl;
    timeoutMs;
    constructor(apiKey, fetchImpl = fetch, timeoutMs = 8000) {
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    async driveDistanceMeters(origin, destination) {
        const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res;
        try {
            res = await this.fetchImpl(ENDPOINT, {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": this.apiKey,
                    // Ask only for the distance; a smaller field mask is cheaper and faster.
                    "X-Goog-FieldMask": "routes.distanceMeters",
                },
                body: JSON.stringify({
                    origin: point(origin),
                    destination: point(destination),
                    travelMode: "DRIVE",
                    routingPreference: "TRAFFIC_UNAWARE",
                    units: "METRIC",
                }),
            });
        }
        catch {
            throw AppError.unavailable("We could not work out the delivery distance right now. Please try again in a moment.");
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            // Log the provider's reason for the operator; never show it to the shopper (it can name the key or quota).
            const detail = await res.text().catch(() => "");
            console.error(`Google Routes API error ${res.status}: ${detail.slice(0, 300)}`);
            throw AppError.unavailable("We could not work out the delivery distance right now. Please try again in a moment.");
        }
        const json = (await res.json().catch(() => null));
        const meters = json?.routes?.[0]?.distanceMeters;
        if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) {
            // Google answered but found no drivable route (for example a pin on water).
            throw AppError.validation("We could not find a driving route to that address. Move the pin to a nearby road and try again.");
        }
        return meters;
    }
}
