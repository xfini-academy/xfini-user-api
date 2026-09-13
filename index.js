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
    const status = res.locals.actualStatusCode || res.statusCode;
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

// If client (such as n8n) sends "axios: true", suppress 4xx/5xx HTTP status codes
// and respond with HTTP 200 so n8n's Axios library does not throw an AxiosError string.
app.use((req, res, next) => {
  const wantsStatus200 =
    req.headers['axios'] === 'true' || req.headers['x-axios'] === 'true' || req.query.suppressStatus === 'true';

  if (wantsStatus200) {
    const origStatus = res.status.bind(res);
    res.status = (code) => {
      res.locals.actualStatusCode = code;
      return res;
    };

    const origJson = res.json.bind(res);
    res.json = (data) => {
      origStatus(200);
      return origJson(data);
    };

    const origSend = res.send.bind(res);
    res.send = (body) => {
      origStatus(200);
      return origSend(body);
    };
  }

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

function getTomorrowDateStr(timeZone = 'Asia/Kolkata', now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now);
  const [y, m, d] = todayStr.split('-').map(Number);
  const dObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dObj.setUTCDate(dObj.getUTCDate() + 1);
  return formatter.format(dObj);
}

function getDayBoundsInTimezone(dateStr, timeZone = 'Asia/Kolkata') {
  const [year, month, day] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = dtf.formatToParts(guess);
  const p = {};
  for (const part of parts) {
    p[part.type] = part.value;
  }
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    p.hour === '24' ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const offset = asUTC - guess.getTime();
  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offset;
  const start = new Date(startMs);
  const end = new Date(startMs + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

// GET /expiring-students
app.get('/expiring-students', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.REQUIRE_AUTH === 'true' && !authHeader) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Authorization header is required.',
    });
  }

  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    try {
      await auth.verifyIdToken(token);
    } catch {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        error: 'Invalid or expired authorization token.',
      });
    }
  }

  const timeZone = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';

  let targetDate;
  if (req.query.date) {
    if (
      typeof req.query.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ||
      isNaN(Date.parse(req.query.date))
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_INPUT',
        error: 'Invalid date format. Expected YYYY-MM-DD.',
      });
    }
    targetDate = req.query.date;
  } else {
    targetDate = getTomorrowDateStr(timeZone, new Date());
  }

  try {
    const bounds = getDayBoundsInTimezone(targetDate, timeZone);
    const startTimestamp = Timestamp.fromDate(bounds.start);
    const endTimestamp = Timestamp.fromDate(bounds.end);

    const subsSnapshot = await db
      .collection('subscriptions')
      .where('status', '==', 'active')
      .where('endDate', '>=', startTimestamp)
      .where('endDate', '<=', endTimestamp)
      .get();

    if (subsSnapshot.empty) {
      return res.status(200).json({
        success: true,
        targetDate,
        count: 0,
        students: [],
      });
    }

    // Deduplicate by userId, keeping the most recently updated/created subscription doc
    const subsByUser = new Map();
    for (const doc of subsSnapshot.docs) {
      const data = doc.data();
      const userId = data.userId;
      if (!userId) continue;

      const existing = subsByUser.get(userId);
      if (!existing) {
        subsByUser.set(userId, { doc, data });
      } else {
        const toMillis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : new Date(t || 0).getTime());
        const existingTime = toMillis(existing.data.updatedAt) || toMillis(existing.data.createdAt) || 0;
        const currentTime = toMillis(data.updatedAt) || toMillis(data.createdAt) || 0;
        if (currentTime > existingTime) {
          subsByUser.set(userId, { doc, data });
        }
      }
    }

    const studentPromises = Array.from(subsByUser.entries()).map(async ([userId, { doc, data }]) => {
      // Check if user has another active subscription ending AFTER the target date
      const userSubsSnap = await db.collection('subscriptions').where('userId', '==', userId).get();

      const hasFutureActiveSub = userSubsSnap.docs.some((sDoc) => {
        if (sDoc.id === doc.id) return false;
        const sData = sDoc.data();
        if (sData.status !== 'active' || !sData.endDate) return false;
        const subEndMs =
          typeof sData.endDate.toMillis === 'function' ? sData.endDate.toMillis() : new Date(sData.endDate).getTime();
        return subEndMs > bounds.end.getTime();
      });

      if (hasFutureActiveSub) {
        return null;
      }

      let email = '';
      let displayName = '';
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        const uData = userDoc.data();
        email = uData.email || '';
        displayName = uData.displayName || '';
      }

      // Fallback to Firebase Auth if email is not found in Firestore
      if (!email) {
        try {
          const authUser = await auth.getUser(userId);
          email = email || authUser.email || '';
          displayName = displayName || authUser.displayName || '';
        } catch {
          // Non-fatal if auth lookup fails
        }
      }

      const toIsoString = (val) => {
        if (!val) return null;
        if (typeof val.toDate === 'function') return val.toDate().toISOString();
        return new Date(val).toISOString();
      };

      return {
        userId,
        email,
        displayName,
        planId: data.planId || '',
        planName: data.planName || '',
        subscriptionId: doc.id,
        startDate: toIsoString(data.startDate),
        endDate: toIsoString(data.endDate),
        status: data.status,
      };
    });

    const students = (await Promise.all(studentPromises)).filter(Boolean);

    return res.status(200).json({
      success: true,
      targetDate,
      count: students.length,
      students,
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('Failed to fetch expiring students:', error);
    }
    return res.status(500).json({
      success: false,
      code: error.code || 'FIRESTORE_FAILED',
      error: error.message || 'Failed to fetch expiring students.',
    });
  }
});

