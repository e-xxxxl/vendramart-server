export class AppError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = "AppError";
    }
    static badRequest(message, details) {
        return new AppError(400, "BAD_REQUEST", message, details);
    }
    static validation(message, details) {
        return new AppError(422, "VALIDATION_ERROR", message, details);
    }
    static unauthenticated(message = "Please sign in to continue") {
        return new AppError(401, "UNAUTHENTICATED", message);
    }
    static forbidden(message = "You do not have access to this resource") {
        return new AppError(403, "FORBIDDEN", message);
    }
    static unavailable(message, details) {
        return new AppError(503, "SERVICE_UNAVAILABLE", message, details);
    }
    static notFound(message = "Not found") {
        return new AppError(404, "NOT_FOUND", message);
    }
    static conflict(message, details) {
        return new AppError(409, "CONFLICT", message, details);
    }
}
