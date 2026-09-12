# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Standalone Express REST API for Xfini student creation, called from n8n. Backed by Firebase Auth and Firestore.

## Stack

- **Runtime:** Node.js + Express
- **Auth/DB:** Firebase Admin SDK (Auth + Firestore)

## Commands

```bash
pnpm run dev      # start with nodemon (auto-restart on change)
pnpm start        # production start
pnpm test         # run the node:test suite (test/api.test.js)
pnpm run lint         # eslint .
pnpm run format       # prettier --write . (fixes formatting)
pnpm run format:check # prettier --check . (fails without writing; what CI runs)
pnpm run build        # syntax-check index.js and firebaseAdmin.js (node --check)
```

Run a single test file/case with the native runner, e.g. `node --experimental-test-module-mocks --test --test-name-pattern="creates a student" test/api.test.js`.

`test/api.test.js` mocks `firebase-admin` (via `node --experimental-test-module-mocks`, applied to `./firebaseAdmin.js` not the package directly) and exercises the Express app in-process — no real Firebase project needed. `.github/workflows/test.yml` runs lint + format check + test on every push/PR (Node 26, pnpm via `packageManager` field); `.github/workflows/docker-publish.yml` builds and pushes the image to GHCR (`ghcr.io/<owner>/<repo>`) on push to `main` and on `v*` tags. For anything the suite doesn't cover, fall back to manual testing via curl or Postman against `http://localhost:3001`. `pnpm-lock.yaml` and `data/` are excluded from Prettier via `.prettierignore` — the lockfile's formatting is owned by pnpm, not Prettier.

## Docker Compose

Three separate compose files, pick one depending on the target:

| File                        | Use case                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`        | Production/server deploy — pulls the prebuilt `xfini-user-api` image from GHCR, adds Watchtower for auto-updates, plus `n8n` + `ngrok` |
| `docker-compose.server.yml` | Server deploy built from local source (`build: .`) instead of the GHCR image — same `n8n` + `ngrok`, no Watchtower                     |
| `docker-compose.local.yml`  | Local dev — builds from source, runs `n8n` only, no `ngrok`/Watchtower                                                                 |

All three define `xfini-user-api` (or `user-api` in `docker-compose.server.yml`) on host port `5677` (mapped to container `3001`), `n8n` on `5678`, and persist `/stats` data via the `xfini_stats_data` named volume. Env vars are passed explicitly via `environment:` — no `env_file`.

```bash
docker compose up --build                              # docker-compose.yml
docker compose -f docker-compose.local.yml up --build   # local dev
```

Required `.env` vars for compose:

| Variable               | Purpose                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_EMAIL`          | Firebase admin account email                                                                                        |
| `ADMIN_PASSWORD`       | Firebase admin account password                                                                                     |
| `PORT`                 | API port (default: 3001)                                                                                            |
| `FIREBASE_CREDENTIALS` | Full `serviceAccount.json` contents as a single-line JSON string                                                    |
| `FIREBASE_API_KEY`     | Firebase Web API key, required by `/api/getToken`                                                                   |
| `STATS_DB_PATH`        | SQLite file backing `/stats` (default: `./data/stats.db`); persisted via a named volume in Docker                   |
| `NGROK_AUTHTOKEN`      | ngrok auth token (not needed for `docker-compose.local.yml`)                                                        |
| `NGROK_DOMAIN`         | Static ngrok domain, e.g. `foo.ngrok-free.app` (not needed for `docker-compose.local.yml`)                          |
| `DOCKER_IMAGE`         | Overrides the GHCR image pulled by `docker-compose.yml` (defaults to `ghcr.io/xfini-academy/xfini-user-api:latest`) |

The `xfini-user-api`/`user-api` service also mounts `./serviceAccount.json` as a fallback volume — only needed for compose runs without `FIREBASE_CREDENTIALS`.

## Key Behaviours

