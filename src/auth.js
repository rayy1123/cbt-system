import crypto from 'node:crypto';

// ponytail: in-memory store; replace with PostgreSQL pg client queries when DB connection pool configured.
const memoryUsers = new Map();
const memorySessions = new Map(); // tokenHash -> session

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, combined) {
  const [salt, key] = combined.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

export function seedUser({ id, username, password, role, organizationId = 'org_default' }) {
  const passwordHash = hashPassword(password);
  const user = {
    id,
    organization_id: organizationId,
    username,
    password_hash: passwordHash,
    role,
    status: 'ACTIVE'
  };
  memoryUsers.set(username, user);
  return user;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function login(username, password) {
  const user = memoryUsers.get(username);
  if (!user || user.status !== 'ACTIVE') {
    return { success: false, error: 'Invalid credentials' };
  }

  if (!verifyPassword(password, user.password_hash)) {
    return { success: false, error: 'Invalid credentials' };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const ttlMs = 8 * 60 * 60 * 1000; // 8 hours

  const session = {
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: tokenHash,
    role: user.role,
    organization_id: user.organization_id,
    expires_at: Date.now() + ttlMs,
    invalidated_at: null
  };

  memorySessions.set(tokenHash, session);

  return {
    success: true,
    token: rawToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      organization_id: user.organization_id
    }
  };
}

export function authenticate(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = memorySessions.get(tokenHash);

  if (!session) return null;
  if (session.invalidated_at) return null;
  if (Date.now() > session.expires_at) return null;

  return {
    id: session.user_id,
    role: session.role,
    organization_id: session.organization_id
  };
}

export function logout(rawToken) {
  if (!rawToken) return false;
  const tokenHash = hashToken(rawToken);
  const session = memorySessions.get(tokenHash);
  if (!session) return false;

  session.invalidated_at = Date.now();
  return true;
}

// Seed default accounts for dev/testing
seedUser({ id: 'usr_part_01', username: 'participant01', password: 'Password123!', role: 'PARTICIPANT' });
seedUser({ id: 'usr_proc_01', username: 'proctor01', password: 'Password123!', role: 'PROCTOR' });
seedUser({ id: 'usr_teach_01', username: 'teacher01', password: 'Password123!', role: 'TEACHER' });
seedUser({ id: 'usr_admin_01', username: 'admin01', password: 'Password123!', role: 'ADMIN' });
