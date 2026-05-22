const jwt = require('jsonwebtoken');

function signUserToken(payload, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  const signOptions = {
    expiresIn: options.expiresIn || process.env.JWT_EXPIRES_IN || '30d',
  };

  if (process.env.JWT_ISSUER) {
    signOptions.issuer = process.env.JWT_ISSUER;
  }
  if (process.env.JWT_AUDIENCE) {
    signOptions.audience = process.env.JWT_AUDIENCE;
  }

  return jwt.sign(payload, secret, signOptions);
}

module.exports = {
  signUserToken,
};
