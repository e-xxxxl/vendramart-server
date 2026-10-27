import { Schema, model } from "mongoose";
const counterSchema = new Schema({ name: { type: String, required: true, unique: true }, seq: { type: Number, required: true, default: 0 } });
export const Counter = model("Counter", counterSchema);
/**
 * Next number in a named sequence. `start` is the last number "used", so the first value returned is start + 1
 * (VendraMart order numbers start at VM-10001 with start = 10000).
 * Step 1 creates the counter once (a lost upsert race is harmless); step 2 is a single atomic $inc,
 * so two simultaneous callers can never receive the same number.
 */
export async function nextSeq(name, start = 0) {
    try {
        await Counter.updateOne({ name }, { $setOnInsert: { name, seq: start } }, { upsert: true });
    }
    catch (err) {
        if (err.code !== 11000)
            throw err; // another request created it first
    }
    const doc = await Counter.findOneAndUpdate({ name }, { $inc: { seq: 1 } }, { returnDocument: "after" });
    return doc.seq;
}
