'use strict';
// Invitation links. An admin creates an invite; the person opens the link, sets their own
// password and is signed in. Tokens are random, stored only as a hash, single-use and expiring.

const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const DEFAULT_DAYS = 7;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function createInvite({ email, name, role, clientId, days, createdBy }) {
  const token = crypto.randomBytes(32).toString('hex');
  const d = Math.min(30, Math.max(1, Math.round(Number(days) || DEFAULT_DAYS)));
  const r = await db.query(
    `insert into invites(email,name,role,client_id,token_hash,expires_at,created_by)
     values($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval, $7) returning id, expires_at`,
    [email, name, role, clientId || null, sha(token), String(d), createdBy || null]
  );
  return { id: r.rows[0].id, token, expiresAt: r.rows[0].expires_at };
}

async function findValid(token) {
  if (!/^[a-f0-9]{64}$/i.test(String(token || ''))) return null;
  const r = await db.query(
    `select i.*, c.name as client_name from invites i left join clients c on c.id=i.client_id
     where i.token_hash=$1 and i.consumed_at is null and i.expires_at > now()`,
    [sha(token)]
  );
  return r.rows[0] || null;
}

async function acceptInvite(token, password) {
  const inv = await findValid(token);
  if (!inv) {
    const e = new Error('This invite link is invalid or has expired. Ask the person who sent it for a new one.');
    e.status = 410;
    throw e;
  }
  const problem = auth.passwordProblem(password);
  if (problem) {
    const e = new Error(problem);
    e.status = 400;
    throw e;
  }
  if ((await db.query('select 1 from users where email=$1', [inv.email])).rows[0]) {
    const e = new Error('An account with this email already exists. Ask an administrator to reset your password instead.');
    e.status = 409;
    throw e;
  }
  const hash = await auth.hashPassword(password);
  const user = (await db.query(
    'insert into users(email,name,role,password_hash,must_change,client_id,active) values($1,$2,$3,$4,false,$5,true) returning id,email,name,role,client_id',
    [inv.email, inv.name, inv.role, hash, inv.client_id]
  )).rows[0];
  await db.query('update invites set consumed_at=now(), user_id=$2 where id=$1', [inv.id, user.id]);
  return { inv, user };
}

module.exports = { createInvite, findValid, acceptInvite };
