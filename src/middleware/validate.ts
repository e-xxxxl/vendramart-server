import type { RequestHandler } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

// Parsed (and stripped) values are stored on req.validated, because in Express 5
// req.query is a read-only getter. Handlers read from req.validated.
declare module "express-serve-static-core" {
  interface Request {
    validated: { body?: any; query?: any; params?: any };
  }
}

export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      req.validated = {};
      if (schemas.body) req.validated.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) req.validated.query = schemas.query.parse(req.query);
      if (schemas.params) req.validated.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      next(err);
    }
  };
