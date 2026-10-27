import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { User } from "../models/User.js";
export function signToken(userId, role) {
    return jwt.sign({ sub: userId, role }, env.JWT_SECRET, {
        expiresIn: `${env.JWT_EXPIRES_IN_DAYS}d`,
    });
}
function readToken(req) {
    return req.cookies?.[env.COOKIE_NAME];
}
async function loadUser(req) {
    const token = readToken(req);
    if (!token)
        return null;
    let payload;
    try {
        payload = jwt.verify(token, env.JWT_SECRET);
    }
    catch {
        return null;
    }
    // Load from the DB on every request so a suspension or role change applies immediately.
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive)
        return null;
    return user;
}
/** Attaches req.user if a valid session exists. Never rejects. */
export const optionalAuth = async (req, _res, next) => {
    try {
        const user = await loadUser(req);
        if (user)
            req.user = user;
        next();
    }
    catch (err) {
        next(err);
    }
};
/** Requires a valid session. */
export const requireAuth = async (req, _res, next) => {
    try {
        const user = await loadUser(req);
        if (!user)
            return next(AppError.unauthenticated());
        req.user = user;
        next();
    }
    catch (err) {
        next(err);
    }
};
/** Requires a valid session AND one of the given roles. Use on every non-public router. */
export const requireRole = (...roles) => {
    return async (req, res, next) => {
        await requireAuth(req, res, (err) => {
            if (err)
                return next(err);
            if (!req.user || !roles.includes(req.user.role))
                return next(AppError.forbidden());
            next();
        });
    };
};
