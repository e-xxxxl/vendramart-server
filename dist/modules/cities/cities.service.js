import { City, cityArea } from "../../models/City.js";
import { resolveCity } from "../../domain/geo.js";
import { AppError } from "../../utils/AppError.js";
/** The city whose radius contains the point, or null. Active or not. */
export async function findCityForPoint(point) {
    const cities = (await City.find()).map(cityArea);
    return resolveCity(cities, point)?.doc ?? null;
}
/**
 * Used wherever a pin must land inside a city we operate in (vendor pickup, and later checkout).
 * Distinguishes "not in any known city" from "in a city that is coming soon".
 */
export async function requireActiveCityForPoint(point, what) {
    const city = await findCityForPoint(point);
    if (!city)
        throw AppError.validation(`That ${what} is outside the cities we serve yet`);
    if (!city.isActive)
        throw AppError.validation(`${city.name} is coming soon. We are only live in Ibadan for now`);
    return city;
}
