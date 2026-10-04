import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { createServer } from '../src/server.js';

test('Password hashing produces valid salted hashes and verifies correctly', () => {
  const pwd = 'TestPassword123!';
  const hashed = hashPassword(pwd);
  assert.notEqual(hashed, pwd);
  assert.ok(hashed.includes(':'));
  assert.equal(verifyPassword(pwd, hashed), true);
  assert.equal(verifyPassword('WrongPassword', hashed), false);
});

test('Auth flow: Login, authenticate /auth/me, logout, and verify invalidation', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/v1/auth`;

  try {
    // 1. Login with invalid credentials -> 401
    const badLoginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'participant01', password: 'WrongPassword' })
    });
    assert.equal(badLoginRes.status, 401);

    // 2. Login with valid credentials -> 200 + token
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'participant01', password: 'Password123!' })
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.ok(loginData.token);
    assert.equal(loginData.user.username, 'participant01');
    assert.equal(loginData.user.role, 'PARTICIPANT');

    const token = loginData.token;

    // 3. GET /auth/me with valid Bearer token -> 200
    const meRes = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.user.id, 'usr_part_01');
    assert.equal(meData.user.role, 'PARTICIPANT');

    // 4. POST /auth/logout -> 200
    const logoutRes = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(logoutRes.status, 200);

    // 5. GET /auth/me after logout -> 401 Unauthorized (session invalidated)
    const afterLogoutRes = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(afterLogoutRes.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
