import { Router } from "express";
import { z } from "zod";
import { allowedNext } from "../../domain/orderStateMachine.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { transitionSubOrder } from "../orders/subOrderTransitions.js";
// Mounted under /api/handler/deliveries, behind requireRole("HANDLER").
// Every query includes handlerId = me, so a handler can only ever see deliveries assigned to them.
export const handlerDeliveriesRouter = Router();
const GROUPS = {
    active: ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"],
    done: ["DELIVERED", "COMPLETED", "CANCELLED"],
};
async function findMine(userId, id) {
    const sub = await SubOrder.findOne({ _id: id, handlerId: userId });
    if (!sub)
        throw AppError.notFound("Delivery not found"); // someone else's delivery looks like a missing one
    return sub;
}
/** Everything a rider needs to do the job: where to collect, where to drop, who to call, what is in the box. No prices. */
async function presentDetail(sub) {
    const [vendor, customer] = await Promise.all([Vendor.findById(sub.vendorId), User.findById(sub.customerId)]);
    return {
        id: String(sub._id),
        ref: sub.ref,
        status: sub.status,
        // The handler can only do these next, and only once the previous step is done.
        nextActions: allowedNext(sub.status, "HANDLER"),
        waitingForVendor: sub.status === "PAID",
        pickup: {
            businessName: vendor?.businessName ?? "Vendor",
            phone: vendor?.phone ?? null,
            line: sub.delivery.pickup.line,
            lat: sub.delivery.pickup.lat,
            lng: sub.delivery.pickup.lng,
        },
        dropoff: {
            customerName: customer?.name ?? "Customer",
            phone: customer?.phone ?? null,
            line: sub.delivery.dropoff.line,
            landmark: sub.delivery.dropoff.landmark ?? null,
            lat: sub.delivery.dropoff.lat,
            lng: sub.delivery.dropoff.lng,
        },
        distanceKm: (Math.round(sub.delivery.distanceMeters / 100) / 10).toFixed(1),
        items: sub.items.map((i) => ({ name: i.name, qty: i.qty })),
        paidAt: sub.paidAt ?? null,
        deliveredAt: sub.deliveredAt ?? null,
        failureReason: sub.failureReason ?? null,
    };
}
handlerDeliveriesRouter.get("/", validate({ query: pagination.extend({ group: z.enum(["active", "done"]).default("active") }) }), asyncHandler(async (req, res) => {
    const { group, page, limit } = req.validated.query;
    const me = req.user._id;
    const filter = { handlerId: me, status: { $in: [...GROUPS[group]] } };
    const [subs, total, active, done] = await Promise.all([
        SubOrder.find(filter)
            .sort({ updatedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        SubOrder.countDocuments(filter),
        SubOrder.countDocuments({ handlerId: me, status: { $in: [...GROUPS.active] } }),
        SubOrder.countDocuments({ handlerId: me, status: { $in: [...GROUPS.done] } }),
    ]);
    const vendors = await Vendor.find({ _id: { $in: subs.map((s) => s.vendorId) } }).select("businessName");
    const vName = new Map(vendors.map((v) => [String(v._id), v.businessName]));
    ok(res, {
        counts: { active, done },
        deliveries: subs.map((s) => ({
            id: String(s._id),
            ref: s.ref,
            status: s.status,
            waitingForVendor: s.status === "PAID",
            vendorName: vName.get(String(s.vendorId)) ?? "Vendor",
            pickupLine: s.delivery.pickup.line,
            dropoffLine: s.delivery.dropoff.line,
            distanceKm: (Math.round(s.delivery.distanceMeters / 100) / 10).toFixed(1),
            itemCount: s.items.reduce((n, i) => n + i.qty, 0),
        })),
    }, { page, limit, total });
}));
handlerDeliveriesRouter.get("/:id", validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => ok(res, await presentDetail(await findMine(req.user._id, req.validated.params.id)))));
// A handler may only report these three outcomes. Everything else (ready, cancel, retry) belongs to someone else.
const statusBody = z
    .object({ to: z.enum(["PICKED_UP", "DELIVERED", "FAILED_DELIVERY"]), reason: z.string().trim().min(3, "Say why the delivery failed").max(300).optional() })
    .strict();
handlerDeliveriesRouter.post("/:id/status", validate({ params: z.object({ id: objectId }), body: statusBody }), asyncHandler(async (req, res) => {
    const sub = await findMine(req.user._id, req.validated.params.id);
    const { to, reason } = req.validated.body;
    const updated = await transitionSubOrder(sub._id, to, { role: "HANDLER", userId: req.user._id }, { reason });
    ok(res, await presentDetail(updated));
}));
