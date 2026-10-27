import { Schema, model } from "mongoose";
// One row per distinct payment event we have accepted. The unique eventKey is the idempotency lock:
// Paystack retries and duplicates all collapse onto the same row.
const webhookEventSchema = new Schema({
    eventKey: { type: String, required: true, unique: true }, // `${event}:${reference}`
    provider: { type: String, default: "paystack" },
    type: { type: String, required: true },
    reference: { type: String, index: true },
    receivedAt: { type: Date, default: Date.now },
    processedAt: Date,
    outcome: String,
});
export const WebhookEvent = model("WebhookEvent", webhookEventSchema);
