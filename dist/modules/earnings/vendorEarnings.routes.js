import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { pagination } from "../../utils/zodCommon.js";
import { maskAccount } from "../../models/Vendor.js";
import { Payout, presentPayout } from "../../models/Payout.js";
import { getVendorForUser } from "../vendors/vendor.service.js";
import { requestPayout } from "../payouts/payouts.service.js";
import { loadEarnings, toRows } from "./earnings.service.js";
// Mounted under /api/vendor, behind requireRole("VENDOR"). Everything is scoped to the signed-in vendor.
export const vendorEarningsRouter = Router();
const paged = pagination.extend({ limit: z.coerce.number().int().min(1).max(48).default(20) });
vendorEarningsRouter.get("/earnings", validate({ query: paged }), asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user._id);
    const { page, limit } = req.validated.query;
    const now = new Date();
    const { subs, results, summary } = await loadEarnings(vendor._id, now);
    const allRows = toRows(subs, results);
    const payouts = await Payout.find({ vendorId: vendor._id }).sort({ requestedAt: -1 }).limit(20);
    ok(res, {
        now: now.toISOString(), // lets the browser count down against the server's clock, not its own
        summary,
        bank: { bankName: vendor.bank.bankName, accountName: vendor.bank.accountName, accountMasked: maskAccount(vendor.bank.accountNumber) },
        pickupLine: vendor.pickup.line,
        rows: allRows.slice((page - 1) * limit, page * limit),
        payouts: payouts.map(presentPayout),
    }, { page, limit, total: allRows.length });
}));
vendorEarningsRouter.get("/payouts", asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user._id);
    ok(res, (await Payout.find({ vendorId: vendor._id }).sort({ requestedAt: -1 }).limit(50)).map(presentPayout));
}));
// strict({}): the amount is always worked out on the server from the orders, never sent by the browser.
vendorEarningsRouter.post("/payouts", validate({ body: z.object({}).strict() }), asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user._id);
    if (vendor.status === "SUSPENDED")
        throw AppError.forbidden("Your store is suspended. Contact support.");
    created(res, presentPayout(await requestPayout(vendor, req.user)));
}));
