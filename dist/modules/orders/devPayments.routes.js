import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { Order } from "../../models/Order.js";
import { DEV_WEBHOOK_SECRET, getDevGateway } from "../../services/payments/index.js";
import { computeSignature } from "../../services/payments/signature.js";
import { handlePaystackWebhook } from "./paymentWebhook.service.js";
/**
 * DEVELOPMENT ONLY (mounted in app.ts when not in production and no Paystack key is set).
 * Backs the local /dev/paystack page that stands in for the Paystack checkout. "Paying" settles the
 * transaction in the dev gateway and then delivers a correctly SIGNED webhook to the real handler,
 * so the whole payment path (signature, verify, idempotency, order update) is exercised.
 */
export const devPaymentsRouter = Router();
const reference = z.object({ reference: z.string().trim().min(3).max(100) });
devPaymentsRouter.get("/transaction", validate({ query: reference }), asyncHandler(async (req, res) => {
    const dev = getDevGateway();
    const tx = dev?.transactions.get(req.validated.query.reference);
    const order = tx ? await Order.findOne({ "payment.reference": tx.reference }).select("orderNumber") : null;
    if (!tx)
        throw AppError.notFound("Unknown payment reference (the dev server may have restarted)");
    ok(res, { reference: tx.reference, amountKobo: tx.amountKobo, status: tx.status, orderNumber: order?.orderNumber ?? null });
}));
devPaymentsRouter.post("/charge", validate({ body: reference.extend({ outcome: z.enum(["success", "failed"]) }).strict() }), asyncHandler(async (req, res) => {
    const dev = getDevGateway();
    if (!dev)
        throw AppError.notFound("The dev payment gateway is not active");
    const { reference: ref, outcome } = req.validated.body;
    const tx = dev.settle(ref, outcome);
    if (!tx)
        throw AppError.notFound("Unknown payment reference (the dev server may have restarted)");
    if (outcome === "failed")
        return ok(res, { outcome: "FAILED" });
    const payload = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: ref, status: "success", amount: tx.amountKobo, currency: "NGN" } }));
    const result = await handlePaystackWebhook(payload, computeSignature(payload, DEV_WEBHOOK_SECRET));
    ok(res, { webhookStatus: result.status, ...result.body });
}));
