import { Router } from "express";
import { env, isProd } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { validate } from "../../middleware/validate.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { requireAuth, signToken } from "../../middleware/auth.js";
import { publicUser } from "../../models/User.js";
import { loginSchema, registerCustomerSchema } from "./auth.schemas.js";
import { ROLE_HOME, authenticate, registerCustomer } from "./auth.service.js";
import { registerVendorSchema } from "../vendors/vendor.schemas.js";
import { registerVendor } from "../vendors/vendor.service.js";
export const authRouter = Router();
function setSessionCookie(res, user) {
    res.cookie(env.COOKIE_NAME, signToken(String(user._id), user.role), {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: env.JWT_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
    });
}
const sessionPayload = (user) => ({ user: publicUser(user), home: ROLE_HOME[user.role] });
authRouter.post("/register", authLimiter, validate({ body: registerCustomerSchema }), asyncHandler(async (req, res) => {
    const user = await registerCustomer(req.validated.body);
    setSessionCookie(res, user);
    created(res, sessionPayload(user));
}));
// Vendors have their own onboarding (business, pickup pin, bank). They start PENDING until the admin approves.
authRouter.post("/vendor/register", authLimiter, validate({ body: registerVendorSchema }), asyncHandler(async (req, res) => {
    const { user, vendor } = await registerVendor(req.validated.body);
    setSessionCookie(res, user);
    created(res, { ...sessionPayload(user), vendor: { id: String(vendor._id), slug: vendor.slug, status: vendor.status } });
}));
authRouter.post("/login", authLimiter, validate({ body: loginSchema }), asyncHandler(async (req, res) => {
    const user = await authenticate(req.validated.body);
    setSessionCookie(res, user);
    ok(res, sessionPayload(user));
}));
authRouter.post("/logout", (_req, res) => {
    res.clearCookie(env.COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/" });
    ok(res, { loggedOut: true });
});
authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
    ok(res, sessionPayload(req.user));
}));
