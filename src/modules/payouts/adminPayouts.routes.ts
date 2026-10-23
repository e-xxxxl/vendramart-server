import { Router } from "express";
import { z } from "zod";
import { PAYOUT_STATUSES } from "../../domain/payoutStateMachine.js";
import { singleFile } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import { Payout, presentPayout, type PayoutDoc } from "../../models/Payout.js";
import { SubOrder } from "../../models/SubOrder.js";
import { Vendor } from "../../models/Vendor.js";
import { declinePayout, payPayout } from "./payouts.service.js";

// Mounted under /api/admin/payouts, behind requireRole("ADMIN").
export const adminPayoutsRouter = Router();

async function listRows(payouts: PayoutDoc[]) {
  const vendors = await Vendor.find({ _id: { $in: payouts.map((p) => p.vendorId) } }).select("businessName slug");
  const byId = new Map(vendors.map((v) => [String(v._id), v]));
  return payouts.map((p) => ({ ...presentPayout(p), vendor: { id: String(p.vendorId), businessName: byId.get(String(p.vendorId))?.businessName ?? "Vendor" } }));
}

adminPayoutsRouter.get(
  "/",
  validate({ query: pagination.extend({ status: z.enum(PAYOUT_STATUSES).default("REQUESTED") }) }),
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.validated.query as { status: (typeof PAYOUT_STATUSES)[number]; page: number; limit: number };
    const filter = { status };
    const [rows, total, counts] = await Promise.all([
      // Oldest first for the pending queue (first come, first paid), newest first for the history tabs.
      Payout.find(filter)
        .sort({ requestedAt: status === "REQUESTED" ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Payout.countDocuments(filter),
      Promise.all(PAYOUT_STATUSES.map(async (s) => [s, await Payout.countDocuments({ status: s })] as const)),
    ]);
    ok(res, { counts: Object.fromEntries(counts), payouts: await listRows(rows) }, { page, limit, total });
  }),
);

adminPayoutsRouter.get(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const payout = await Payout.findById(req.validated.params.id);
    if (!payout) throw AppError.notFound("Payout not found");
    const [vendor, subs] = await Promise.all([Vendor.findById(payout.vendorId), SubOrder.find({ _id: { $in: payout.subOrderIds } }).sort({ deliveredAt: -1 })]);
    ok(res, {
      ...presentPayout(payout),
      vendor: { id: String(payout.vendorId), businessName: vendor?.businessName ?? "Vendor" },
      // The admin needs the full account number to make the transfer. This is the only place it is returned.
      bank: { bankName: payout.bank!.bankName, accountNumber: payout.bank!.accountNumber, accountName: payout.bank!.accountName },
      orders: subs.map((s) => ({ id: String(s._id), ref: s.ref, deliveredAt: s.deliveredAt ?? null, earnKobo: s.vendorEarningKobo })),
    });
  }),
);

adminPayoutsRouter.post(
  "/:id/pay",
  singleFile,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.validation("Upload the transfer receipt first", [{ path: "file", message: "Upload the transfer receipt" }]);
    const paid = await payPayout(req.validated.params.id, req.user!, { buffer: req.file.buffer });
    ok(res, presentPayout(paid));
  }),
);

adminPayoutsRouter.post(
  "/:id/decline",
  validate({ params: z.object({ id: objectId }), body: z.object({ reason: z.string().trim().min(3, "Give a reason the vendor will understand").max(300) }).strict() }),
  asyncHandler(async (req, res) => {
    ok(res, presentPayout(await declinePayout(req.validated.params.id, req.user!, req.validated.body.reason)));
  }),
);
