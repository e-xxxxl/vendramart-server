import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex } from "../../utils/zodCommon.js";
import { Order } from "../../models/Order.js";
import { Payout } from "../../models/Payout.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminSearchRouter = Router();
const PER_KIND = 5;
/** One box that finds orders, stores, customers and payout requests. Each hit says where it opens. */
adminSearchRouter.get("/search", validate({ query: z.object({ q: z.string().trim().min(2, "Type at least 2 characters").max(100) }) }), asyncHandler(async (req, res) => {
    const rx = new RegExp(escapeRegex(req.validated.query.q), "i");
    const [orders, vendors, customers, payouts] = await Promise.all([
        Order.find({ $or: [{ orderNumber: rx }, { "customer.name": rx }, { "customer.email": rx }] }).sort({ createdAt: -1 }).limit(PER_KIND),
        Vendor.find({ $or: [{ businessName: rx }, { email: rx }, { ownerName: rx }] }).sort({ createdAt: -1 }).limit(PER_KIND),
        User.find({ role: "CUSTOMER", $or: [{ name: rx }, { email: rx }] }).sort({ createdAt: -1 }).limit(PER_KIND),
        Payout.find({ number: rx }).sort({ requestedAt: -1 }).limit(PER_KIND),
    ]);
    const payoutVendors = await Vendor.find({ _id: { $in: payouts.map((p) => p.vendorId) } }).select("businessName");
    const vendorName = new Map(payoutVendors.map((v) => [String(v._id), v.businessName]));
    ok(res, {
        orders: orders.map((o) => ({ id: String(o._id), title: o.orderNumber, sub: `${o.customer?.name ?? "Customer"} · ${o.status}`, href: `/admin/orders?id=${o._id}` })),
        vendors: vendors.map((v) => ({ id: String(v._id), title: v.businessName, sub: `${v.ownerName} · ${v.status}`, href: `/admin/vendors?id=${v._id}` })),
        customers: customers.map((u) => ({ id: String(u._id), title: u.name, sub: u.email, href: `/admin/customers?q=${encodeURIComponent(u.email)}` })),
        payouts: payouts.map((p) => ({ id: String(p._id), title: p.number, sub: `${vendorName.get(String(p.vendorId)) ?? "Vendor"} · ${p.status}`, href: `/admin/payouts?tab=${p.status === "PAID" ? "paid" : p.status === "DECLINED" ? "declined" : "pending"}&id=${p._id}` })),
    });
}));
