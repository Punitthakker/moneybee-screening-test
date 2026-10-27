'use strict';

const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');

const SESSION_HOURS = 8;
const COOKIE = 'mbsid';
const ROLES = ['admin', 'analyst', 'viewer'];

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const key = await scrypt(password, salt);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and at least one number.';
  return null;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sign = (id) => crypto.createHmac('sha256', cfg.sessionSecret).update(id).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  await db.query('insert into sessions(id,user_id,expires_at) values($1,$2,now() + ($3 || \' hours\')::interval)', [sha(id), userId, String(SESSION_HOURS)]);
  setCookie(res, `${id}.${sign(id)}`, SESSION_HOURS * 3600);
}

function setCookie(res, value, maxAge) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (cfg.production) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${value}; ${flags.join('; ')}`);
}

async function destroySession(req, res) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (raw) {
    const id = raw.split('.')[0];
    await db.query('delete from sessions where id=$1', [sha(id)]);
  }
  setCookie(res, '', 0);
}

async function userFromRequest(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [id, sig] = raw.split('.');
  if (!id || !sig) return null;
  const expected = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  const r = await db.query(
    `select u.id,u.email,u.name,u.role,u.active,u.must_change,u.client_id,u.totp_enabled,s.expires_at from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at > now()`,
    [sha(id)]
  );
  const u = r.rows[0];
  if (!u || !u.active) return null;
  const need2fa = !u.totp_enabled && (await db.getSetting('require2fa', false)) === true;
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChange: u.must_change, clientId: u.client_id || null, twoFactor: !!u.totp_enabled, mustEnroll2fa: need2fa };
}

// Express middleware factory. roles = allowed roles, empty = any signed-in user.
function requireAuth(roles) {
  return async (req, res, next) => {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (user.mustChange && !(req.path === '/password' || req.path === '/me' || req.path === '/logout')) {
      return res.status(403).json({ error: 'You must change your password before continuing.', mustChange: true });
    }
    if (user.mustEnroll2fa && !['/me', '/logout', '/password', '/2fa/setup', '/2fa/enable'].includes(req.path)) {
      return res.status(403).json({ error: 'Your organisation requires two-factor sign-in. Set it up to continue.', mustEnroll2fa: true });
    }
    if (roles && roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'You do not have permission to do this.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-requested-with') !== 'fetch') {
      return res.status(403).json({ error: 'Missing request header.' });
    }
    req.user = user;
    next();
  };
}

// Simple in-memory brake on repeated failed sign-ins.
const fails = new Map();
function loginBlocked(key) {
  const f = fails.get(key);
  return !!f && f.count >= 5 && Date.now() - f.last < 15 * 60 * 1000;
}
function loginFailed(key) {
  const f = fails.get(key) || { count: 0, last: 0 };
  if (Date.now() - f.last > 15 * 60 * 1000) f.count = 0;
  f.count++;
  f.last = Date.now();
  fails.set(key, f);
}
function loginOk(key) {
  fails.delete(key);
}

async function seedAdmin() {
  const n = await db.query('select count(*)::int as n from users');
  if (n.rows[0].n > 0) return false;
  if (!cfg.adminEmail || !cfg.adminPassword) {
    console.warn('No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set. Nobody can sign in.');
    return false;
  }
  await db.query('insert into users(email,name,role,password_hash,must_change) values($1,$2,$3,$4,true)', [
    cfg.adminEmail,
    'Administrator',
    'admin',
    await hashPassword(cfg.adminPassword),
  ]);
  console.log('Created first administrator account for', cfg.adminEmail);
  return true;
}

// Short-lived proof that the password step passed, exchanged for a session once the code is right.
function makeChallenge(userId) {
  const body = `${userId}.${Date.now() + 5 * 60 * 1000}`;
  return `${body}.${crypto.createHmac('sha256', cfg.sessionSecret).update('2fa:' + body).digest('hex')}`;
}
function readChallenge(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const body = parts[0] + '.' + parts[1];
  const exp = Buffer.from(crypto.createHmac('sha256', cfg.sessionSecret).update('2fa:' + body).digest('hex'));
  const got = Buffer.from(parts[2]);
  if (exp.length !== got.length || !crypto.timingSafeEqual(exp, got)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Number(parts[0]);
}

module.exports = {
  sha,
  makeChallenge,
  readChallenge,
  ROLES,
  hashPassword,
  verifyPassword,
  passwordProblem,
  createSession,
  destroySession,
  userFromRequest,
  requireAuth,
  loginBlocked,
  loginFailed,
  loginOk,
  seedAdmin,
};
