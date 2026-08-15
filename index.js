require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert, getAuth, getFirestore, FieldValue, Timestamp } = require('./firebaseAdmin');

const statsDbPath = process.env.STATS_DB_PATH || path.join(__dirname, 'data', 'stats.db');
fs.mkdirSync(path.dirname(statsDbPath), { recursive: true });
const statsDb = new DatabaseSync(statsDbPath);
statsDb.exec(`
  CREATE TABLE IF NOT EXISTS api_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    success INTEGER NOT NULL,
    status_code INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )
`);
const recordStat = statsDb.prepare(
  'INSERT INTO api_stats (path, success, status_code, created_at) VALUES (?, ?, ?, ?)',
);
const countStats = statsDb.prepare(`
  SELECT
    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS created,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
  FROM api_stats
  WHERE path = ? AND created_at >= ?
`);

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const serviceAccount = process.env.FIREBASE_CREDENTIALS
  ? JSON.parse(process.env.FIREBASE_CREDENTIALS)
  : require('./serviceAccount.json');

initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();
const auth = getAuth();

const app = express();
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : null;

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const color = status < 400 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const label = status < 400 ? 'SUCCESS' : 'FAILED';
    console.log(
      `[${timestamp}] ${req.method} ${req.path}${body ? ` — body: ${body}` : ''} → ${color}${status} ${label}${reset} (${ms}ms)`,
    );

    if (req.path === '/create-student') {
      try {
        recordStat.run(req.path, status < 400 ? 1 : 0, status, new Date().toISOString());
      } catch (err) {
        console.error('Failed to record stat:', err.message);
      }
    }
  });

  next();
});

// POST /api/getToken — signs in using credentials from .env and returns a fresh ID token
app.post('/api/getToken', async (req, res) => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, error: 'ADMIN_EMAIL or ADMIN_PASSWORD not set in .env' });
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || 'Sign-in failed.';
      return res.status(401).json({ success: false, error: msg });
    }

    return res.status(200).json({
      success: true,
      idToken: data.idToken,
      expiresIn: data.expiresIn, // seconds until token expires (3600 = 1 hour)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: `Failed to get token: ${err.message}` });
  }
});

// Linear-time email check (no backtracking-prone regex) — avoids ReDoS on attacker-controlled input.
function isValidEmail(email) {
  if (/\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// GET /stats — /create-student created vs. failed counts, today and last 7 days
app.get('/stats', (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - 6);

    const zeroIfNull = (row) => ({ created: row.created || 0, failed: row.failed || 0 });

    res.json({
      success: true,
      today: zeroIfNull(countStats.get('/create-student', startOfDay.toISOString())),
      last7Days: zeroIfNull(countStats.get('/create-student', startOfWeek.toISOString())),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `Failed to fetch stats: ${err.message}` });
  }
});

// POST /create-student
app.post('/create-student', async (req, res) => {
  const { firstName, lastName, planmonths, role } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';

  // Step 1 — Validate input
  if (!firstName || !lastName || !email || !planmonths || !role) {
    return res.status(400).json({
      success: false,
      error: 'All fields are required: firstName, lastName, email, planmonths, role.',
      code: 'INVALID_INPUT',
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email address format.', code: 'INVALID_INPUT' });
  }
  if (!['student', 'admin'].includes(role)) {
    return res.status(400).json({ success: false, error: 'role must be "student" or "admin".', code: 'INVALID_INPUT' });
  }

  const password = `${firstName.trim().toLowerCase()}@123`;
  const months = parseInt(planmonths, 10);
  if (isNaN(months) || months <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid planmonths value.', code: 'INVALID_INPUT' });
  }

  const toProper = (str) =>
    str
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const displayName = `${toProper(firstName)} ${toProper(lastName)}`;

  // Step 2 — Resolve subscription plan from Firestore
  let planId, planName, price;
  try {
    const plansSnap = await db
      .collection('subscriptionPlans')
      .where('name', '==', planmonths)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (plansSnap.empty) {
      return res
        .status(400)
        .json({ success: false, error: `No active plan found with name "${planmonths}".`, code: 'PLAN_NOT_FOUND' });
    }

    const planDoc = plansSnap.docs[0];
    planId = planDoc.id;
    ({ name: planName, price } = planDoc.data());
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: `Failed to fetch plan: ${err.message}`, code: 'FIRESTORE_FAILED' });
  }

  // Step 3 — Get active course IDs
  let assignedCourseIds;
  try {
    const coursesSnap = await db.collection('courses').where('isActive', '==', true).get();
    assignedCourseIds = coursesSnap.docs
      .filter((d) => {
        const course = d.data();
        return !course.isTest && typeof course.title === 'string' && course.title.includes('[AT]');
      })
      .map((d) => d.id);
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: `Failed to fetch courses: ${err.message}`, code: 'FIRESTORE_FAILED' });
  }

  // Steps 4–8 — Auth + Firestore writes (cleanup on failure)
  let uid;
  try {
    // Step 4 — Create Firebase Auth user
    const userRecord = await auth.createUser({ email, password, displayName });
    uid = userRecord.uid;

    // Step 5 — Write users/{uid}
    await db
      .collection('users')
      .doc(uid)
      .set({
        email,
        displayName,
        role,
        assignedModules: [],
        assignedCourseIds: [],
        deviceRestriction: {
          enabled: true,
          registeredDeviceId: null,
          registeredAt: null,
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

    // Step 6 — Write subscriptions
    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + months);

    const subscriptionRef = await db.collection('subscriptions').add({
      userId: uid,
      planId,
      planName,
      startDate: Timestamp.fromDate(now),
      endDate: Timestamp.fromDate(endDate),
      status: 'active',
      price,
      notificationsSent: {
        studentPreExpiry: false,
        adminPreExpiry: false,
      },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Step 7 — Update users/{uid} with course IDs
    await db.collection('users').doc(uid).update({
      assignedCourseIds,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Step 8 — Set custom claims (non-fatal)
    try {
      await auth.setCustomUserClaims(uid, { role, assignedCourseIds });
    } catch (e) {
      console.warn('Custom claims failed (non-fatal):', e.message);
    }

    return res.status(200).json({
      success: true,
      userId: uid,
      email,
      displayName,
      password,
      role,
      planName,
      planId,
      subscriptionId: subscriptionRef.id,
      assignedCourses: assignedCourseIds.length,
      endDate: endDate.toISOString(),
    });
  } catch (error) {
    if (uid) {
      try {
        await auth.deleteUser(uid);
      } catch (cleanupErr) {
        console.warn('Failed to delete orphaned auth user:', cleanupErr.message);
      }
    }
    console.error(error);
    return res.status(400).json({
      success: false,
      code: error.code || 'AUTH_FAILED',
      error: error.message || 'Unknown error',
    });
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Xfini Academy User API Server Running on http://localhost:${PORT}`));
}

module.exports = app;
