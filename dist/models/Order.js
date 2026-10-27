import { Schema, model } from "mongoose";
const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };
// Optional amounts (such as "no minimum delivery fee") are null, which must stay valid.
const isIntOrNull = { validator: (v) => v === null || v === undefined || Number.isInteger(v), message: "{PATH} must be a whole number or empty" };
const kobo = { type: Number, required: true, min: 0, validate: isInt };
// The customer's single checkout and single Paystack payment. Fulfilment status lives on each SubOrder.
export const ORDER_PAYMENT_STATUSES = ["PENDING_PAYMENT", "PAID", "CANCELLED"];
const orderSchema = new Schema({
    orderNumber: { type: String, required: true, unique: true }, // VM-10001
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customer: { name: String, email: String, phone: String },
    // Where it goes, frozen at purchase time. Editing the address book later changes nothing here.
    deliveryAddress: {
        label: String,
        line: { type: String, required: true },
        landmark: String,
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        cityId: { type: Schema.Types.ObjectId, ref: "City" },
        cityName: String,
    },
    itemsSubtotalKobo: kobo,
    deliveryTotalKobo: kobo,
    totalKobo: kobo,
    status: { type: String, enum: ORDER_PAYMENT_STATUSES, default: "PENDING_PAYMENT", index: true },
    // The admin settings that applied when this order was placed. Later changes never touch them.
    pricing: {
        pricePerKmKobo: { ...kobo },
        minDeliveryFeeKobo: { type: Number, min: 0, validate: isIntOrNull, default: null },
        commissionBps: { type: Number, required: true, min: 0, max: 10000, validate: isInt },
    },
    payment: {
        provider: { type: String, default: "paystack" },
        reference: { type: String, required: true, unique: true },
        amountKobo: { ...kobo },
        paystackId: String,
        channel: String,
        paidAt: Date,
    },
    expiresAt: { type: Date, required: true, index: true },
    // Raised when something needs a human, for example a payment that arrives after the order expired.
    needsAttention: { type: Boolean, default: false, index: true },
    attentionReason: String,
    // Set when an admin has dealt with it (for example refunded the customer in the Paystack dashboard).
    attentionResolvedAt: Date,
    attentionResolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    attentionNote: String,
}, { timestamps: true });
export const Order = model("Order", orderSchema);
