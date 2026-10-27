import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { CachedDistanceProvider } from "./CachedDistanceProvider.js";
import { DevStraightLineProvider } from "./DevStraightLineProvider.js";
import { GoogleRoutesProvider } from "./GoogleRoutesProvider.js";
let override;
let cached;
/** Tests swap in a fake with fixed distances. */
export function setDistanceProvider(provider) {
    override = provider;
}
export function getDistanceProvider() {
    if (override)
        return override;
    if (cached)
        return cached;
    if (env.GOOGLE_MAPS_SERVER_KEY) {
        cached = new CachedDistanceProvider(new GoogleRoutesProvider(env.GOOGLE_MAPS_SERVER_KEY));
    }
    else if (!isProd) {
        cached = new DevStraightLineProvider(); // not cached, so adding a real key later recomputes
    }
    else {
        // Fail loudly rather than quietly charging customers from a guess.
        cached = {
            async driveDistanceMeters() {
                throw AppError.unavailable("Delivery pricing is not configured");
            },
        };
    }
    return cached;
}
