process.env.FIREBASE_CREDENTIALS = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
});
// Set (not delete) so dotenv.config() in index.js — which only fills in unset
// keys — can't pull real admin credentials from a local .env file.
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.STATS_DB_PATH = ':memory:';
process.env.FIREBASE_API_KEY = 'test-api-key';
process.env.NODE_ENV = 'test';

const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');

function makeQuery(docs) {
  const snap = { empty: docs.length === 0, docs };
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => snap,
  };
  return query;
}

function makeDoc(id, data) {
  return { id, data: () => data };
}

// In-memory Firestore fake covering the collections index.js touches.
const firestoreState = {
  plans: [],
  courses: [],
  users: new Map(),
  subscriptions: [],
  throwError: false,
};

function resetFirestoreState() {
  firestoreState.plans = [makeDoc('plan-6mo', { name: '6', price: 100, isActive: true })];
  firestoreState.courses = [
    makeDoc('course-1', { isActive: true, title: 'Open Disclosure [AT]' }),
    makeDoc('course-2', { isActive: true, title: 'Open Disclosure', isTest: true }),
    makeDoc('course-3', { isActive: true, title: 'General Awareness' }),
  ];
  firestoreState.users = new Map();
  firestoreState.subscriptions = [];
  firestoreState.throwError = false;
}

function makeSubscriptionSnap(docs) {
  const normalizedDocs = docs.map((d) => (d.data ? d : makeDoc(d.id, d)));
  return {
    empty: normalizedDocs.length === 0,
    docs: normalizedDocs,
    size: normalizedDocs.length,
  };
}

function makeSubscriptionQuery(filters = []) {
  const query = {
    where: (field, op, val) => makeSubscriptionQuery([...filters, { field, op, val }]),
    limit: () => query,
    get: async () => {
      if (firestoreState.throwError) {
        const err = new Error('Simulated Firestore error');
        err.code = 'FIRESTORE_FAILED';
        throw err;
      }
      let docs = firestoreState.subscriptions.map((d) => (d.data ? d : makeDoc(d.id, d)));
      for (const { field, op, val } of filters) {
        docs = docs.filter((doc) => {
          const data = doc.data();
          let fieldVal = data[field];
          let compareVal = val;

          if (fieldVal && typeof fieldVal.toMillis === 'function') {
            fieldVal = fieldVal.toMillis();
          } else if (fieldVal instanceof Date) {
            fieldVal = fieldVal.getTime();
          }

          if (compareVal && typeof compareVal.toMillis === 'function') {
            compareVal = compareVal.toMillis();
          } else if (compareVal instanceof Date) {
            compareVal = compareVal.getTime();
          }

          if (op === '==') return fieldVal === compareVal;
          if (op === '>=') return fieldVal >= compareVal;
          if (op === '<=') return fieldVal <= compareVal;
          if (op === '>') return fieldVal > compareVal;
          if (op === '<') return fieldVal < compareVal;
          return true;
        });
      }
      return makeSubscriptionSnap(docs);
    },
  };
  return query;
}

const firestoreFake = () => ({
  collection: (name) => {
    if (firestoreState.throwError) {
      const err = new Error('Simulated Firestore error');
      err.code = 'FIRESTORE_FAILED';
      throw err;
    }
    if (name === 'subscriptionPlans') return makeQuery(firestoreState.plans);
    if (name === 'courses') return makeQuery(firestoreState.courses);
    if (name === 'users') {
      return {
        doc: (id) => ({
          set: async (data) => firestoreState.users.set(id, data),
          update: async (data) => firestoreState.users.set(id, { ...firestoreState.users.get(id), ...data }),
          get: async () => ({
            exists: firestoreState.users.has(id),
            data: () => firestoreState.users.get(id),
          }),
        }),
      };
    }
    if (name === 'subscriptions') {
      return {
        add: async (data) => {
          const id = `sub-${firestoreState.subscriptions.length + 1}`;
          firestoreState.subscriptions.push({ id, ...data });
          return { id };
        },
        where: (field, op, val) => makeSubscriptionQuery([{ field, op, val }]),
        get: async () => makeSubscriptionSnap(firestoreState.subscriptions),
      };
    }
    throw new Error(`Unexpected collection: ${name}`);
  },
});
firestoreFake.FieldValue = { serverTimestamp: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }) };
firestoreFake.Timestamp = {
  fromDate: (date) => ({
    toDate: () => date,
    toMillis: () => date.getTime(),
    toISOString: () => date.toISOString(),
  }),
};

