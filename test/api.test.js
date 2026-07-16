process.env.FIREBASE_CREDENTIALS = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n'
});
// Set (not delete) so dotenv.config() in index.js — which only fills in unset
// keys — can't pull real admin credentials from a local .env file.
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.FIREBASE_API_KEY = 'test-api-key';
process.env.STATS_DB_PATH = ':memory:';

const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');

function makeQuery(docs) {
  const snap = { empty: docs.length === 0, docs };
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => snap
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
  subscriptions: []
};

function resetFirestoreState() {
  firestoreState.plans = [makeDoc('plan-6mo', { name: '6', price: 100, isActive: true })];
  firestoreState.courses = [
    makeDoc('course-1', { isActive: true }),
    makeDoc('course-2', { isActive: true, isTest: true })
  ];
  firestoreState.users = new Map();
  firestoreState.subscriptions = [];
}

const firestoreFake = () => ({
  collection: name => {
    if (name === 'subscriptionPlans') return makeQuery(firestoreState.plans);
    if (name === 'courses') return makeQuery(firestoreState.courses);
    if (name === 'users') {
      return {
        doc: id => ({
          set: async data => firestoreState.users.set(id, data),
          update: async data => firestoreState.users.set(id, { ...firestoreState.users.get(id), ...data })
        })
      };
    }
    if (name === 'subscriptions') {
      return {
        add: async data => {
          const id = `sub-${firestoreState.subscriptions.length + 1}`;
          firestoreState.subscriptions.push({ id, ...data });
          return { id };
        }
      };
    }
    throw new Error(`Unexpected collection: ${name}`);
  }
});
firestoreFake.FieldValue = { serverTimestamp: () => ({ toDate: () => new Date() }) };
firestoreFake.Timestamp = { fromDate: date => ({ toDate: () => date }) };

let createdUsers = [];
const authFake = () => ({
  createUser: async ({ email, password, displayName }) => {
    const uid = `uid-${createdUsers.length + 1}`;
    createdUsers.push({ uid, email, password, displayName });
    return { uid };
  },
  setCustomUserClaims: async () => {},
  deleteUser: async () => {}
});

mock.module('firebase-admin', {
  exports: {
    default: {
      initializeApp: () => {},
      cert: () => ({}),
      firestore: firestoreFake,
      auth: authFake
    }
  }
});

const app = require('../index.js');

let server, baseUrl;

before(async () => {
  await new Promise(resolve => {
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
    body: JSON.stringify({ firstName: 'Jane' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects invalid email', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'not-an-email', planmonths: '6', role: 'student' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects emails without a domain dot', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'jane@doe', planmonths: '6', role: 'student' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects multiple @ signs', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'jane@@doe.com', planmonths: '6', role: 'student' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 'INVALID_INPUT');
});

test('POST /create-student rejects invalid role', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'jane@doe.com', planmonths: '6', role: 'superadmin' })
  });
  assert.equal(res.status, 400);
});

test('POST /create-student returns PLAN_NOT_FOUND for unknown plan', async () => {
  const res = await fetch(`${baseUrl}/create-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', email: 'jane@doe.com', planmonths: '99', role: 'student' })
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
    body: JSON.stringify({ firstName: 'jane', lastName: 'doe', email: 'jane@doe.com', planmonths: '6', role: 'student' })
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.displayName, 'Jane Doe');
  assert.equal(body.password, 'jane@123');
  assert.equal(body.planId, 'plan-6mo');
  assert.equal(body.assignedCourses, 1); // course-2 is isTest and excluded

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
