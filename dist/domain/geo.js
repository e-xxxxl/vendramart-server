// Pure geography helpers. No I/O.
const EARTH_RADIUS_KM = 6371.0088;
const rad = (deg) => (deg * Math.PI) / 180;
/** Great-circle distance in km. */
export function haversineKm(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
/**
 * Which city a point belongs to: the cities whose radius contains it, and if several overlap,
 * the one whose centre is nearest. Null if the point is in none.
 */
export function resolveCity(cities, point) {
    let best = null;
    for (const city of cities) {
        const km = haversineKm(city.center, point);
        if (km <= city.radiusKm && (!best || km < best.km))
            best = { city, km };
    }
    return best?.city ?? null;
}
