import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, pagination } from "../../utils/zodCommon.js";
import { z } from "zod";
import { Order } from "../../models/Order.js";
import { User } from "../../models/User.js";

// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminCustomersRouter = Router();

adminCustomersRouter.get(
  "/customers",
  validate({ query: pagination.extend({ q: z.string().trim().max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, q } = req.validated.query as { page: number; limit: number; q?: string };
    const filter: Record<string, unknown> = { role: "CUSTOMER" };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }
    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    // Only paid orders count towards what a customer has bought.
    const stats = await Order.aggregate<{ _id: unknown; orders: number; spentKobo: number }>([
      { $match: { customerId: { $in: users.map((u) => u._id) }, status: "PAID" } },
      { $group: { _id: "$customerId", orders: { $sum: 1 }, spentKobo: { $sum: "$totalKobo" } } },
    ]);
    const byUser = new Map(stats.map((s) => [String(s._id), s]));

    ok(
      res,
      users.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        phone: u.phone,
        isActive: u.isActive,
        joinedAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        orders: byUser.get(String(u._id))?.orders ?? 0,
        spentKobo: byUser.get(String(u._id))?.spentKobo ?? 0,
      })),
      { page, limit, total },
    );
  }),
);
