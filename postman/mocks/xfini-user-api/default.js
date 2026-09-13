/**
 * Mock server for Xfini User API
 * Port: 4010 (default) or process.env.MOCK_PORT
 */
require('dotenv').config();
const http = require('http');
const { URL } = require('url');

const PORT = process.env.MOCK_PORT || 4010;

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // Helper to respond JSON
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data, null, 2));
  };

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    return sendJson(200, { status: 'ok', uptime: 123.45 });
  }

  // GET /stats
  if (method === 'GET' && pathname === '/stats') {
    return sendJson(200, {
      success: true,
      stats: {
        today: { created: 12, failed: 1 },
        last7Days: { created: 84, failed: 4 },
      },
    });
  }

  // POST /api/getToken
  if (method === 'POST' && pathname === '/api/getToken') {
    return sendJson(200, {
      success: true,
      idToken: 'mock-firebase-id-token-eyJhGciOi...123456789',
      expiresIn: '3600',
    });
  }

  // POST /create-student
  if (method === 'POST' && pathname === '/create-student') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.email || !payload.firstName || !payload.lastName) {
          return sendJson(400, {
            error: 'MISSING_FIELDS',
            message: 'firstName, lastName, and email are required.',
          });
        }
        return sendJson(200, {
          success: true,
          student: {
            uid: 'mock_uid_' + Math.floor(Math.random() * 100000),
            name: `${payload.firstName} ${payload.lastName}`,
            email: payload.email,
            role: payload.role || 'student',
            planmonths: payload.planmonths || '16 DAYS PLAN',
            activeCourseIds: ['course_mock_at_1'],
          },
        });
      } catch (e) {
        return sendJson(400, { error: 'INVALID_JSON', message: e.message });
      }
    });
    return;
  }

  // GET /expiring-students
  if (method === 'GET' && pathname === '/expiring-students') {
    const targetDate = urlObj.searchParams.get('date') || '2026-09-14';
    return sendJson(200, {
      success: true,
      date: targetDate,
      count: 2,
      students: [
        {
          userId: 'mock_user_1',
          name: 'Alex Johnson',
          email: 'alex.johnson@example.com',
          planName: '16 DAYS PLAN',
          planId: 'plan_16_days',
          endDate: `${targetDate}T18:29:59.999Z`,
        },
        {
          userId: 'mock_user_2',
          name: 'Priya Sharma',
          email: 'priya.sharma@example.com',
          planName: '3 MONTHS PLAN',
          planId: 'plan_3_months',
          endDate: `${targetDate}T18:29:59.999Z`,
        },
      ],
    });
  }

  // Root or template
  if (pathname === '/') {
    return sendJson(200, {
      service: 'Xfini User API Mock Server',
      status: 'active',
      endpoints: ['GET /health', 'GET /stats', 'POST /api/getToken', 'POST /create-student', 'GET /expiring-students'],
    });
  }

  // 404 fallback
  return sendJson(404, { error: 'NOT_FOUND', message: `Route ${method} ${pathname} not found in mock server` });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Mock Server] Xfini User API Mock running on http://localhost:${PORT}`);
  });
}

module.exports = server;
