// Express 5 forwards rejected promises to the error handler itself; this keeps
// handler signatures explicit and works the same on Express 4 if we ever pin back.
export const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res, next).catch(next);
};
