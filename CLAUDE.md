# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Standalone Express REST API for Xfini student creation, called from n8n. Backed by Firebase Auth and Firestore.

## Stack

- **Runtime:** Node.js + Express
- **Auth/DB:** Firebase Admin SDK (Auth + Firestore)

## Commands

```bash
npm run dev      # start with nodemon (auto-restart on change)
npm start        # production start
```

No test suite exists. Manual testing via curl or Postman against `http://localhost:3001`.

## Docker Compose

Three services: `xfini-user-api`, `n8n` (workflow automation, HTTPS on port 5678), and `ngrok` (tunnels n8n to a static public domain). All env vars are passed explicitly via `environment:` — no `env_file`.

```bash
docker compose up --build
```

Required `.env` vars for compose:

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAIL` | Firebase admin account email |
| `ADMIN_PASSWORD` | Firebase admin account password |
| `PORT` | API port (default: 3001) |
| `FIREBASE_CREDENTIALS` | Full `serviceAccount.json` contents as a single-line JSON string |
| `NGROK_AUTHTOKEN` | ngrok auth token |
| `NGROK_DOMAIN` | Static ngrok domain (e.g. `foo.ngrok-free.app`) |

The `xfini-user-api` service also mounts `./serviceAccount.json` as a fallback volume — only needed for local compose runs without `FIREBASE_CREDENTIALS`.

## Key Behaviours

- `firstName`/`lastName` are auto-capitalised (proper case) server-side
- Plan details (`planId`, `planName`, `price`) are resolved automatically from Firestore `subscriptionPlans` collection by matching `name == planmonths && isActive == true` — the caller does not supply these
- Active course IDs are fetched from Firestore `courses` collection where `isActive == true`, excluding any doc with `isTest: true`
- Custom claims (`role`, `assignedCourseIds`) are set on the Auth token after user creation; failure is non-fatal and logged as a warning
- If any Firestore write fails after the Auth user is created, the Auth user is deleted to prevent orphaned accounts
- `deviceRestriction` is written to `users/{uid}` with `enabled: true` by default

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/api/getToken` | Sign in with admin credentials and return a Firebase ID token |
| POST | `/create-student` | Create a Firebase Auth user + Firestore profile + subscription |

### `POST /api/getToken`

Signs in using `ADMIN_EMAIL` / `ADMIN_PASSWORD` from env via the Firebase REST API (`identitytoolkit`). Returns a short-lived ID token. Requires `FIREBASE_API_KEY` in env.

### `POST /create-student` — required body fields

| Field | Type | Notes |
| --- | --- | --- |
| `firstName` | string | Auto-capitalised |
| `lastName` | string | Auto-capitalised |
| `email` | string | |
| `password` | — | Auto-generated as `{lowercaseFirstName}@123`; not accepted from caller |
| `role` | string | `"student"` or `"admin"` |
| `planmonths` | string | Matched against `name` field in `subscriptionPlans` collection |

### `POST /create-student` — Firestore write order

1. Query `subscriptionPlans` — resolve plan by `name == planmonths && isActive == true`
2. Query `courses` — collect all IDs where `isActive == true` and `isTest` is not `true`
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

## Sensitive Files (never commit)

- `serviceAccount.json` — Firebase service account private key
- `.env` — environment credentials

## Dev Notes

- Default port: `3001` (override with `PORT` env var)
- n8n timeout should be set to at least 20,000ms — endpoint makes 7 sequential Firebase calls (~4s typical)
- The Dockerfile bakes in `serviceAccount.json` at build time — update when deploying to a new environment
