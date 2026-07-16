# xfini-user-api

Standalone REST API for Xfini student creation, called from n8n. Backed by Firebase Auth and Firestore.

## Prerequisites

- Node.js 18+
- A Firebase project with **Authentication** and **Firestore** enabled
- A service account JSON key from the Firebase console

## Setup

```bash
npm install
```

Place your Firebase service account key at the project root:

```text
serviceAccount.json
```

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

## Running

```bash
# development (auto-restart)
npm run dev

# production
npm start
```

Server starts on `http://localhost:3001` by default.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `ADMIN_EMAIL` | Yes | Firebase admin account email |
| `ADMIN_PASSWORD` | Yes | Firebase admin account password |
| `FIREBASE_API_KEY` | Yes | Firebase Web API key, used by `/api/getToken` |
| `PORT` | No | Port to listen on (default: `3001`) |
| `STATS_DB_PATH` | No | SQLite file backing `/stats` (default: `./data/stats.db`) |
| `FIREBASE_CREDENTIALS` | Docker only | Full `serviceAccount.json` as a single-line JSON string |
| `NGROK_AUTHTOKEN` | Docker only | ngrok auth token |
| `NGROK_DOMAIN` | Docker only | Static ngrok domain (e.g. `foo.ngrok-free.app`) |

## Docker (standalone)

A Docker image is automatically built and pushed to GitHub Container Registry on every push to `main` or a version tag (`v*`). The image path below (`ghcr.io/<owner>/<repo>`) is kept in sync with this repo's own `github.repository` by CI — if you're on a fork, it'll point at your fork's image after your first push to `main`.

**Pull the latest image:**

```bash
docker pull ghcr.io/xfini-academy/xfini-user-api:main
```

**Run — pass credentials via environment variables:**

```bash
docker run -p 3001:3001 \
  -e ADMIN_EMAIL=you@example.com \
  -e ADMIN_PASSWORD=yourpassword \
  -e FIREBASE_CREDENTIALS='{"type":"service_account",...}' \
  ghcr.io/xfini-academy/xfini-user-api:main
```

> `FIREBASE_CREDENTIALS` must be the entire contents of `serviceAccount.json` as a single-line JSON string. Alternatively, mount the file directly:
>
> ```bash
> docker run -p 3001:3001 \
>   -e ADMIN_EMAIL=you@example.com \
>   -e ADMIN_PASSWORD=yourpassword \
>   -v $(pwd)/serviceAccount.json:/app/serviceAccount.json \
>   ghcr.io/xfini-academy/xfini-user-api:main
> ```

**Available tags:**

| Tag | When pushed |
| --- | --- |
| `main` | Every push to `main` branch |
| `sha-<commit>` | Every push (pinned to exact commit) |
| `1.2.3` / `1.2` | When a `v1.2.3` git tag is pushed |

The API will be available at `http://localhost:3001`.

---

## Docker Compose

Starts three services: the API, n8n (HTTPS), and ngrok (public tunnel for n8n).

```bash
docker compose up --build
```

| Service | Port | Description |
| --- | --- | --- |
| `xfini-user-api` | `5677` | The REST API |
| `n8n` | `5678` | n8n workflow automation (HTTPS) |
| `ngrok` | `4040` | ngrok dashboard / tunnel for n8n |

> Set `FIREBASE_CREDENTIALS` in `.env` for Docker — the service account is not mounted automatically in production builds.
>
> `GET /stats` data (`data/stats.db`) is persisted in the `xfini_stats_data` named volume, so counts survive container restarts.

---

## API Endpoints

### `GET /health`

Health check.

**Response `200`**

```json
{ "status": "ok" }
```

---

### `GET /stats`

Returns `/create-student` created/failed counts for today and the last 7 days, backed by a local SQLite file (`STATS_DB_PATH`, default `./data/stats.db`).

**Response `200`**

```json
{
  "success": true,
  "today": { "created": 3, "failed": 0 },
  "last7Days": { "created": 21, "failed": 2 }
}
```

---

### `POST /api/getToken`

Signs in with admin credentials and returns a Firebase ID token for use with other Firebase services.

_No body required._ Uses `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the server environment.

**Response `200`**

```json
{
  "success": true,
  "idToken": "eyJ...",
  "expiresIn": "3600"
}
```

---

### `POST /create-student`

Creates a new Firebase Auth user, resolves the subscription plan and active courses from Firestore automatically, and writes the full student profile.

#### Body

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "role": "student",
  "planmonths": "16 DAYS PLAN"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `firstName` | string | Auto-capitalised |
| `lastName` | string | Auto-capitalised |
| `email` | string | Must be a valid email |
| `role` | string | `"student"` or `"admin"` |
| `planmonths` | string | Matched against `name` field in `subscriptionPlans` Firestore collection |

> Password is auto-generated as `{lowercaseFirstName}@123` (e.g. `jane@123`) and returned in the response.

#### Response

```json
{
  "success": true,
  "userId": "abc123",
  "email": "jane@example.com",
  "displayName": "Jane Doe",
  "password": "jane@123",
  "role": "student",
  "planName": "16 DAYS PLAN",
  "planId": "plan-doc-id",
  "subscriptionId": "sub-doc-id",
  "assignedCourses": 4,
  "endDate": "2026-06-09T10:00:00.000Z"
}
```

#### Error responses

| Status | Code | Reason |
| --- | --- | --- |
| `400` | `INVALID_INPUT` | Missing fields, invalid role, short password, or bad `planmonths` |
| `400` | `PLAN_NOT_FOUND` | No active plan matches the given `planmonths` name |
| `400` | `AUTH_FAILED` | Email already in use or Firebase auth error |
| `500` | `FIRESTORE_FAILED` | Firestore write failed (Auth user is cleaned up automatically) |

---

## Firestore Write Order (`/create-student`)

1. Query `subscriptionPlans` — find plan by `name == planmonths && isActive == true`
2. Query `courses` — collect all IDs where `isActive == true` and `isTest` is not `true`
3. Create Firebase Auth user
4. `users/{uid}` — `.set()` with profile and `deviceRestriction`
5. `subscriptions/{auto-id}` — `.add()` with full subscription payload
6. `users/{uid}` — `.update()` to populate `assignedCourseIds`
7. `setCustomUserClaims` — sets `role` and `assignedCourseIds` (non-fatal)

## Firestore: `users/{uid}`

```json
{
  "email": "jane@example.com",
  "displayName": "Jane Doe",
  "role": "student",
  "assignedModules": [],
  "assignedCourseIds": ["course1", "course2"],
  "deviceRestriction": {
    "enabled": true,
    "registeredDeviceId": null,
    "registeredAt": null
  },
  "createdAt": "<server timestamp>",
  "updatedAt": "<server timestamp>"
}
```

## Notes

- n8n timeout should be set to at least **20,000ms** — endpoint makes 7 sequential Firebase calls (~4s typical)
- Mark test courses with `isTest: true` in Firestore to exclude them from being assigned to new students
