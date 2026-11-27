import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { PAYOUT_STATUSES } from "../../domain/payoutStateMachine.js";
import { netEarningKobo } from "../../domain/returns.js";
import { singleFile } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import { Payout, PAYOUT_SOURCES, presentPayout, type PayoutDoc, type PayoutSource } from "../../models/Payout.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { lagosRange, MAX_EXPORT_DAYS, payoutCsv } from "../../domain/payoutExport.js";
import { dueByVendor, loadEarnings } from "../earnings/earnings.service.js";
import { declinePayout, payPayout, releaseBlocker, releaseDuePayouts } from "./payouts.service.js";

// Mounted under /api/admin/payouts, behind requireRole("ADMIN").
export const adminPayoutsRouter = Router();

/**
 * The vendor's whole position in one place, so the person paying never has to guess what is left: what is ready to be paid, what
 * is already in a payout waiting to be paid (so it can not be credited twice), what is still in the hold, and what was paid.
 * `owedKobo` is everything earned and not yet paid: ready + in a payout + on hold.
 */
async function vendorBalances(vendorIds: Types.ObjectId[], now: Date) {
  const entries = await Promise.all(
    vendorIds.map(async (id) => {
      const { summary } = await loadEarnings(id, now);
      return [
        String(id),
        {
          readyKobo: summary.availableKobo,
          inPayoutKobo: summary.requestedKobo,
          onHoldKobo: summary.onHoldKobo,
          awaitingDeliveryKobo: summary.awaitingKobo,
          paidKobo: summary.paidKobo,
          owedKobo: summary.availableKobo + summary.requestedKobo + summary.onHoldKobo,
        },
      ] as const;
    }),
  );
  return new Map(entries);
}

async function listRows(payouts: PayoutDoc[]) {
  const ids = [...new Set(payouts.map((p) => String(p.vendorId)))].map((i) => new Types.ObjectId(i));
  const [vendors, balances] = await Promise.all([Vendor.find({ _id: { $in: ids } }).select("businessName slug"), vendorBalances(ids, new Date())]);
  const byId = new Map(vendors.map((v) => [String(v._id), v]));
  return payouts.map((p) => ({
    ...presentPayout(p),
    vendor: { id: String(p.vendorId), businessName: byId.get(String(p.vendorId))?.businessName ?? "Vendor" },
    balance: balances.get(String(p.vendorId)) ?? null,
  }));
}

// A payout from before `source` existed has none and was asked for by the vendor.
const sourceFilter = (source: PayoutSource): Record<string, unknown> => (source === "ADMIN_RELEASE" ? { source: "ADMIN_RELEASE" } : { source: { $ne: "ADMIN_RELEASE" } });

adminPayoutsRouter.get(
  "/",
  validate({ query: pagination.extend({ status: z.enum(PAYOUT_STATUSES).default("REQUESTED"), source: z.enum(PAYOUT_SOURCES).optional() }) }),
  asyncHandler(async (req, res) => {
    const { status, source, page, limit } = req.validated.query as { status: (typeof PAYOUT_STATUSES)[number]; source?: PayoutSource; page: number; limit: number };
    const filter: Record<string, unknown> = { status, ...(source ? sourceFilter(source) : {}) };
    const [rows, total, counts, requestedByVendors, released] = await Promise.all([
      // Oldest first for the pending queue (first come, first paid), newest first for the history tabs.
      Payout.find(filter)
        .sort({ requestedAt: status === "REQUESTED" ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Payout.countDocuments(filter),
      Promise.all(PAYOUT_STATUSES.map(async (s) => [s, await Payout.countDocuments({ status: s })] as const)),
      Payout.countDocuments({ status: "REQUESTED", ...sourceFilter("VENDOR_REQUEST") }),
      Payout.countDocuments({ status: "REQUESTED", ...sourceFilter("ADMIN_RELEASE") }),
    ]);
    ok(res, { counts: { ...Object.fromEntries(counts), requestedByVendors, released }, payouts: await listRows(rows) }, { page, limit, total });
  }),
);

/**
 * Earnings that are ready to be paid, vendor by vendor, with no one having to ask: the hold is over, no return is open and
 * refunds are already taken off. Worked out from the delivery times each time it is opened. Releasing makes them a payout.
 */
adminPayoutsRouter.get(
  "/due",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const due = await dueByVendor(now);
    const ids = due.map((d) => d.vendorId);
    const [vendors, balances] = await Promise.all([Vendor.find({ _id: { $in: ids } }).select("businessName status bank"), vendorBalances(ids, now)]);
    const byId = new Map(vendors.map((v) => [String(v._id), v]));
    const rows = due.flatMap((d) => {
      const vendor = byId.get(String(d.vendorId));
      if (!vendor) return [];
      const blockedReason = releaseBlocker(vendor);
      return [
        {
          vendor: { id: String(d.vendorId), businessName: vendor.businessName },
          deliveries: d.deliveries,
          dueKobo: d.netKobo,
          oldestDeliveredAt: d.oldestDeliveredAt,
          canRelease: !blockedReason,
          blockedReason,
          balance: balances.get(String(d.vendorId))!,
        },
      ];
    });
    ok(res, { rows, totalKobo: rows.reduce((n, r) => n + r.dueKobo, 0), releasableKobo: rows.filter((r) => r.canRelease).reduce((n, r) => n + r.dueKobo, 0) });
  }),
);

