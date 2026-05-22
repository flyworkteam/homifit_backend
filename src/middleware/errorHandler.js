function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    data: null,
    error: 'Endpoint not found',
  });
}

function errorHandler(err, req, res, next) {
  void next;
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;

  if (statusCode >= 500) {
    const logPayload = {
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode,
      message: err.message,
      stack: err.stack,
    };
    console.error('API error:', logPayload);
  }

  // AppError instances may carry extra context (e.g. `lockedReason` from
  // requirePremium) — surface it as `data` so clients can branch on it.
  const data = err && err.meta && typeof err.meta === 'object'
      ? err.meta
      : null;

  res.status(statusCode).json({
    success: false,
    data,
    error: message,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
