import { Schema, model } from "mongoose";
const THIRTY_DAYS = 60 * 60 * 24 * 30;
// Cached road distances between two rounded points. Google bills per request, and the same vendor
// pickup to the same neighbourhood comes up again and again, so repeats are free.
const distanceCacheSchema = new Schema({
    key: { type: String, required: true, unique: true },
    meters: { type: Number, required: true, min: 0 },
    fetchedAt: { type: Date, default: Date.now, expires: THIRTY_DAYS },
});
export const DistanceCache = model("DistanceCache", distanceCacheSchema);
