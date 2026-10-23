import type { RequestHandler } from "express";
import { AppError } from "../utils/AppError.js";

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "vendramart";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie auth + SameSite=Lax already blocks cross-site POSTs. This adds a custom header that a plain
 * cross-site HTML form cannot send, as a second layer. Webhooks authenticate by signature instead.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method)) return next();
  if (req.path.startsWith("/webhooks/")) return next();
  if (req.header(CSRF_HEADER) !== CSRF_VALUE) {
    return next(AppError.forbidden("Missing or invalid request header"));
  }
  next();
};
