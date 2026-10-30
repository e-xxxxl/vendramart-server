import express, { type Express } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { handlePaystackWebhook } from "./paymentWebhook.service.js";

/**
 * Must be mounted BEFORE express.json(): the signature is computed over the exact bytes Paystack sent,
 * so the body has to arrive raw. No sign-in token: authenticity comes from the signature alone.
 */
export function mountPaystackWebhook(app: Express) {
  app.post(
    "/api/webhooks/paystack",
    express.raw({ type: () => true, limit: "100kb" }),
    asyncHandler(async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await handlePaystackWebhook(raw, req.header("x-paystack-signature"));
      res.status(result.status).json(result.body);
    }),
  );
}
