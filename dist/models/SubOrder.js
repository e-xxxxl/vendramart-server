import { Schema, model } from "mongoose";
import { ORDER_STATUSES } from "../domain/orderStateMachine.js";
const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };
// Optional amounts (such as "no minimum delivery fee") are null, which must stay valid.
const isIntOrNull = { validator: (v) => v === null || v === undefined || Number.isInteger(v), message: "{PATH} must be a whole number or empty" };
const kobo = { type: Number, required: true, min: 0, validate: isInt };
// One vendor's part of an order: its own items, its own delivery leg and fee, its own status.
const subOrderSchema = new Schema({
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderNumber: { type: String, required: true }, // the parent's VM-10001
    ref: { type: String, required: true, unique: true }, // VM-10001-A
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    handlerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: { type: String, enum: ORDER_STATUSES, default: "PENDING_PAYMENT", index: true },
    // Item names and prices are copied at purchase time; the product can change or vanish later.
    items: [
        {
            _id: false,
            productId: { type: Schema.Types.ObjectId, required: true },
            name: { type: String, required: true },
            image: String,
            unitPriceKobo: kobo,
            qty: { type: Number, required: true, min: 1, validate: isInt },
            lineTotalKobo: kobo,
            commissionKobo: kobo,
            vendorEarningKobo: kobo,
        },
    ],
    itemsTotalKobo: kobo,
    commissionBps: { type: Number, required: true, min: 0, max: 10000, validate: isInt },
    commissionTotalKobo: kobo,
    // Goods price minus commission. The delivery fee is NOT part of it.
    vendorEarningKobo: kobo,
    delivery: {
        pickup: { line: { type: String, required: true }, lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        dropoff: { line: { type: String, required: true }, landmark: String, lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        distanceMeters: kobo, // road distance as billed (snapped to 0.1 km)
        pricePerKmKobo: kobo,
        minFeeKobo: { type: Number, min: 0, validate: isIntOrNull, default: null },
        minFeeApplied: { type: Boolean, default: false },
        feeKobo: kobo,
    },
    paidAt: Date,
    deliveredAt: Date, // starts the earnings hold (4 working days) (Phase 6)
    completedAt: Date,
    // The payout this sub-order's earnings are locked in. Unset when free. Set atomically when a payout is requested.
    payoutId: { type: Schema.Types.ObjectId, ref: "Payout", index: true },
    payoutLockedAt: Date,
    failureReason: String,
}, { timestamps: true });
export const SubOrder = model("SubOrder", subOrderSchema);