/** Release the ready earnings of the chosen vendors (or of everyone with something due). Each becomes a payout to pay. */
adminPayoutsRouter.post(
  "/release",
  validate({ body: z.object({ vendorIds: z.array(objectId).min(1).max(500).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const result = await releaseDuePayouts(req.user!, req.validated.body.vendorIds ?? null);
    console.info(`Admin ${req.user!._id} released ${result.released.length} payouts (${result.skipped.length} skipped)`);
    ok(res, result);
  }),
);

// The bank instruction file. The person in charge picks the days (on the Lagos clock, both included) and which payouts, and
// downloads a CSV with the account to pay, the amount and a narration, one row per payout. Requested date is what is filtered.
const exportQuery = z.object({
  from: z.string().min(1, "Choose the first day"),
  to: z.string().min(1, "Choose the last day"),
  status: z.enum([...PAYOUT_STATUSES, "ALL"]).default("REQUESTED"),
});
const EXPORT_LIMIT = 5000;

async function exportRows(query: z.infer<typeof exportQuery>) {
  const range = lagosRange(query.from, query.to);
  if (!range) {
    throw AppError.validation("Choose real days, with the first day not after the last, and no more than a year apart", [
      { path: "from", message: `Pick a first and last day, at most ${MAX_EXPORT_DAYS} days apart` },
    ]);
  }
  const filter = { requestedAt: { $gte: range.start, $lt: range.end }, ...(query.status === "ALL" ? {} : { status: query.status }) };
  const payouts = await Payout.find(filter).sort({ requestedAt: 1 }).limit(EXPORT_LIMIT + 1);
  if (payouts.length > EXPORT_LIMIT) throw AppError.validation(`That is more than ${EXPORT_LIMIT} payouts. Choose a shorter range.`, [{ path: "from", message: "Choose a shorter range" }]);
  const vendors = await Vendor.find({ _id: { $in: payouts.map((p) => p.vendorId) } }).select("businessName");
  const name = new Map(vendors.map((v) => [String(v._id), v.businessName]));
  return payouts.map((p) => ({
    number: p.number,
    vendor: name.get(String(p.vendorId)) ?? "Vendor",
    bankName: p.bank!.bankName,
    accountNumber: p.bank!.accountNumber,
    accountName: p.bank!.accountName,
    amountKobo: p.amountKobo,
    requestedAt: p.requestedAt,
    status: p.status,
    paidAt: presentPayout(p).paidAt, // when it was paid, for a paid payout; an older one falls back on when it was decided
  }));
}

/** How many payouts and how much the file would hold, so the person can check before downloading. */
adminPayoutsRouter.get(
  "/export/summary",
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    const rows = await exportRows(req.validated.query as z.infer<typeof exportQuery>);
    ok(res, { count: rows.length, totalKobo: rows.reduce((n, r) => n + r.amountKobo, 0) });
  }),
);

adminPayoutsRouter.get(
  "/export",
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof exportQuery>;
    const rows = await exportRows(q);
    console.info(`Admin ${req.user!._id} exported ${rows.length} ${q.status} payouts from ${q.from} to ${q.to}`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="vendramart-payouts-${q.from}-to-${q.to}.csv"`);
    res.setHeader("Cache-Control", "no-store"); // it holds bank account numbers
    res.send(payoutCsv(rows));
  }),
);

adminPayoutsRouter.get(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const payout = await Payout.findById(req.validated.params.id);
    if (!payout) throw AppError.notFound("Payout not found");
    const [vendor, subs, decider, balances] = await Promise.all([
      Vendor.findById(payout.vendorId),
      SubOrder.find({ _id: { $in: payout.subOrderIds } }).sort({ deliveredAt: -1 }),
      payout.resolvedBy ? User.findById(payout.resolvedBy).select("name") : Promise.resolve(null),
      vendorBalances([payout.vendorId], new Date()),
    ]);
    ok(res, {
      ...presentPayout(payout),
      // The vendor's whole position now, so a payout is never approved without seeing what else is owed or already in payouts.
      balance: balances.get(String(payout.vendorId)) ?? null,
      vendor: { id: String(payout.vendorId), businessName: vendor?.businessName ?? "Vendor" },
      // Who paid it (or declined it), for the admin's own record. Not shown to the vendor.
      resolvedBy: decider ? { id: String(decider._id), name: decider.name } : null,
      // The admin needs the full account number to make the transfer. This is the only place it is returned.
      bank: { bankName: payout.bank!.bankName, accountNumber: payout.bank!.accountNumber, accountName: payout.bank!.accountName },
      orders: subs.map((s) => ({ id: String(s._id), ref: s.ref, deliveredAt: s.deliveredAt ?? null, earnKobo: netEarningKobo(s.vendorEarningKobo, s.returnedEarningKobo) })),
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
