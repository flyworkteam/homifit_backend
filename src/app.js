const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const AppError = require('./utils/appError');
const { resolveRequestLanguage } = require('./utils/locale');

const app = express();

app.disable('x-powered-by');

// In production the API runs behind a reverse proxy (nginx / Docker), so the
// real client IP arrives via the `X-Forwarded-For` header. Express must be told
// to trust that proxy hop, otherwise `req.ip` is wrong AND express-rate-limit
// throws `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every request, which surfaces
// to clients as a generic 500 "Internal server error".
//
// Default: trust the first proxy hop (the standard, safe choice for a single
// reverse proxy). Override via TRUST_PROXY env when needed:
//   TRUST_PROXY=2      -> trust 2 hops
//   TRUST_PROXY=true   -> trust all proxies (only behind a trusted network)
//   TRUST_PROXY=false  -> disable (direct, no proxy)
//   TRUST_PROXY=10.0.0.0/8 -> trust a specific subnet
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw == null || raw === '') return 1;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && String(n) === raw ? n : raw;
}
app.set('trust proxy', resolveTrustProxy());

app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch (error) {
        return value;
      }
    })
  : [];
const isDev = process.env.NODE_ENV !== 'production';

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      if (isDev && allowedOrigins.length === 0) {
        callback(null, true);
        return;
      }

      callback(new AppError('CORS origin not allowed', 403));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'Accept-Language'],
    exposedHeaders: ['Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

// Pre-morgan ultra-light logger so we see EVERY request that reaches Express
// (including CORS preflights and 4xx that morgan suppresses in some configs).
app.use((req, res, next) => {
  // eslint-disable-next-line no-console
  console.log(`[REQ] ${req.method} ${req.url} origin=${req.headers.origin || '-'}`);
  next();
});

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  void res;
  req.locale = resolveRequestLanguage(req.headers);
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

// Serve user-uploaded files (avatars). Path matches publicUrl from
// uploadController. Files live outside src/ so they survive code redeploys.
app.use(
  '/uploads',
  express.static(path.resolve(__dirname, '..', 'uploads'), {
    etag: true,
    maxAge: '7d',
  }),
);

app.get('/api/health', (req, res) => {
  void req;
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/workouts', require('./routes/workouts'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/premium', require('./routes/premium'));
app.use('/api/health-sync', require('./routes/health'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
