import { Schema, model } from "mongoose";
const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };
// Optional amounts (such as "no minimum delivery fee") are null, which must stay valid.
const isIntOrNull = { validator: (v) => v === null || v === undefined || Number.isInteger(v), message: "{PATH} must be a whole number or empty" };
// One document holds the platform pricing the admin controls (screen 04). Orders snapshot these
// values when they are placed, so editing them only affects new orders.
const settingsSchema = new Schema({
    key: { type: String, default: "singleton", unique: true, immutable: true },
    // N200 per km, in kobo.
    pricePerKmKobo: { type: Number, required: true, min: 0, validate: isInt, default: 20000 },
    // Optional floor for one delivery. Null means no minimum ("[Not set]" on the admin screen).
    minDeliveryFeeKobo: { type: Number, min: 0, validate: isIntOrNull, default: null },
    // Platform commission in basis points: 1000 = 10%.
    commissionBps: { type: Number, required: true, min: 0, max: 10000, validate: isInt, default: 1000 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });
export const Settings = model("Settings", settingsSchema);
/** Reads the pricing, creating the defaults (N200 per km, no minimum, 10%) on first use. Safe under concurrency. */
export async function getPricing() {
    const doc = await Settings.findOneAndUpdate({ key: "singleton" }, { $setOnInsert: { key: "singleton" } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
    return {
        pricePerKmKobo: doc.pricePerKmKobo,
        minDeliveryFeeKobo: doc.minDeliveryFeeKobo ?? null,
        commissionBps: doc.commissionBps,
    };
}
