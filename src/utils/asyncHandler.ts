import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 5 forwards rejected promises to the error handler itself; this keeps
// handler signatures explicit and works the same on Express 4 if we ever pin back.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