- `firstName`/`lastName` are auto-capitalised (proper case) server-side
- Plan details (`planId`, `planName`, `price`) are resolved automatically from Firestore `subscriptionPlans` collection by matching `name == planmonths && isActive == true` — the caller does not supply these
- Active course IDs are fetched from Firestore `courses` collection where `isActive == true`, `isTest` is not `true`, **and** `title` contains the literal substring `[AT]` — courses without that tag are never auto-assigned
- Custom claims (`role`, `assignedCourseIds`) are set on the Auth token after user creation; failure is non-fatal and logged as a warning
- If any Firestore write fails after the Auth user is created, the Auth user is deleted to prevent orphaned accounts
- `deviceRestriction` is written to `users/{uid}` with `enabled: true` by default
- Email format is checked with a hand-rolled linear-time validator (`isValidEmail` in `index.js`), not a regex — intentional, to avoid ReDoS on attacker-controlled input
- All routes sit behind `express-rate-limit`: 100 requests / 15 min per IP

## Endpoints

| Method | Path              | Purpose                                                              |
| ------ | ----------------- | -------------------------------------------------------------------- |
| GET    | `/health`         | Health check                                                         |
| GET    | `/stats`          | Today's and last-7-days' created/failed counts for `/create-student` |
| POST   | `/api/getToken`   | Sign in with admin credentials and return a Firebase ID token        |
| POST   | `/create-student` | Create a Firebase Auth user + Firestore profile + subscription       |

### `GET /stats`

Reads from a local SQLite file (`node:sqlite`, path from `STATS_DB_PATH`, default `./data/stats.db`) that every `/create-student` response is logged to (success/failure + status code + timestamp) via response-finish middleware. Returns `{ today: {created, failed}, last7Days: {created, failed} }`.

### `POST /api/getToken`

Signs in using `ADMIN_EMAIL` / `ADMIN_PASSWORD` from env via the Firebase REST API (`identitytoolkit`). Returns a short-lived ID token. Requires `FIREBASE_API_KEY` in env.

### `POST /create-student` — required body fields

| Field        | Type   | Notes                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------- |
| `firstName`  | string | Auto-capitalised                                                       |
| `lastName`   | string | Auto-capitalised                                                       |
| `email`      | string |                                                                        |
| `password`   | —      | Auto-generated as `{lowercaseFirstName}@123`; not accepted from caller |
| `role`       | string | `"student"` or `"admin"`                                               |
| `planmonths` | string | Matched against `name` field in `subscriptionPlans` collection         |

### `POST /create-student` — Firestore write order

1. Query `subscriptionPlans` — resolve plan by `name == planmonths && isActive == true`
2. Query `courses` — collect IDs where `isActive == true`, `isTest` is not `true`, and `title` includes `[AT]`
3. Firebase Auth `createUser`
4. `users/{uid}` — `.set()` with empty `assignedCourseIds: []` and `deviceRestriction`
5. `subscriptions/{auto-id}` — `.add()` with full subscription payload; `endDate` calculated via `setMonth(+months)`
6. `users/{uid}` — `.update()` to populate `assignedCourseIds`
7. `setCustomUserClaims` — sets `role` and `assignedCourseIds` (non-fatal)

### `POST /create-student` — success response

```json
{
  "success": true,
  "userId": "uid",
  "email": "...",
  "displayName": "First Last",
  "password": "plain-text",
  "role": "student",
  "planName": "...",
  "planId": "...",
  "subscriptionId": "auto-id",
  "assignedCourses": 4,
  "endDate": "2026-11-09T..."
}
```

### `POST /create-student` — error codes

| Status | Code                  | Reason                                                                       |
| ------ | --------------------- | ---------------------------------------------------------------------------- |
| `400`  | `INVALID_INPUT`       | Missing fields, invalid email/role, or bad `planmonths`                      |
| `400`  | `PLAN_NOT_FOUND`      | No active plan matches the given `planmonths` name                           |
| `400`  | (Firebase error code) | Auth failure, e.g. email already in use (Auth user cleaned up automatically) |
| `500`  | `FIRESTORE_FAILED`    | Plan/course lookup failed before any writes were attempted                   |

## Sensitive Files (never commit)

- `serviceAccount.json` — Firebase service account private key
- `.env` — environment credentials

## Dev Notes

- Default port: `3001` (override with `PORT` env var)
- n8n timeout should be set to at least 20,000ms — endpoint makes 7 sequential Firebase calls (~4s typical)
- The Dockerfile bakes in `serviceAccount.json` at build time — update when deploying to a new environment
- Requires a recent Node.js (CI and Dockerfile both use Node 26) for `node:sqlite` support, used by `/stats`
