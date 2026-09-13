# Xfini User API — Postman Workspace

Welcome to the **Xfini User API** Postman Workspace. This workspace provides complete API definitions, collections, and environment configurations for testing and integrating the Xfini student provisioning and subscription management backend.

---

## 📖 About this workspace

The **Xfini User API** is a standalone Express REST microservice called by automation systems like **n8n** and backend services. It manages:

- **Student user provisioning**: Creating Firebase Authentication users and corresponding Firestore student profiles with associated active subscriptions.
- **Subscription expiry tracking**: Identifying students whose subscriptions expire on a given date (or tomorrow in `Asia/Kolkata` timezone) to trigger renewal and reminder workflows in n8n.
- **Service monitoring**: Providing health checks and SQLite-backed statistics on successful vs. failed operations.

---

## 🚀 Getting started

Follow these steps to start testing the endpoints immediately:

### 1. Select the Environment

In the top-right corner of Postman, switch the environment dropdown to:

> **`Xfini User API (Local Environment)`**

### 2. Verify or Update Base URL

The default variables are pre-configured:

- `baseUrl`: `http://localhost:3001` (or use `https://unsavory-anteater-regally.ngrok-free.dev` for ngrok)
- `adminEmail`: `rahulbushi69@gmail.com`
- `firebaseApiKey`: Pre-configured from your `.env`

### 3. Generate an Auth Token

Open the collection:

> **Xfini User API** ➔ **Authentication** ➔ **Get Admin ID Token**

Click **Send**.

- The post-response test script automatically parses `jsonData.idToken` and saves it to the `idToken` environment & collection variable.
- All authenticated endpoints inherit this token automatically via `Authorization: Bearer {{idToken}}`.

### 4. Send API Requests

You can now execute any request in the **Students & Subscriptions** or **Monitoring & Health** folders!

---

## 📦 What's included

### 1. API Definitions (`APIs` tab)

- **Specification**: OpenAPI 3.0.3 spec (`postman/specs/xfini_user_api.openapi.yaml` and `.json`)
- **Endpoints documented**: All paths, request bodies, query parameters, responses, and schemas.

### 2. Collection: `Xfini User API`

| Folder                       | Request                          | Method | Path                                 |  Auth   | Description                                             |
| ---------------------------- | -------------------------------- | :----: | ------------------------------------ | :-----: | ------------------------------------------------------- |
| **Monitoring & Health**      | Health Check                     | `GET`  | `/health`                            |   No    | Server liveness and uptime check                        |
| **Monitoring & Health**      | API Stats                        | `GET`  | `/stats`                             | Bearer  | Created vs. failed counters for today and 7 days        |
| **Authentication**           | Get Admin ID Token               | `POST` | `/api/getToken`                      |   No    | Fetches Firebase ID token via server credentials        |
| **Authentication**           | Direct Firebase Auth Sign-In     | `POST` | `identitytoolkit.googleapis.com/...` | API Key | Direct Google Identity Toolkit sign-in                  |
| **Students & Subscriptions** | Create Student                   | `POST` | `/create-student`                    | Bearer  | Creates Firebase user, Firestore profile & subscription |
| **Students & Subscriptions** | Get Expiring Students (Tomorrow) | `GET`  | `/expiring-students`                 | Bearer  | Returns students expiring tomorrow (IST)                |
| **Students & Subscriptions** | Get Expiring Students (By Date)  | `GET`  | `/expiring-students?date=YYYY-MM-DD` | Bearer  | Returns students expiring on a specific date            |
| **Templates & Playground**   | Custom Request Template          | `ANY`  | `{{baseUrl}}/...`                    | Bearer  | Pre-configured template for ad-hoc requests             |

### 3. Environments

- **Xfini User API (Local Environment)**:
  - `baseUrl`: `http://localhost:3001`
  - `idToken`: Token populated automatically after sign-in
  - `adminEmail`: `rahulbushi69@gmail.com`
  - `firebaseApiKey`: Google Identity Toolkit API key
  - `samplePlanMonths`: `16 DAYS PLAN`

---

## 💡 Notes & Details

### Timezone Handling

- The `/expiring-students` endpoint calculates "tomorrow" strictly using the **`Asia/Kolkata` (IST)** timezone (`00:00:00.000` to `23:59:59.999`).
- Query parameter format: `?date=YYYY-MM-DD` (e.g., `?date=2026-09-14`).

### Token Expiration

- Firebase ID tokens expire after **1 hour**. If you receive a `401 Unauthorized` response, simply re-run **Get Admin ID Token** to refresh the token variable.
