import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { validate } from "../../middleware/validate.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { requireAuth, signToken } from "../../middleware/auth.js";
import { publicUser, type UserDoc } from "../../models/User.js";
import { loginSchema, registerCustomerSchema } from "./auth.schemas.js";
import { ROLE_HOME, authenticate, registerCustomer } from "./auth.service.js";
import { registerVendorSchema } from "../vendors/vendor.schemas.js";
import { registerVendor } from "../vendors/vendor.service.js";
import { notifyVendorApplied, notifyWelcome } from "../accounts/accountEvents.js";

export const authRouter = Router();

/** Who the user is and where to send them. Signing in or registering also returns the JWT, which the website keeps and sends with every request. */
const sessionPayload = (user: UserDoc) => ({ user: publicUser(user), home: ROLE_HOME[user.role] });
const signedInPayload = (user: UserDoc) => ({ token: signToken(String(user._id), user.role), ...sessionPayload(user) });

authRouter.post(
  "/register",
  authLimiter,
  validate({ body: registerCustomerSchema }),
  asyncHandler(async (req, res) => {
    const user = await registerCustomer(req.validated.body);
    void notifyWelcome(user); // never delays or breaks the sign-up
    created(res, signedInPayload(user));
  }),
);

// Vendors have their own onboarding (business, pickup pin, bank). They start PENDING until the admin approves.
authRouter.post(
  "/vendor/register",
  authLimiter,
  validate({ body: registerVendorSchema }),
  asyncHandler(async (req, res) => {
    const { user, vendor } = await registerVendor(req.validated.body);
    void notifyVendorApplied(user, vendor);
    created(res, { ...signedInPayload(user), vendor: { id: String(vendor._id), slug: vendor.slug, status: vendor.status } });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const user = await authenticate(req.validated.body);
    ok(res, signedInPayload(user));
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, sessionPayload(req.user!));
  }),
);
