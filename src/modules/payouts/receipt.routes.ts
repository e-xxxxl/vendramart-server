import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { Payout } from "../../models/Payout.js";
import { Vendor } from "../../models/Vendor.js";
import { getPrivateStorage } from "../../services/storage/index.js";

// A payout receipt can be opened only by the vendor it was paid to, or an admin. Everyone else gets a 404, the
// same as a receipt that does not exist, so nobody can even learn which payout numbers have receipts.
export const receiptRouter = Router();

receiptRouter.get(
  "/:id/receipt",
  requireAuth,
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const payout = await Payout.findOne({ _id: req.validated.params.id, status: "PAID", "receipt.publicId": { $exists: true } });
    if (!payout) throw AppError.notFound("Receipt not found");

    const user = req.user!;
    if (user.role !== "ADMIN") {
      const ownsIt = user.role === "VENDOR" && (await Vendor.exists({ _id: payout.vendorId, userId: user._id }));
      if (!ownsIt) throw AppError.notFound("Receipt not found");
    }

    const file = await getPrivateStorage().open(payout.receipt!.publicId!, payout.receipt!.mime ?? "application/octet-stream", payout.receipt!.resourceType ?? undefined);
    if (file.kind === "redirect") return ok(res, { url: file.url });

    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `inline; filename="${payout.number}-receipt.${file.mime === "application/pdf" ? "pdf" : file.mime.split("/")[1]}"`);
    res.setHeader("Cache-Control", "private, no-store"); // never kept by shared caches
    res.send(file.data);
  }),
);
