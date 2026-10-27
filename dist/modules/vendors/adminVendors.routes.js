import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { Product } from "../../models/Product.js";
import { Vendor, VENDOR_STATUSES } from "../../models/Vendor.js";
import { suspendSchema } from "./vendor.schemas.js";
// Mounted under /api/admin/vendors, so the ADMIN role check has already run.
export const adminVendorsRouter = Router();
/** Admin sees everything needed to review a store, including CAC and the full account number. */
const present = (v, productCount) => ({
    id: String(v._id),
    slug: v.slug,
    businessName: v.businessName,
    ownerName: v.ownerName,
    email: v.email,
    phone: v.phone,
    cacNumber: v.cacNumber ?? null,
    description: v.description ?? null,
    status: v.status,
    statusReason: v.statusReason ?? null,
    approvedAt: v.approvedAt ?? null,
    createdAt: v.createdAt,
    bank: { bankName: v.bank.bankName, accountNumber: v.bank.accountNumber, accountName: v.bank.accountName },
    pickup: { line: v.pickup.line, lat: v.pickup.lat, lng: v.pickup.lng, cityId: String(v.pickup.cityId) },
    ...(productCount === undefined ? {} : { productCount }),
});
adminVendorsRouter.get("/", validate({ query: pagination.extend({ status: z.enum(VENDOR_STATUSES).optional(), q: z.string().trim().max(100).optional() }) }), asyncHandler(async (req, res) => {
    const { page, limit, status, q } = req.validated.query;
    const filter = {};
    if (status)
        filter.status = status;
    if (q)
        filter.businessName = new RegExp(escapeRegex(q), "i");
    const [items, total] = await Promise.all([
        Vendor.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Vendor.countDocuments(filter),
    ]);
    ok(res, items.map((v) => present(v)), { page, limit, total });
}));
async function findVendor(id) {
    const vendor = await Vendor.findById(id);
    if (!vendor)
        throw AppError.notFound("Vendor not found");
    return vendor;
}
adminVendorsRouter.get("/:id", validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    ok(res, present(vendor, await Product.countDocuments({ vendorId: vendor._id })));
}));
// Approving also reinstates a suspended store.
adminVendorsRouter.post("/:id/approve", validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    vendor.status = "APPROVED";
    vendor.statusReason = undefined;
    vendor.approvedAt = vendor.approvedAt ?? new Date();
    await vendor.save();
    ok(res, present(vendor));
}));
adminVendorsRouter.post("/:id/suspend", validate({ params: z.object({ id: objectId }), body: suspendSchema }), asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    vendor.status = "SUSPENDED";
    vendor.statusReason = req.validated.body.reason;
    await vendor.save();
    ok(res, present(vendor));
}));
