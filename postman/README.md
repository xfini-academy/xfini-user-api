# Xfini User API — Postman API Collection

This directory contains the official Postman collection and environment files for testing and interacting with the **Xfini User API** locally or in staging/production environments.

---

## Files & Directory Structure

```text
.postman/
└── resources.yaml                        # Postman Git/Local workspace configuration (workspace ID & local resources)
postman/
├── collections/
│   ├── Xfini User API.collection.json   # Synced automatically in Postman Local View
│   └── xfini_user_api.json              # Direct import copy
├── environments/
│   ├── xfini_user_api.environment.yaml  # Synced automatically in Postman Local View
│   └── xfini_user_api.json              # Direct import copy
├── xfini_user_api.postman_collection.json  # Universal standalone Postman Collection (v2.1.0 schema)
├── xfini_user_api.postman_environment.json # Universal standalone Postman Environment
└── README.md                               # This documentation
```

---

## Getting Started

### Option A: Postman Local View (Automatic)

If you have opened this repository in **Postman Desktop** or **Postman for VS Code**:

1. Postman uses [`.postman/resources.yaml`](../.postman/resources.yaml) to automatically discover resources in `postman/collections/` and `postman/environments/`.
2. Open the **Local View** tab in Postman.
3. You will see **Xfini User API** under Collections and **Xfini User API (Local Environment)** under Environments automatically registered.

### Option B: Manual Import into Postman

1. Open the **Postman** desktop application or web console.
2. In the top-left sidebar, click **Import**.
3. Drag and drop both JSON files from `postman/`:
   - `postman/xfini_user_api.postman_collection.json`
   - `postman/xfini_user_api.postman_environment.json`
4. Confirm the import. You will now see:
   - **Collections:** `Xfini User API`
   - **Environments:** `Xfini User API (Local Environment)`

### 2. Select the Environment

In the top-right corner of Postman, select **Xfini User API (Local Environment)** from the environment dropdown menu.

---

## Environment Variables

| Variable           | Default Value           | Description                                                                                                     |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | `http://localhost:3001` | Base URL of the API server. Change to `http://localhost:5677` if accessing via the Docker Compose port mapping. |
| `idToken`          | _(auto-populated)_      | Firebase ID token used for Bearer authentication. Filled automatically upon running `POST /api/getToken`.       |
| `samplePlanMonths` | `16 DAYS PLAN`          | Valid active subscription plan name matched in Firestore `subscriptionPlans`.                                   |

---

## Authentication Flow

The API supports Firebase ID token authentication for administrative and secure endpoints:

1. Ensure `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `FIREBASE_API_KEY` are configured in your server's `.env` file.
2. Send the **`Authentication > Get Admin ID Token`** request (`POST {{baseUrl}}/api/getToken`).
3. The included **Postman Test Script** automatically captures `response.idToken` and persists it to both `pm.collectionVariables` and `pm.environment`.
4. Subsequent requests requiring authorization (e.g., `GET /expiring-students`) automatically pass `Authorization: Bearer {{idToken}}`.

```javascript
// Embedded test script in "Get Admin ID Token"
const jsonData = pm.response.json();
if (jsonData.idToken) {
  pm.collectionVariables.set('idToken', jsonData.idToken);
  if (pm.environment) {
    pm.environment.set('idToken', jsonData.idToken);
  }
}
```

---

## Collection Structure

### 1. Authentication

- **`POST /api/getToken`** (Get Admin ID Token)
  - Signs in with the server's admin credentials via Google Identity Toolkit REST API.
  - _Returns:_ `{ success: true, idToken: "...", expiresIn: "3600" }`
  - _Examples included:_ 200 Success, 401 Unauthorized (invalid credentials), 500 Missing Config.

### 2. Students & Subscriptions

- **`POST /create-student`** (Create Student)
  - Creates a Firebase Auth user, resolves plan and active courses (`[AT]`), writes `users/{uid}`, creates `subscriptions/{id}`, and sets custom claims.
  - _Body:_
    ```json
    {
      "firstName": "Jane",
      "lastName": "Doe",
      "email": "jane.doe@example.com",
      "role": "student",
      "planmonths": "16 DAYS PLAN"
    }
    ```
  - _Examples included:_ 200 Success, 400 Missing Fields, 400 Plan Not Found, 400 Email Already In Use.
- **`GET /expiring-students`** (Get Expiring Students - Tomorrow)
  - Returns active students whose subscriptions end on tomorrow's calendar date in `Asia/Kolkata` (`00:00:00` to `23:59:59`).
  - Deduplicates multiple records for the same student and excludes students who have another active subscription extending past tomorrow.
  - _Auth:_ `Bearer {{idToken}}`
  - _Examples included:_ 200 Success (with students), 200 Success (no expiries), 401 Unauthorized.
- **`GET /expiring-students?date=YYYY-MM-DD`** (Get Expiring Students - By Date)
  - Same as above, targeting a specific calendar date (e.g. `?date=2026-09-14`).
  - _Examples included:_ 200 Success, 400 Invalid Date Format.

### 3. Monitoring & Health

- **`GET /health`** (Health Check)
  - Basic server liveness check used by Docker and container orchestrators.
  - _Returns:_ `{ "status": "ok" }`
- **`GET /stats`** (API Stats)
  - Aggregated SQLite stats for `/create-student` successes and failures for today and the last 7 days.
  - _Returns:_ `{ success: true, today: { created, failed }, last7Days: { created, failed } }`

---

## Automated Tests Included

Every request in the collection includes pre-written JavaScript tests under the **Tests** tab to validate:

- Expected HTTP status codes (`200 OK`, `400 Bad Request`, `401 Unauthorized`).
- JSON response schema and required fields (`success: true`, `targetDate`, `students` array, etc.).
- Dynamic variable extraction (`idToken`, `lastCreatedUserId`, `lastSubscriptionId`).

---

## Running with Newman CLI

You can execute the entire collection automatically from the command line using [Newman](https://github.com/postmanlabs/newman):

```bash
# Run against local server using the environment file
npx newman run postman/xfini_user_api.postman_collection.json \
  -e postman/xfini_user_api.postman_environment.json
```
