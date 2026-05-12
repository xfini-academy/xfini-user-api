require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const serviceAccount = process.env.FIREBASE_CREDENTIALS
  ? JSON.parse(process.env.FIREBASE_CREDENTIALS)
  : require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : null;
  console.log(`[${timestamp}] ${req.method} ${req.path}${body ? ` — body: ${body}` : ''}`);

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const color = status < 400 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const label = status < 400 ? 'SUCCESS' : 'FAILED';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${color}${status} ${label}${reset} (${ms}ms)`);
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
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || 'Sign-in failed.';
      return res.status(401).json({ success: false, error: msg });
    }

    return res.status(200).json({
      success: true,
      idToken: data.idToken,
      expiresIn: data.expiresIn  // seconds until token expires (3600 = 1 hour)
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: `Failed to get token: ${err.message}` });
  }
});


// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// POST /create-student
app.post('/create-student', async (req, res) => {
  const { firstName, lastName, planmonths, role } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';

  // Step 1 — Validate input
  if (!firstName || !lastName || !email || !planmonths || !role) {
    return res.status(400).json({ success: false, error: 'All fields are required: firstName, lastName, email, planmonths, role.', code: 'INVALID_INPUT' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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

  const toProper = str => str.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const displayName = `${toProper(firstName)} ${toProper(lastName)}`;

  // Step 2 — Resolve subscription plan from Firestore
  let planId, planName, price;
  try {
    const plansSnap = await admin.firestore()
      .collection('subscriptionPlans')
      .where('name', '==', planmonths)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (plansSnap.empty) {
      return res.status(400).json({ success: false, error: `No active plan found with name "${planmonths}".`, code: 'PLAN_NOT_FOUND' });
    }

    const planDoc = plansSnap.docs[0];
    planId = planDoc.id;
    ({ name: planName, price } = planDoc.data());
  } catch (err) {
    return res.status(500).json({ success: false, error: `Failed to fetch plan: ${err.message}`, code: 'FIRESTORE_FAILED' });
  }

  // Step 3 — Get active course IDs
  let assignedCourseIds = [];
  try {
    const coursesSnap = await admin.firestore()
      .collection('courses')
      .where('isActive', '==', true)
      .get();
    assignedCourseIds = coursesSnap.docs.filter(d => !d.data().isTest).map(d => d.id);
  } catch (err) {
    return res.status(500).json({ success: false, error: `Failed to fetch courses: ${err.message}`, code: 'FIRESTORE_FAILED' });
  }

  // Steps 4–8 — Auth + Firestore writes (cleanup on failure)
  let uid;
  try {
    // Step 4 — Create Firebase Auth user
    const userRecord = await admin.auth().createUser({ email, password, displayName });
    uid = userRecord.uid;

    // Step 5 — Write users/{uid}
    await admin.firestore().collection('users').doc(uid).set({
      email,
      displayName,
      role,
      assignedModules: [],
      assignedCourseIds: [],
      deviceRestriction: {
        enabled: true,
        registeredDeviceId: null,
        registeredAt: null
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Step 6 — Write subscriptions
    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + months);

    const subscriptionRef = await admin.firestore().collection('subscriptions').add({
      userId: uid,
      planId,
      planName,
      startDate: admin.firestore.Timestamp.fromDate(now),
      endDate: admin.firestore.Timestamp.fromDate(endDate),
      status: 'active',
      price,
      notificationsSent: {
        studentPreExpiry: false,
        adminPreExpiry: false
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Step 7 — Update users/{uid} with course IDs
    await admin.firestore().collection('users').doc(uid).update({
      assignedCourseIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Step 8 — Set custom claims (non-fatal)
    try {
      await admin.auth().setCustomUserClaims(uid, { role, assignedCourseIds });
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
      endDate: endDate.toISOString()
    });

  } catch (error) {
    if (uid) {
      try { await admin.auth().deleteUser(uid); } catch (_) {}
    }
    console.error(error);
    return res.status(400).json({
      success: false,
      code: error.code || 'AUTH_FAILED',
      error: error.message || 'Unknown error'
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Xfini Academy User API Server Running on http://localhost:${PORT}`));
