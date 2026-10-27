import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { Notification, publicNotification } from "../../models/Notification.js";
// Any signed-in role. Every query is scoped to the caller, so nobody can read or clear another person's alerts.
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get("/", validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }), asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const [items, unreadCount] = await Promise.all([
        Notification.find({ userId }).sort({ createdAt: -1 }).limit(req.validated.query.limit),
        Notification.countDocuments({ userId, readAt: { $exists: false } }),
    ]);
    ok(res, { unreadCount, items: items.map(publicNotification) });
}));
notificationsRouter.post("/read-all", asyncHandler(async (req, res) => {
    const result = await Notification.updateMany({ userId: req.user._id, readAt: { $exists: false } }, { readAt: new Date() });
    ok(res, { updated: result.modifiedCount });
}));
notificationsRouter.post("/:id/read", validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
    const n = await Notification.findOneAndUpdate({ _id: req.validated.params.id, userId: req.user._id }, { $set: { readAt: new Date() } }, { returnDocument: "after" });
    if (!n)
        throw AppError.notFound("Notification not found");
    ok(res, publicNotification(n));
}));
