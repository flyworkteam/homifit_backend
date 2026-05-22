# HomiFit Backend

Node.js + Express backend API for HomiFit.

## Quick Start

1. Copy `.env.example` to `.env` and fill values.
2. Place your Firebase service account JSON at `config/firebase-service-account.json`
   (or set `FIREBASE_SERVICE_ACCOUNT_JSON` directly).
3. Install dependencies:

```bash
npm install
```

4. Run migrations (once SQL files exist under `migrations/sql/`):

```bash
npm run migrate
```

5. Start development server:

```bash
npm run dev
```

## Stack

- Express 4 + Helmet + CORS + rate-limit + Morgan
- MySQL 8 (mysql2/promise)
- Firebase Admin (verify Google/Apple sign-in tokens)
- JWT for backend session

## Folder Layout

```
src/
├── app.js                # express app + middleware + routes
├── server.js             # bootstrap
├── config/               # env, db, firebaseAdmin
├── controllers/          # request handlers (skeletons, return 501)
├── middleware/           # auth, errorHandler, upload, validateRequest
├── routes/               # express routers
├── services/             # business logic (empty, to be filled)
├── utils/                # appError, jwt, locale
└── validation/           # request validators (empty, to be filled)
migrations/
├── run.js                # migration runner
└── sql/                  # numbered .sql files (e.g. 001_init.sql)
```

## Endpoints (Skeleton)

All `/api/*` routes other than `/api/health` return **501 Not Implemented**
until controllers are wired up.

- `GET  /api/health`
- `POST /api/auth/firebase`, `/api/auth/refresh`, `/api/auth/logout`
- `GET|PUT|DELETE /api/users/profile`
- `POST /api/uploads/avatar`
- `GET|PUT /api/onboarding/answers`, `DELETE /api/onboarding/answers/:questionKey`
- `GET /api/workouts/program`, `/api/workouts/program/:day`
- `GET /api/workouts/categories`, `/api/workouts/categories/:slug`
- `GET /api/workouts/quick`
- `GET /api/progress/days`, `PUT /api/progress/days/:day`
- `GET /api/progress/summary`, `/api/progress/streak`
- `GET|PUT /api/notifications/preferences`
- `GET /api/premium/status`
- `POST /api/premium/webhook`
