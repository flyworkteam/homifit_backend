class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {Object} [meta]  Extra fields attached to the error response
   *   body. Useful e.g. for { lockedReason: 'premium_required' } so the
   *   client can route the user to the paywall.
   */
  constructor(message, statusCode, meta) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    if (meta && typeof meta === 'object') {
      this.meta = meta;
    }
  }
}

module.exports = AppError;
