import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { Order } from "../../models/Order.js";
import { Payout } from "../../models/Payout.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminOverviewRouter = Router();
/** Sub-order statuses that carry real sales (a cancelled or unpaid one earns the platform nothing). */
const COUNTED = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY", "DELIVERED", "COMPLETED"];
const TZ = "Africa/Lagos";
const DAY_MS = 86_400_000;
/** "2026-10-18" for a moment, as the calendar date in Lagos. */
const lagosDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
adminOverviewRouter.get("/overview", asyncHandler(async (_req, res) => {
    const now = new Date();
    // The window starts at the beginning of that calendar day in Lagos (UTC+1, no daylight saving), not 6x24h ago,
    // so an order paid early on the first day is counted in that day's bar.
    const since = new Date(`${lagosDay(new Date(now.getTime() - 6 * DAY_MS))}T00:00:00+01:00`);
    const [sales, commission, vendorCounts, customers, handlers, payouts, attention, needsHandler, inProgress, failed, daily] = await Promise.all([
        Order.aggregate([
            { $match: { status: "PAID" } },
            { $group: { _id: null, orders: { $sum: 1 }, grossKobo: { $sum: "$totalKobo" }, itemsKobo: { $sum: "$itemsSubtotalKobo" }, deliveryKobo: { $sum: "$deliveryTotalKobo" } } },
        ]),
        SubOrder.aggregate([{ $match: { status: { $in: COUNTED } } }, { $group: { _id: null, commissionKobo: { $sum: "$commissionTotalKobo" } } }]),
        Vendor.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
        User.countDocuments({ role: "CUSTOMER" }),
        User.countDocuments({ role: "HANDLER", isActive: true }),
        Payout.aggregate([{ $match: { status: "REQUESTED" } }, { $group: { _id: null, count: { $sum: 1 }, amountKobo: { $sum: "$amountKobo" } } }]),
        Order.countDocuments({ needsAttention: true }),
        SubOrder.countDocuments({ status: { $in: ["PAID", "READY_FOR_PICKUP", "FAILED_DELIVERY"] }, handlerId: null }),
        SubOrder.countDocuments({ status: { $in: ["PAID", "READY_FOR_PICKUP", "PICKED_UP"] } }),
        SubOrder.countDocuments({ status: "FAILED_DELIVERY" }),
        Order.aggregate([
            { $match: { status: "PAID", "payment.paidAt": { $gte: since } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$payment.paidAt", timezone: TZ } }, orders: { $sum: 1 }, grossKobo: { $sum: "$totalKobo" } } },
        ]),
    ]);
    // One row for each of the last 7 days, including days with no sales.
    const byDay = new Map(daily.map((d) => [d._id, d]));
    const last7Days = Array.from({ length: 7 }, (_, i) => {
        const date = lagosDay(new Date(now.getTime() - (6 - i) * DAY_MS));
        return { date, orders: byDay.get(date)?.orders ?? 0, grossKobo: byDay.get(date)?.grossKobo ?? 0 };
    });
    const vendorBy = new Map(vendorCounts.map((v) => [v._id, v.n]));
    ok(res, {
        sales: { orders: sales[0]?.orders ?? 0, grossKobo: sales[0]?.grossKobo ?? 0, itemsKobo: sales[0]?.itemsKobo ?? 0, deliveryKobo: sales[0]?.deliveryKobo ?? 0 },
        commissionKobo: commission[0]?.commissionKobo ?? 0,
        vendors: { approved: vendorBy.get("APPROVED") ?? 0, pending: vendorBy.get("PENDING") ?? 0, suspended: vendorBy.get("SUSPENDED") ?? 0 },
        customers,
        handlers,
        payouts: { pendingCount: payouts[0]?.count ?? 0, pendingKobo: payouts[0]?.amountKobo ?? 0 },
        needsAttention: attention,
        deliveries: { needsHandler, inProgress, failed },
        last7Days,
    });
}));