let createdUsers = [];
const authFake = () => ({
  createUser: async ({ email, password, displayName }) => {
    const uid = `uid-${createdUsers.length + 1}`;
    createdUsers.push({ uid, email, password, displayName });
    return { uid };
  },
  getUser: async (uid) => {
    const user = createdUsers.find((u) => u.uid === uid);
    if (!user) {
      const err = new Error('User not found');
      err.code = 'auth/user-not-found';
      throw err;
    }
    return user;
  },
  verifyIdToken: async (token) => {
    if (token === 'valid-token') {
      return { uid: 'admin-uid', email: 'admin@example.com' };
    }
    const err = new Error('Invalid token');
    err.code = 'auth/argument-error';
    throw err;
  },
  setCustomUserClaims: async () => {},
  deleteUser: async () => {},
});

mock.module('../firebaseAdmin.js', {
  exports: {
    initializeApp: () => {},
    cert: () => ({}),
    getFirestore: firestoreFake,
    getAuth: authFake,
    FieldValue: firestoreFake.FieldValue,
    Timestamp: firestoreFake.Timestamp,
  },
});

const app = require('../index.js');

let server, baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST /create-student rejects missing fields', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects invalid email', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'not-an-email',
      planmonths: '6',
      role: 'student',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects emails without a domain dot', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'jane@doe', planmonths: '6', role: 'student' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects multiple @ signs', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@@doe.com',
      planmonths: '6',
      role: 'student',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects invalid role', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@doe.com',
      planmonths: '6',
      role: 'superadmin',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /create-student returns PLAN_NOT_FOUND for unknown plan', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@doe.com',
      planmonths: '99',
      role: 'student',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'PLAN_NOT_FOUND');
});

test('POST /create-student creates a student end-to-end', async () => {
  resetFirestoreState();
  createdUsers = [];

  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'jane',
      lastName: 'doe',
      email: 'jane@doe.com',
      planmonths: '6',
      role: 'student',
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.displayName, 'Jane Doe');
  assert.equal(body.password, 'jane@123');
  assert.equal(body.planId, 'plan-6mo');
  assert.equal(body.assignedCourses, 1); // only active non-test courses with [AT] in title are included

  const storedUser = firestoreState.users.get(body.userId);
  assert.deepEqual(storedUser.assignedCourseIds, ['course-1']);
});

test('POST /api/getToken fails without admin credentials configured', async () => {
  const res = await fetch(`${baseUrl}/api/getToken`, { method: 'POST' });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.success, false);
});

test('GET /stats reports created vs. failed /create-student attempts', async () => {
  // Every prior /create-student test in this file recorded a stat: 6 failed, 1 created.
  const res = await fetch(`${baseUrl}/stats`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.today.created, 1);
  assert.equal(body.today.failed, 6);
  assert.deepEqual(body.last7Days, body.today);
});

test('GET /expiring-students returns empty list when no subscriptions expire tomorrow', async () => {
  resetFirestoreState();
  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.students, []);
  assert.match(body.targetDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET /expiring-students returns students expiring tomorrow with full details', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  const tomorrowMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);
  const startSub = new Date(tomorrowMid.getTime() - 30 * 24 * 60 * 60 * 1000);

  firestoreState.users.set('user-exp-1', {
    email: 'student1@example.com',
    displayName: 'Student One',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-exp-1',
    userId: 'user-exp-1',
    planId: 'plan-1mo',
    planName: '1 Month Plan',
    startDate: firestoreFake.Timestamp.fromDate(startSub),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.targetDate, targetDate);
  assert.equal(body.count, 1);
  assert.equal(body.students.length, 1);

  const student = body.students[0];
  assert.equal(student.userId, 'user-exp-1');
  assert.equal(student.email, 'student1@example.com');
  assert.equal(student.displayName, 'Student One');
  assert.equal(student.planId, 'plan-1mo');
  assert.equal(student.planName, '1 Month Plan');
  assert.equal(student.subscriptionId, 'sub-exp-1');
  assert.equal(student.startDate, startSub.toISOString());
  assert.equal(student.endDate, tomorrowMid.toISOString());
  assert.equal(student.status, 'active');
});

test('GET /expiring-students does not return subscriptions expiring today', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  // 1 hour before tomorrow's start boundary = today in Asia/Kolkata
  const todayDate = new Date(bounds.start.getTime() - 60 * 60 * 1000);

  firestoreState.users.set('user-today', {
    email: 'today@example.com',
    displayName: 'Today Student',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-today',
    userId: 'user-today',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-01T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(todayDate),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.students, []);
});

test('GET /expiring-students does not return subscriptions expiring after tomorrow', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  // 1 hour after tomorrow's end boundary = day after tomorrow in Asia/Kolkata
  const afterTomorrow = new Date(bounds.end.getTime() + 60 * 60 * 1000);

  firestoreState.users.set('user-future', {
    email: 'future@example.com',
    displayName: 'Future Student',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-future',
    userId: 'user-future',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-15T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(afterTomorrow),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.students, []);
});

test('GET /expiring-students excludes cancelled or inactive subscriptions', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  const tomorrowMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);

  firestoreState.users.set('user-cancelled', {
    email: 'cancelled@example.com',
    displayName: 'Cancelled Student',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-cancelled',
    userId: 'user-cancelled',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'cancelled',
  });

  firestoreState.subscriptions.push({
    id: 'sub-expired',
    userId: 'user-cancelled',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'expired',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.students, []);
});

