import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { Order, type OrderDoc } from "../../models/Order.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";

// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminOrdersRouter = Router();

const GROUPS = {
  all: {},
  attention: { needsAttention: true },
  paid: { status: "PAID" },
  pending: { status: "PENDING_PAYMENT" },
  cancelled: { status: "CANCELLED" },
} as const;
type Group = keyof typeof GROUPS;
const GROUP_KEYS = Object.keys(GROUPS) as [Group, ...Group[]];

const presentRow = (o: OrderDoc) => ({
  id: String(o._id),
  orderNumber: o.orderNumber,
  status: o.status,
  customerName: o.customer?.name ?? "Customer",
  cityName: o.deliveryAddress?.cityName ?? null,
  itemsSubtotalKobo: o.itemsSubtotalKobo,
  deliveryTotalKobo: o.deliveryTotalKobo,
  totalKobo: o.totalKobo,
  paidAt: o.payment?.paidAt ?? null,
  createdAt: o.createdAt,
  needsAttention: o.needsAttention,
  attentionReason: o.attentionReason ?? null,
});

adminOrdersRouter.get(
  "/orders",
  validate({ query: pagination.extend({ group: z.enum(GROUP_KEYS).default("all"), q: z.string().trim().max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const { group, q, page, limit } = req.validated.query as { group: Group; q?: string; page: number; limit: number };
    const filter: Record<string, unknown> = { ...GROUPS[group] };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ orderNumber: rx }, { "customer.name": rx }, { "customer.email": rx }];
    }
    const [rows, total, counts] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Order.countDocuments(filter),
      Promise.all(GROUP_KEYS.map(async (g) => [g, await Order.countDocuments(GROUPS[g])] as const)),
    ]);
    ok(res, { counts: Object.fromEntries(counts), orders: rows.map(presentRow) }, { page, limit, total });
  }),
);

adminOrdersRouter.get(
  "/orders/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.validated.params.id);
    if (!order) throw AppError.notFound("Order not found");
    const [subs, logs] = await Promise.all([SubOrder.find({ orderId: order._id }).sort({ ref: 1 }), StatusLog.find({ orderId: order._id }).sort({ at: 1 })]);
    const [vendors, handlers] = await Promise.all([
      Vendor.find({ _id: { $in: subs.map((s) => s.vendorId) } }).select("businessName"),
      User.find({ _id: { $in: subs.map((s) => s.handlerId).filter(Boolean) } }).select("name"),
    ]);
    const vendorName = new Map(vendors.map((v) => [String(v._id), v.businessName]));
    const handlerName = new Map(handlers.map((h) => [String(h._id), h.name]));

    ok(res, {
      ...presentRow(order),
      customer: { name: order.customer?.name ?? "Customer", email: order.customer?.email ?? null, phone: order.customer?.phone ?? null },
      deliveryAddress: { line: order.deliveryAddress!.line, landmark: order.deliveryAddress!.landmark ?? null },
      payment: { reference: order.payment!.reference, channel: order.payment!.channel ?? null, amountKobo: order.payment!.amountKobo },
      pricing: order.pricing,
      attention: { resolvedAt: order.attentionResolvedAt ?? null, note: order.attentionNote ?? null },
      subOrders: subs.map((s) => ({
        id: String(s._id),
        ref: s.ref,
        status: s.status,
        vendorName: vendorName.get(String(s.vendorId)) ?? "Vendor",
        handlerName: s.handlerId ? (handlerName.get(String(s.handlerId)) ?? "Handler") : null,
        items: s.items.map((i) => ({ name: i.name, qty: i.qty, lineTotalKobo: i.lineTotalKobo })),
        itemsTotalKobo: s.itemsTotalKobo,
        commissionTotalKobo: s.commissionTotalKobo,
        vendorEarningKobo: s.vendorEarningKobo,
        deliveryFeeKobo: s.delivery!.feeKobo,
        deliveredAt: s.deliveredAt ?? null,
        failureReason: s.failureReason ?? null,
      })),
      history: logs.map((l) => ({ subOrderId: String(l.subOrderId), from: l.from ?? null, to: l.to, actorRole: l.actorRole, note: l.note ?? null, at: l.at })),
    });
  }),
);

// The refund itself is made by hand in the Paystack dashboard. This records that a person has dealt with the order.
adminOrdersRouter.post(
  "/orders/:id/resolve",
  validate({ params: z.object({ id: objectId }), body: z.object({ note: z.string().trim().min(3, "Say what was done").max(300) }).strict() }),
  asyncHandler(async (req, res) => {
    const order = await Order.findOneAndUpdate(
      { _id: req.validated.params.id, needsAttention: true },
      { $set: { needsAttention: false, attentionResolvedAt: new Date(), attentionResolvedBy: req.user!._id, attentionNote: req.validated.body.note } },
      { returnDocument: "after" },
    );
    if (!order) {
      if (!(await Order.exists({ _id: req.validated.params.id }))) throw AppError.notFound("Order not found");
      throw AppError.conflict("This order is not waiting for attention.");
    }
    ok(res, presentRow(order));
  }),
);
