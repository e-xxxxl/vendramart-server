import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { isProd, isTest } from "../config/env.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route not found: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  if (err instanceof ZodError) {
    return res.status(422).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Some fields are invalid",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(422).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Some fields are invalid",
        details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
      },
    });
  }

  // Duplicate key (unique index)
  if (typeof err === "object" && err && (err as { code?: number }).code === 11000) {
    return res.status(409).json({
      success: false,
      error: { code: "CONFLICT", message: "That record already exists" },
    });
  }

  // Malformed JSON body
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "Malformed JSON body" },
    });
  }

  if (!isTest) console.error(err);
  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: isProd ? "Something went wrong" : String((err as Error)?.message ?? err),
    },
  });
};
