export const validate = (schemas) => (req, _res, next) => {
    try {
        req.validated = {};
        if (schemas.body)
            req.validated.body = schemas.body.parse(req.body ?? {});
        if (schemas.query)
            req.validated.query = schemas.query.parse(req.query);
        if (schemas.params)
            req.validated.params = schemas.params.parse(req.params);
        next();
    }
    catch (err) {
        next(err);
    }
};