test('GET /expiring-students handles duplicate subscriptions for same student', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  const tomorrowMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);

  firestoreState.users.set('user-dup', {
    email: 'dup@example.com',
    displayName: 'Duplicate Student',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-old',
    userId: 'user-dup',
    planId: 'plan-1mo',
    planName: '1 Month Plan (Old)',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'active',
    createdAt: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
  });

  firestoreState.subscriptions.push({
    id: 'sub-new',
    userId: 'user-dup',
    planId: 'plan-1mo',
    planName: '1 Month Plan (New)',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'active',
    createdAt: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T01:00:00.000Z')),
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.students.length, 1);
  assert.equal(body.students[0].subscriptionId, 'sub-new');
  assert.equal(body.students[0].planName, '1 Month Plan (New)');
});

test('GET /expiring-students excludes student who has a future active subscription', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  const tomorrowMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);
  const nextMonth = new Date(tomorrowMid.getTime() + 30 * 24 * 60 * 60 * 1000);

  firestoreState.users.set('user-renewed', {
    email: 'renewed@example.com',
    displayName: 'Renewed Student',
    role: 'student',
  });

  // Old sub expiring tomorrow
  firestoreState.subscriptions.push({
    id: 'sub-old-expiring',
    userId: 'user-renewed',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'active',
  });

  // New sub extended to next month
  firestoreState.subscriptions.push({
    id: 'sub-future-active',
    userId: 'user-renewed',
    planId: 'plan-2mo',
    planName: '2 Month',
    startDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    endDate: firestoreFake.Timestamp.fromDate(nextMonth),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.students, []);
});

test('GET /expiring-students falls back to Auth user when Firestore user doc is missing email', async () => {
  resetFirestoreState();
  const targetDate = app.getTomorrowDateStr('Asia/Kolkata');
  const bounds = app.getDayBoundsInTimezone(targetDate, 'Asia/Kolkata');
  const tomorrowMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);

  createdUsers.push({
    uid: 'auth-only-uid',
    email: 'auth-user@example.com',
    displayName: 'Auth User Name',
  });

  firestoreState.subscriptions.push({
    id: 'sub-auth-fallback',
    userId: 'auth-only-uid',
    planId: 'plan-1mo',
    planName: '1 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-13T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(tomorrowMid),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.students[0].email, 'auth-user@example.com');
  assert.equal(body.students[0].displayName, 'Auth User Name');
});

test('GET /expiring-students supports ?date=YYYY-MM-DD parameter', async () => {
  resetFirestoreState();
  const bounds = app.getDayBoundsInTimezone('2026-11-20', 'Asia/Kolkata');
  const targetMid = new Date(bounds.start.getTime() + 12 * 60 * 60 * 1000);

  firestoreState.users.set('user-nov', {
    email: 'nov@example.com',
    displayName: 'Nov Student',
    role: 'student',
  });

  firestoreState.subscriptions.push({
    id: 'sub-nov',
    userId: 'user-nov',
    planId: 'plan-3mo',
    planName: '3 Month',
    startDate: firestoreFake.Timestamp.fromDate(new Date('2026-08-20T00:00:00.000Z')),
    endDate: firestoreFake.Timestamp.fromDate(targetMid),
    status: 'active',
  });

  const res = await fetch(`${baseUrl}/expiring-students?date=2026-11-20`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.targetDate, '2026-11-20');
  assert.equal(body.count, 1);
  assert.equal(body.students[0].subscriptionId, 'sub-nov');
});

test('GET /expiring-students rejects invalid ?date format with 400 INVALID_INPUT', async () => {
  const res = await fetch(`${baseUrl}/expiring-students?date=not-a-valid-date`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('GET /expiring-students returns 500 when Firestore query fails', async () => {
  resetFirestoreState();
  firestoreState.throwError = true;

  const res = await fetch(`${baseUrl}/expiring-students`);
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.code, 'FIRESTORE_FAILED');
});

test('GET /expiring-students validates authorization header if provided', async () => {
  resetFirestoreState();

  // Invalid token fails with 401 UNAUTHORIZED
  const resInvalid = await fetch(`${baseUrl}/expiring-students`, {
    headers: { Authorization: 'Bearer bad-token' },
  });
  const bodyInvalid = await resInvalid.json();
  assert.equal(resInvalid.status, 401);
  assert.equal(bodyInvalid.code, 'UNAUTHORIZED');

  // Valid token succeeds
  const resValid = await fetch(`${baseUrl}/expiring-students`, {
    headers: { Authorization: 'Bearer valid-token' },
  });
  const bodyValid = await resValid.json();
  assert.equal(resValid.status, 200);
  assert.equal(bodyValid.success, true);
});
