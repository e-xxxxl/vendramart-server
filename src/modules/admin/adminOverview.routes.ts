import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
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

/** The windows the admin can pick. "30d" is shown as "1 month". "all" has no start. */
const RANGE_DAYS = { "7d": 7, "14d": 14, "30d": 30 } as const;
const MAX_MONTHS = 60;

/** "2026-10-18" for a moment, as the calendar date in Lagos. */
const lagosDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** The start of a calendar day in Lagos (UTC+1, no daylight saving) as an instant. */
const startOfLagosDay = (day: string) => new Date(`${day}T00:00:00+01:00`);

interface Bucket {
  _id: string;
  orders: number;
  grossKobo: number;
}

/** Paid orders grouped by Lagos calendar day ("%Y-%m-%d") or month ("%Y-%m"), from `since` (or ever). */
const sold = (format: "%Y-%m-%d" | "%Y-%m", since: Date | null) =>
  Order.aggregate<Bucket>([
    { $match: { status: "PAID", ...(since ? { "payment.paidAt": { $gte: since } } : {}) } },
    { $group: { _id: { $dateToString: { format, date: "$payment.paidAt", timezone: TZ } }, orders: { $sum: 1 }, grossKobo: { $sum: "$totalKobo" } } },
  ]);

/** One entry for each of the last `days` days, ending today, with the days that had no sales as zero. */
function dailyPoints(buckets: Bucket[], days: number, now: Date) {
  const byDay = new Map(buckets.map((b) => [b._id, b]));
  return Array.from({ length: days }, (_, i) => {
    const date = lagosDay(new Date(now.getTime() - (days - 1 - i) * DAY_MS));
    return { date, orders: byDay.get(date)?.orders ?? 0, grossKobo: byDay.get(date)?.grossKobo ?? 0 };
  });
}

/** One entry for each month from the first one with sales to this month, so a quiet month shows as zero. */
function monthlyPoints(buckets: Bucket[], now: Date) {
  const byMonth = new Map(buckets.map((b) => [b._id, b]));
  const thisMonth = lagosDay(now).slice(0, 7);
  const first = buckets.map((b) => b._id).sort()[0] ?? thisMonth;
  const points: { date: string; orders: number; grossKobo: number }[] = [];
  let [y, m] = first.split("-").map(Number) as [number, number];
  const [endY, endM] = thisMonth.split("-").map(Number) as [number, number];
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    points.push({ date: key, orders: byMonth.get(key)?.orders ?? 0, grossKobo: byMonth.get(key)?.grossKobo ?? 0 });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return points.slice(-MAX_MONTHS);
}

adminOverviewRouter.get(
  "/overview",
  // With no range the totals cover everything, as they always did, so an older screen keeps working unchanged.
  validate({ query: z.object({ range: z.enum(["7d", "14d", "30d", "all"]).default("all") }) }),
  asyncHandler(async (req, res) => {
    const { range } = req.validated.query as { range: "7d" | "14d" | "30d" | "all" };
    const now = new Date();
    const days = range === "all" ? null : RANGE_DAYS[range];
    // A window starts at the beginning of that calendar day in Lagos, not N x 24h ago, so an order paid early on the first
    // day is counted in that day's bar.
    const since = days === null ? null : startOfLagosDay(lagosDay(new Date(now.getTime() - (days - 1) * DAY_MS)));
    const since7 = startOfLagosDay(lagosDay(new Date(now.getTime() - 6 * DAY_MS)));

    const [sales, commission, vendorCounts, customers, handlers, payouts, attention, needsHandler, inProgress, failed, series, week] = await Promise.all([
      // The totals follow the chosen range: what was paid within it.
      Order.aggregate<{ orders: number; grossKobo: number; itemsKobo: number; deliveryKobo: number }>([
        { $match: { status: "PAID", ...(since ? { "payment.paidAt": { $gte: since } } : {}) } },
        { $group: { _id: null, orders: { $sum: 1 }, grossKobo: { $sum: "$totalKobo" }, itemsKobo: { $sum: "$itemsSubtotalKobo" }, deliveryKobo: { $sum: "$deliveryTotalKobo" } } },
      ]),
      SubOrder.aggregate<{ commissionKobo: number }>([
        { $match: { status: { $in: COUNTED }, ...(since ? { paidAt: { $gte: since } } : {}) } },
        { $group: { _id: null, commissionKobo: { $sum: "$commissionTotalKobo" } } },
      ]),
      // The rest is how things stand now, whatever the range.
      Vendor.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      User.countDocuments({ role: "CUSTOMER" }),
      User.countDocuments({ role: "HANDLER", isActive: true }),
      Payout.aggregate<{ count: number; amountKobo: number }>([{ $match: { status: "REQUESTED" } }, { $group: { _id: null, count: { $sum: 1 }, amountKobo: { $sum: "$amountKobo" } } }]),
      Order.countDocuments({ needsAttention: true }),
      SubOrder.countDocuments({ status: { $in: ["PAID", "READY_FOR_PICKUP", "FAILED_DELIVERY"] }, handlerId: null }),
      SubOrder.countDocuments({ status: { $in: ["PAID", "READY_FOR_PICKUP", "PICKED_UP"] } }),
      SubOrder.countDocuments({ status: "FAILED_DELIVERY" }),
      // The chart: a bar a day for 7, 14 or 30 days, a bar a month for all time.
      days === null ? sold("%Y-%m", null) : sold("%Y-%m-%d", since),
      sold("%Y-%m-%d", since7),
    ]);

    const vendorBy = new Map(vendorCounts.map((v) => [v._id, v.n]));
    ok(res, {
      range,
      sales: { orders: sales[0]?.orders ?? 0, grossKobo: sales[0]?.grossKobo ?? 0, itemsKobo: sales[0]?.itemsKobo ?? 0, deliveryKobo: sales[0]?.deliveryKobo ?? 0 },
      commissionKobo: commission[0]?.commissionKobo ?? 0,
      vendors: { approved: vendorBy.get("APPROVED") ?? 0, pending: vendorBy.get("PENDING") ?? 0, suspended: vendorBy.get("SUSPENDED") ?? 0 },
      customers,
      handlers,
      payouts: { pendingCount: payouts[0]?.count ?? 0, pendingKobo: payouts[0]?.amountKobo ?? 0 },
      needsAttention: attention,
      deliveries: { needsHandler, inProgress, failed },
      // The bars for the chosen range. `date` is a day ("2026-11-25") or, for all time, a month ("2026-11").
      series: { bucket: days === null ? "month" : "day", points: days === null ? monthlyPoints(series, now) : dailyPoints(series, days, now) },
      // Always the last 7 days: what the screen showed before ranges, kept for any screen not yet updated.
      last7Days: dailyPoints(week, 7, now),
    });
  }),
);