function makeStudentResponse(overrides = {}) {
  return {
    success: false,
    userId: null,
    email: null,
    displayName: null,
    password: null,
    role: null,
    planName: null,

    planId: null,
    subscriptionId: null,
    assignedCourses: 0,
    endDate: null,
    code: null,
    error: null,
    ...overrides,
  };
}

// POST /create-student
app.post('/create-student', async (req, res) => {
  const { firstName, lastName, planmonths, role } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';

  const toProper = (str) =>
    typeof str === 'string'
      ? str
          .trim()
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase())
      : '';

  const displayName = firstName && lastName ? `${toProper(firstName)} ${toProper(lastName)}` : null;
  const password = typeof firstName === 'string' && firstName.trim() ? `${firstName.trim().toLowerCase()}@123` : null;

  // Step 1 — Validate input
  if (!firstName || !lastName || !email || !planmonths || !role) {
    return res.status(400).json(
      makeStudentResponse({
        success: false,
        error: 'All fields are required: firstName, lastName, email, planmonths, role.',
        code: 'INVALID_INPUT',
        email: email || null,
        displayName,
        password,
        role: role || null,
      }),
    );
  }
  if (!isValidEmail(email)) {
    return res.status(400).json(
      makeStudentResponse({
        success: false,
        error: 'Invalid email address format.',
        code: 'INVALID_INPUT',
        email,
        displayName,
        password,
        role,
      }),
    );
  }
  if (!['student', 'admin'].includes(role)) {
    return res.status(400).json(
      makeStudentResponse({
        success: false,
        error: 'role must be "student" or "admin".',
        code: 'INVALID_INPUT',
        email,
        displayName,
        password,
        role,
      }),
    );
  }

  const months = parseInt(planmonths, 10);
  if (isNaN(months) || months <= 0) {
    return res.status(400).json(
      makeStudentResponse({
        success: false,
        error: 'Invalid planmonths value.',
        code: 'INVALID_INPUT',
        email,
        displayName,
        password,
        role,
      }),
    );
  }

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
      return res.status(400).json(
        makeStudentResponse({
          success: false,
          error: `No active plan found with name "${planmonths}".`,
          code: 'PLAN_NOT_FOUND',
          email,
          displayName,
          password,
          role,
        }),
      );
    }

    const planDoc = plansSnap.docs[0];
    planId = planDoc.id;
    ({ name: planName, price } = planDoc.data());
  } catch (err) {
    return res.status(500).json(
      makeStudentResponse({
        success: false,
        error: `Failed to fetch plan: ${err.message}`,
        code: 'FIRESTORE_FAILED',
        email,
        displayName,
        password,
        role,
      }),
    );
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
    console.log(
      `[${new Date().toISOString()}] Courses for ${displayName} (${email}): ${coursesSnap.size} active, ${assignedCourseIds.length} matched "[AT]" and assigned`,
    );
  } catch (err) {
    return res.status(500).json(
      makeStudentResponse({
        success: false,
        error: `Failed to fetch courses: ${err.message}`,
        code: 'FIRESTORE_FAILED',
        email,
        displayName,
        password,
        role,
        planName,
        planId,
      }),
    );
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

    return res.status(200).json(
      makeStudentResponse({
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
      }),
    );
  } catch (error) {
    if (uid) {
      try {
        await auth.deleteUser(uid);
      } catch (cleanupErr) {
        console.warn('Failed to delete orphaned auth user:', cleanupErr.message);
      }
    }
    console.error(error);
    return res.status(400).json(
      makeStudentResponse({
        success: false,
        code: error.code || 'AUTH_FAILED',
        error: error.message || 'Unknown error',
        email,
        displayName,
        password,
        role,
        planName: planName || null,
        planId: planId || null,
        assignedCourses: assignedCourseIds ? assignedCourseIds.length : 0,
      }),
    );
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Xfini Academy User API Server Running on http://localhost:${PORT}`));
}

app.getTomorrowDateStr = getTomorrowDateStr;
app.getDayBoundsInTimezone = getDayBoundsInTimezone;

module.exports = app;
