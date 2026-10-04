import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';

test('Database DDL contains all required tables and indexes', () => {
  const schemaPath = path.resolve('db/migrations/001_initial_schema.sql');
  const ddl = fs.readFileSync(schemaPath, 'utf8');

  const requiredTables = [
    'organizations',
    'users',
    'roles',
    'user_roles',
    'sessions',
    'exams',
    'exam_assignments',
    'questions',
    'question_versions',
    'question_options',
    'exam_questions',
    'attempts',
    'attempt_questions',
    'answers',
    'scores',
    'audit_events'
  ];

  for (const table of requiredTables) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'), `Missing table: ${table}`);
  }

  const requiredIndexes = [
    'idx_users_org_username',
    'idx_exams_org_status',
    'idx_attempts_participant_state',
    'idx_attempts_exam_participant',
    'idx_answers_attempt_qversion',
    'idx_audit_events_org_created'
  ];

  for (const idx of requiredIndexes) {
    assert.match(ddl, new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}`, 'i'), `Missing index: ${idx}`);
  }
});

test('HTTP server handles health and authorization boundaries', async () => {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');

    // 2. Auth boundary: unauthenticated request to /auth/me must be rejected
    const unauthRes = await fetch(`${baseUrl}/api/v1/auth/me`);
    assert.equal(unauthRes.status, 401);

    // 3. Login to obtain valid session token
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'participant01', password: 'Password123!' })
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();

    // 4. Auth boundary: authenticated request accepted
    const authRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${loginData.token}` }
    });
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json();
    assert.equal(authBody.user.role, 'PARTICIPANT');

    // 5. Unknown endpoint returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/v1/unknown`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
