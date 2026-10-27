import rateLimit from "express-rate-limit";
import { isTest } from "../config/env.js";
const handler = (message) => (_req, res) => res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message } });
// Disabled under test so suites can hit auth routes freely; a dedicated test covers the limiter.
const skip = () => isTest && process.env.ENABLE_RATE_LIMIT_IN_TEST !== "1";
/** Login / register: 10 attempts per 15 minutes per IP. */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    handler: handler("Too many attempts. Please try again in a few minutes."),
});
/** Checkout quotes call the paid maps API, so cap them per IP: 120 per hour. */
export const quoteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    handler: handler("Too many delivery price checks. Please try again later."),
});
/** Checkout and payment initialisation (used from Phase 4): 20 per hour per IP. */
export const paymentLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    handler: handler("Too many payment attempts. Please try again later."),
});
