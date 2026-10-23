import multer from "multer";
import type { RequestHandler } from "express";
import { AppError } from "../utils/AppError.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
});

/** Parses one multipart file field named `file` into req.file (memory buffer), with friendly errors. */
export const singleFile: RequestHandler = (req, res, next) => {
  memory.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return next(AppError.validation("That file is too large. The limit is 5 MB"));
      return next(AppError.validation("Upload failed. Send one file in the `file` field"));
    }
    next(err);
  });
};
