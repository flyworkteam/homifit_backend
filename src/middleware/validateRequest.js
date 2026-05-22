const AppError = require('../utils/appError');

/**
 * Light-weight validation helper.
 * Pass a function that receives the body/params/query and either returns the
 * cleaned/normalized value or throws an AppError.
 */
function validateRequest(validator) {
  return (req, res, next) => {
    void res;
    try {
      const cleaned = validator({
        body: req.body || {},
        params: req.params || {},
        query: req.query || {},
        headers: req.headers || {},
      });
      if (cleaned && typeof cleaned === 'object') {
        if (cleaned.body) req.body = cleaned.body;
        if (cleaned.params) req.params = cleaned.params;
        if (cleaned.query) req.query = cleaned.query;
      }
      return next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      return next(new AppError(error.message || 'Invalid request', 400));
    }
  };
}

module.exports = {
  validateRequest,
};
