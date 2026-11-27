import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PAYOUT_STATUSES } from "../domain/payoutStateMachine.js";

const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };

export const PAYOUT_SOURCES = ["VENDOR_REQUEST", "ADMIN_RELEASE"] as const;
export type PayoutSource = (typeof PAYOUT_SOURCES)[number];

// One vendor withdrawal. Requesting it locks the included sub-orders (SubOrder.payoutId). The admin pays it
// manually and uploads the transfer receipt, or declines it with a reason, which releases the orders again.
const payoutSchema = new Schema(
  {
    number: { type: String, required: true, unique: true }, // PR-2291
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Sum of the included sub-orders' vendorEarningKobo, in kobo. Delivery fees are never part of it.
    amountKobo: { type: Number, required: true, min: 1, validate: isInt },
    subOrderIds: [{ type: Schema.Types.ObjectId, ref: "SubOrder" }],
    // The account the money goes to, frozen at request time. Editing the vendor's bank details later does not redirect it.
    bank: {
      bankName: { type: String, required: true },
      accountNumber: { type: String, required: true },
      accountName: { type: String, required: true },
    },
    status: { type: String, enum: PAYOUT_STATUSES, default: "REQUESTED", index: true },
    // Who started it: the vendor asked for it, or the admin released the earnings that were ready. A payout from before this
    // existed has no source and was asked for by the vendor.
    source: { type: String, enum: PAYOUT_SOURCES, default: "VENDOR_REQUEST" },
    requestedAt: { type: Date, default: Date.now },
    // When the admin decided it (paid or declined), and who. For a paid payout `paidAt` is the same moment: the date and time
    // the transfer was recorded as done. A payout paid before `paidAt` existed has only `resolvedAt`, which presentPayout falls back on.
    resolvedAt: Date,
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    paidAt: Date,
    // Private: opened only through GET /api/payouts/:id/receipt by the owning vendor or an admin.
    receipt: {
      publicId: String,
      mime: String,
      resourceType: String,
    },
    declineReason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

payoutSchema.index({ vendorId: 1, requestedAt: -1 });

export type PayoutAttrs = InferSchemaType<typeof payoutSchema>;
export type PayoutDoc = HydratedDocument<PayoutAttrs>;
export const Payout = model("Payout", payoutSchema);

/** What the vendor sees of their own payout. The receipt is a link to an access-checked route, never a storage URL. */
export const presentPayout = (p: PayoutDoc) => ({
  id: String(p._id),
  number: p.number,
  amountKobo: p.amountKobo,
  orderCount: p.subOrderIds.length,
  status: p.status,
  // VENDOR_REQUEST: the vendor asked for it. ADMIN_RELEASE: the admin released earnings that were ready.
  source: (p.source ?? "VENDOR_REQUEST") as PayoutSource,
  requestedAt: p.requestedAt,
  resolvedAt: p.resolvedAt ?? null,
  // The date and time the payout was paid. Only for a paid payout; an older one falls back on when it was decided.
  paidAt: p.status === "PAID" ? (p.paidAt ?? p.resolvedAt ?? null) : null,
  declineReason: p.declineReason ?? null,
  receiptUrl: p.status === "PAID" && p.receipt?.publicId ? `/api/payouts/${p._id}/receipt` : null,
});
