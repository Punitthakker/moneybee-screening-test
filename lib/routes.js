'use strict';

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const { audit, reqIp } = require('./audit');
const screening = require('./screening');
const report = require('./report');
const batch = require('./batch');
const monitor = require('./monitor');
const providers = require('./providers');
const { allCountries, toIso2 } = require('./countries');
const upload = require('./lists/upload');
const eocn = require('./lists/eocn');
const { SANCTION_LISTS } = require('./lists');
const crypto = require('crypto');
const QRCode = require('qrcode');
const totp = require('./totp');
const idcrypto = require('./crypto');
const risk = require('./risk');
const notify = require('./notify');
const backup = require('./backup');
const invites = require('./invites');

const { ValidationError } = screening;
const any = auth.requireAuth();
const writer = auth.requireAuth(['admin', 'analyst']);
const admin = auth.requireAuth(['admin']);

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function fileBuffer(body) {
  if (!body || typeof body.data !== 'string' || !body.filename) throw new ValidationError('Choose a file to upload.');
  const buf = Buffer.from(body.data, 'base64');
  if (!buf.length) throw new ValidationError('The file is empty.');
  return buf;
}

// Client separation: a client user only ever sees their own client's records. Platform staff
// (no client on their account) see everything, and may narrow to one client with ?client=.
function clientOf(req) {
  if (req.user.clientId) return req.user.clientId;
  const q = Number(req.query && req.query.client);
  return Number.isInteger(q) && q > 0 ? q : null;
}
function scopeSql(req, params, alias) {
  const id = clientOf(req);
  if (!id) return '';
  params.push(id);
  return ` and ${alias}.client_id=$${params.length}`;
}
async function ownCustomer(req, id) {
  const params = [Number(id)];
  const c = (await db.query(`select * from customers c where c.id=$1${scopeSql(req, params, 'c')}`, params)).rows[0];
  if (!c) throw httpError(404, 'Customer not found.');
  return c;
}
async function ownScreening(req, id) {
  const s = await screening.getScreening(Number(id));
  if (!s || (req.user.clientId && s.clientId !== req.user.clientId)) throw httpError(404, 'Screening not found.');
  return s;
}

module.exports = function buildRouter(manager) {
  const r = express.Router();

  // ---------- session ----------
  r.post('/login', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const key = email + '|' + reqIp(req);
    if (auth.loginBlocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    const u = (await db.query('select * from users where email=$1', [email])).rows[0];
    const ok = u && u.active && (await auth.verifyPassword(password, u.password_hash));
    if (!ok) {
      auth.loginFailed(key);
      await audit(null, 'login.failed', 'user', email, null, reqIp(req));
      return res.status(401).json({ error: 'Email or password is not correct.' });
    }
    if (u.totp_enabled) return res.json({ needs2fa: true, challenge: auth.makeChallenge(u.id) });
    auth.loginOk(key);
    await finishLogin(req, res, u);
  });

  async function finishLogin(req, res, u) {
    await auth.createSession(res, u.id);
    await db.query('update users set last_login=now() where id=$1', [u.id]);
    await audit({ id: u.id, email: u.email }, 'login', 'user', u.id, { twoFactor: !!u.totp_enabled }, reqIp(req));
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role, mustChange: u.must_change, clientId: u.client_id || null, twoFactor: !!u.totp_enabled } });
  }

  r.post('/login/2fa', async (req, res) => {
    const uid = auth.readChallenge(req.body && req.body.challenge);
    if (!uid) return res.status(401).json({ error: 'That sign-in attempt has expired. Start again.' });
    const key = 'otp|' + uid + '|' + reqIp(req);
    if (auth.loginBlocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    const u = (await db.query('select * from users where id=$1 and active', [uid])).rows[0];
    if (!u || !u.totp_enabled) return res.status(401).json({ error: 'Start again.' });
    const code = String((req.body && req.body.code) || '').trim();
    let ok = totp.verify(idcrypto.decrypt(u.totp_secret), code);
    if (!ok && code) {
      const flat = code.replace(/[\s-]/g, '').toLowerCase();
      const hashes = u.recovery_codes || [];
      const h = auth.sha(flat);
      if (hashes.includes(h)) {
        ok = true;
        await db.query('update users set recovery_codes=$2 where id=$1', [u.id, JSON.stringify(hashes.filter((x) => x !== h))]);
        await audit({ id: u.id, email: u.email }, 'twofactor.recovery_used', 'user', u.id, null, reqIp(req));
      }
    }
    if (!ok) {
      auth.loginFailed(key);
      await audit(null, 'login.failed', 'user', u.email, { step: '2fa' }, reqIp(req));
      return res.status(401).json({ error: 'That code is not correct.' });
    }
    auth.loginOk(key);
    await finishLogin(req, res, u);
  });

  // ---------- invitations (public: open link, set password, sign in) ----------
  r.get('/invite/:token', async (req, res) => {
    const inv = await invites.findValid(req.params.token);
    if (!inv) throw httpError(410, 'This invite link is invalid or has expired.');
    res.json({ email: inv.email, name: inv.name, role: inv.role, clientName: inv.client_name || null });
  });

  r.post('/invite/:token/accept', async (req, res) => {
    const { user } = await invites.acceptInvite(req.params.token, String((req.body || {}).password || ''));
    await auth.createSession(res, user.id);
    await audit({ id: user.id, email: user.email }, 'invite.accept', 'user', user.id, { role: user.role }, reqIp(req));
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, clientId: user.client_id || null, twoFactor: false } });
  });

  // ---------- two-factor sign-in ----------
  r.post('/2fa/setup', any, async (req, res) => {
    const secret = totp.newSecret();
    await db.query('update users set totp_secret=$2, totp_enabled=false where id=$1', [req.user.id, idcrypto.encrypt(secret)]);
    const uri = totp.uri(secret, req.user.email);
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  });

  r.post('/2fa/enable', any, async (req, res) => {
    const u = (await db.query('select totp_secret from users where id=$1', [req.user.id])).rows[0];
    if (!u || !u.totp_secret) throw new ValidationError('Start the setup first.');
    if (!totp.verify(idcrypto.decrypt(u.totp_secret), req.body && req.body.code)) throw new ValidationError('That code is not correct. Check the time on your phone and try again.');
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    await db.query('update users set totp_enabled=true, recovery_codes=$2 where id=$1', [req.user.id, JSON.stringify(codes.map(auth.sha))]);
    await audit(req.user, 'twofactor.enable', 'user', req.user.id, null, reqIp(req));
    res.json({ recoveryCodes: codes });
  });

  r.post('/2fa/disable', any, async (req, res) => {
    if ((await db.getSetting('require2fa', false)) === true) throw new ValidationError('Your organisation requires two-factor sign-in, so it cannot be turned off.');
    const u = (await db.query('select * from users where id=$1', [req.user.id])).rows[0];
    if (!(await auth.verifyPassword(String((req.body && req.body.password) || ''), u.password_hash))) throw new ValidationError('Password is not correct.');
    if (u.totp_enabled && !totp.verify(idcrypto.decrypt(u.totp_secret), req.body && req.body.code)) throw new ValidationError('That code is not correct.');
    await db.query("update users set totp_enabled=false, totp_secret=null, recovery_codes='[]'::jsonb where id=$1", [req.user.id]);
    await audit(req.user, 'twofactor.disable', 'user', req.user.id, null, reqIp(req));
    res.json({ ok: true });
  });

  r.post('/logout', async (req, res) => {
    const u = await auth.userFromRequest(req);
    await auth.destroySession(req, res);
    if (u) await audit(u, 'logout', 'user', u.id, null, reqIp(req));
    res.json({ ok: true });
  });

  r.get('/me', any, (req, res) => res.json({ user: req.user }));

  r.post('/password', any, async (req, res) => {
    const { current, next } = req.body || {};
    const u = (await db.query('select * from users where id=$1', [req.user.id])).rows[0];
    if (!(await auth.verifyPassword(String(current || ''), u.password_hash))) throw new ValidationError('Current password is not correct.');
    const problem = auth.passwordProblem(next);
    if (problem) throw new ValidationError(problem);
    if (next === current) throw new ValidationError('Choose a different password from the current one.');
    await db.query('update users set password_hash=$2, must_change=false where id=$1', [u.id, await auth.hashPassword(next)]);
    await db.query('delete from sessions where user_id=$1', [u.id]);
    await auth.createSession(res, u.id);
    await audit(req.user, 'password.change', 'user', u.id, null, reqIp(req));
    res.json({ ok: true });
  });

  // ---------- reference data for the screens ----------
  r.get('/meta', any, async (req, res) => {
    res.json({
      user: req.user,
      lists: manager.listStatus(),
      criteria: await screening.getDefaultCriteria(),
      countries: allCountries(),
      sanctionLists: SANCTION_LISTS.map((l) => ({ key: l.key, name: l.name })),
      countryLists: manager.countryLists().map((c) => ({ key: c.key, name: c.name })),
      providers: providers.statusList(),
      clients: req.user.clientId ? [] : (await db.query('select id,name,active from clients order by id')).rows,
      security: { fourEyes: (await db.getSetting('fourEyes', false)) === true, require2fa: (await db.getSetting('require2fa', false)) === true, emailReady: notify.emailReady() },
    });
  });

  // ---------- screening ----------
  r.post('/screenings', writer, async (req, res) => {
    const b = req.body || {};
    const out = await screening.screenCustomer(manager, { ref: b.ref, subjects: b.subjects, monitor: b.monitor, criteria: b.criteria, user: req.user, clientId: b.clientId });
    res.json({ ...out, screening: await screening.getScreening(out.screeningId) });
  });

  r.get('/screenings/:id', any, async (req, res) => {
    res.json(await ownScreening(req, req.params.id));
  });

  r.get('/screenings/:id/pdf', any, async (req, res) => {
    const s = await ownScreening(req, req.params.id);
    const pdf = await report.render(s, { name: req.user.name });
    await audit(req.user, 'report.download', 'screening', s.id, null, reqIp(req));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="screening-${s.customerRef}-${s.id}.pdf"` });
    res.send(pdf);
  });

  r.post('/screenings/:id/review', writer, async (req, res) => {
    await ownScreening(req, req.params.id);
    const out = await screening.reviewHit(req.user, Number(req.params.id), req.body || {}, reqIp(req));
    res.json({ ...out, screening: await screening.getScreening(Number(req.params.id)) });
  });

  r.post('/screenings/:id/approve', writer, async (req, res) => {
    await ownScreening(req, req.params.id);
    const out = await screening.approveHit(req.user, Number(req.params.id), req.body || {}, reqIp(req));
    res.json({ ...out, screening: await screening.getScreening(Number(req.params.id)) });
  });

  // ---------- customers ----------
  r.get('/customers', any, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const page = Math.max(0, Number(req.query.page) || 0);
    const params = [];
    const where = ['true'];
    where.push(scopeSql(req, params, 'c').replace(/^ and /, '') || 'true');
    if (q) {
      params.push('%' + q.toLowerCase() + '%');
      let cond = `lower(c.name) like $${params.length} or lower(c.ref) like $${params.length}`;
      const blind = idcrypto.blind(q);
      if (blind) {
        params.push(blind);
        cond += ` or c.id_idx @> array[$${params.length}]::text[]`;
      }
      where.push('(' + cond + ')');
    }
    if (['high', 'medium', 'low'].includes(String(req.query.rating))) {
      params.push(String(req.query.rating));
      where.push(`c.risk_rating=$${params.length}`);
    }
    if (req.query.due === 'yes') where.push('c.next_review_at <= now()');
    if (['clear', 'open_alert', 'confirmed_match'].includes(status)) {
      params.push(status);
      where.push(`c.risk_status=$${params.length}`);
    }
    if (req.query.monitor === 'yes') where.push('c.monitor=true');
    const w = where.length ? 'where ' + where.join(' and ') : '';
    const total = (await db.query(`select count(*)::int n from customers c ${w}`, params)).rows[0].n;
    const rows = (await db.query(
      `select c.id,c.ref,c.type,c.name,c.monitor,c.risk_status,c.risk_rating,c.risk_score,c.next_review_at,c.client_id,c.last_screened_at,c.created_at,
        (select count(*)::int from screenings s where s.customer_id=c.id) as screenings
       from customers c ${w} order by c.last_screened_at desc nulls last, c.id desc limit 50 offset ${page * 50}`, params)).rows;
    res.json({ total, page, rows });
  });

  r.get('/customers/:id', any, async (req, res) => {
    const c = await ownCustomer(req, req.params.id);
    const history = (await db.query(
      `select s.id,s.trigger,s.created_at,s.alert,s.risk_flag,s.incomplete,s.hit_count,s.review_status,s.outcome,u.name as by_name
       from screenings s left join users u on u.id=s.created_by where s.customer_id=$1 order by s.created_at desc, s.id desc limit 100`, [c.id])).rows;
    res.json({ customer: c, history });
  });

  r.post('/customers/:id/rescreen', writer, async (req, res) => {
    await ownCustomer(req, req.params.id);
    const out = await screening.rescreenCustomer(manager, Number(req.params.id), { user: req.user, trigger: 'rescreen' });
    res.json({ screeningId: out.id, screening: await screening.getScreening(out.id) });
  });

  r.patch('/customers/:id', writer, async (req, res) => {
    const monitorOn = !!(req.body && req.body.monitor);
    await ownCustomer(req, req.params.id);
    const c = (await db.query('update customers set monitor=$2, updated_at=now() where id=$1 returning id,ref,monitor', [Number(req.params.id), monitorOn])).rows[0];
    await audit(req.user, monitorOn ? 'monitoring.enable' : 'monitoring.disable', 'customer', c.id, { ref: c.ref }, reqIp(req));
    res.json(c);
  });

  // ---------- alerts ----------
  r.get('/alerts', any, async (req, res) => {
    const st = String(req.query.status || 'open');
    const where = st === 'closed' ? "s.review_status='closed'" : st === 'all' ? "s.review_status in ('open','closed')" : "s.review_status='open'";
    const params = [];
    const rows = (await db.query(
      `select s.id,s.customer_id,s.trigger,s.created_at,s.hit_count,s.review_status,s.outcome,s.incomplete,c.ref,c.name
       from screenings s join customers c on c.id=s.customer_id where ${where}${scopeSql(req, params, 'c')} order by s.created_at desc, s.id desc limit 200`, params)).rows;
    res.json({ rows });
  });

  // ---------- dashboard and exports ----------
  r.get('/dashboard', any, async (req, res) => {
    const P = [];
    const sc = scopeSql(req, P, 'c');
    const one = async (sql) => (await db.query(sql, P)).rows[0];
    const c = await one(`select count(*)::int total, count(*) filter (where monitor)::int monitored,
      count(*) filter (where risk_status='confirmed_match')::int confirmed,
      count(*) filter (where risk_rating='high')::int high, count(*) filter (where risk_rating='medium')::int medium, count(*) filter (where risk_rating='low')::int low,
      count(*) filter (where next_review_at <= now())::int review_due from customers c where true${sc}`);
    const a = await one(`select count(*)::int open, count(*) filter (where s.outcome='pending_approval')::int pending from screenings s join customers c on c.id=s.customer_id where s.review_status='open'${sc}`);
    const w = await one(`select count(*)::int week, count(*) filter (where s.incomplete)::int incomplete
      from screenings s join customers c on c.id=s.customer_id where s.created_at > now() - interval '7 days'${sc}`);
    const days = (await db.query(`select to_char(d::date,'YYYY-MM-DD') as day,
        (select count(*)::int from screenings s join customers c on c.id=s.customer_id where s.created_at::date = d::date${sc}) as n,
        (select count(*)::int from screenings s join customers c on c.id=s.customer_id where s.created_at::date = d::date and s.alert${sc}) as alerts
      from generate_series(now() - interval '6 days', now(), interval '1 day') d order by d`, P)).rows;
    const recent = (await db.query(`select s.id,s.created_at,s.alert,s.hit_count,s.review_status,s.outcome,s.incomplete,s.trigger,c.ref,c.name
      from screenings s join customers c on c.id=s.customer_id where true${sc} order by s.id desc limit 8`, P)).rows;
    res.json({ customers: c, openAlerts: a.open, pendingApproval: a.pending, week: w, days, recent, lists: manager.listStatus().filter((l) => l.kind === 'sanctions') });
  });

  r.get('/customers.csv', any, async (req, res) => {
    const ex1 = [];
    const rows = (await db.query(`select c.ref,c.name,c.type,c.monitor,c.risk_status,c.last_screened_at,c.created_at,
      c.risk_rating,c.next_review_at,
      (select count(*)::int from screenings s where s.customer_id=c.id) as screenings from customers c where true${scopeSql(req, ex1, 'c')} order by c.id`, ex1)).rows;
    const lines = [['reference', 'name', 'type', 'monitored', 'status', 'last_screened', 'created', 'screenings', 'risk_rating', 'next_review'].join(',')];
    for (const x of rows) lines.push([x.ref, x.name, x.type, x.monitor ? 'yes' : 'no', x.risk_status, x.last_screened_at ? x.last_screened_at.toISOString() : '', x.created_at.toISOString(), x.screenings, x.risk_rating || '', x.next_review_at ? x.next_review_at.toISOString().slice(0, 10) : ''].map(batch.csvCell).join(','));
    await audit(req.user, 'export.customers', 'customer', null, { rows: rows.length }, reqIp(req));
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="customers.csv"' });
    res.send(lines.join('\n') + '\n');
  });

  r.get('/alerts.csv', any, async (req, res) => {
    const ex2 = [];
    const rows = (await db.query(`select s.id,c.ref,c.name,s.created_at,s.trigger,s.hit_count,s.review_status,s.outcome,s.incomplete
      from screenings s join customers c on c.id=s.customer_id where s.alert${scopeSql(req, ex2, 'c')} order by s.id desc`, ex2)).rows;
    const lines = [['screening_id', 'reference', 'customer', 'screened_at', 'source', 'possible_matches', 'review', 'outcome', 'incomplete'].join(',')];
    for (const x of rows) lines.push([x.id, x.ref, x.name, x.created_at.toISOString(), x.trigger, x.hit_count, x.review_status, x.outcome || '', x.incomplete ? 'yes' : 'no'].map(batch.csvCell).join(','));
    await audit(req.user, 'export.alerts', 'screening', null, { rows: rows.length }, reqIp(req));
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="alerts.csv"' });
    res.send(lines.join('\n') + '\n');
  });

  // ---------- batches ----------
  r.get('/batch-template', any, (req, res) => {
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="batch-template.csv"' });
    res.send(batch.TEMPLATE);
  });
  r.post('/batches', writer, async (req, res) => {
    const b = req.body || {};
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw new ValidationError('Choose a CSV file.');
    res.json(await batch.startBatch(manager, req.user, b.name, b.csv, reqIp(req), b.clientId));
  });
  r.get('/batches', any, async (req, res) => {
    const params = [];
    res.json({ rows: (await db.query(`select b.id,b.name,b.total,b.done,b.alerts,b.status,jsonb_array_length(b.errors) as errors,b.created_at,u.name as by_name from batches b left join users u on u.id=b.created_by where true${scopeSql(req, params, 'b')} order by b.id desc limit 50`, params)).rows });
  });
  r.get('/batches/:id', any, async (req, res) => {
    const bp = [Number(req.params.id)];
    const b = (await db.query(`select * from batches b where b.id=$1${scopeSql(req, bp, 'b')}`, bp)).rows[0];
    if (!b) throw httpError(404, 'Batch not found.');
    res.json(b);
  });
  r.get('/batches/:id/csv', any, async (req, res) => {
    const bp = [Number(req.params.id)];
    if (!(await db.query(`select 1 from batches b where b.id=$1${scopeSql(req, bp, 'b')}`, bp)).rows[0]) throw httpError(404, 'Batch not found.');
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="batch-${Number(req.params.id)}-results.csv"` });
    res.send(await batch.resultsCsv(Number(req.params.id)));
  });

  // ---------- lists (admin) ----------
  r.get('/lists', any, (req, res) => res.json({ lists: manager.listStatus(), countryLists: manager.countryLists() }));

  r.post('/lists/refresh', admin, async (req, res) => {
    await audit(req.user, 'lists.refresh', 'lists', null, null, reqIp(req));
    manager.refreshAll().catch((e) => console.error('[lists] manual refresh failed:', e.message));
    res.json({ started: true });
  });

  r.post('/monitoring/run', admin, async (req, res) => {
    const out = await monitor.runMonitoring(manager, 'manual run', req.user);
    res.json(out);
  });

  function uploadKey(req) {
    const def = SANCTION_LISTS.find((l) => l.key === req.params.key && l.mode === 'upload');
    if (!def) throw httpError(404, 'That list does not accept uploads.');
    return def;
  }

  r.post('/lists/:key/preview', admin, async (req, res) => {
    const def = uploadKey(req);
    if (def.key === 'uae') {
      const sheets = await upload.readWorkbook(req.body.filename, fileBuffer(req.body));
      if (sheets && eocn.looksLikeEocn(sheets)) {
        const { entries, counts } = eocn.parseWorkbook(sheets, def.key);
        return res.json({ eocn: true, counts, total: entries.length, sample: entries.slice(0, 5).map((e) => ({ name: e.name, type: e.type, ref: e.ref })) });
      }
    }
    const rows = await upload.readRows(req.body.filename, fileBuffer(req.body));
    const headerRow = upload.detectHeaderRow(rows);
    const headers = rows[headerRow];
    res.json({ headerRow, headers, mapping: upload.autoMapping(headers), sample: rows.slice(headerRow + 1, headerRow + 6), rows: rows.length - headerRow - 1 });
  });

  r.post('/lists/:key/import', admin, async (req, res) => {
    const def = uploadKey(req);
    const b = req.body || {};
    if (def.key === 'uae') {
      const sheets = await upload.readWorkbook(b.filename, fileBuffer(b));
      if (sheets && eocn.looksLikeEocn(sheets)) {
        const { entries, counts } = eocn.parseWorkbook(sheets, def.key);
        if (!entries.length) throw new ValidationError('The workbook has no active listings.');
        const out = await manager.importEntries(def.key, entries, { mode: 'replace', sourceLabel: 'EOCN workbook: ' + String(b.filename).slice(0, 100) });
        await audit(req.user, 'lists.import', 'list', def.key, { file: b.filename, format: 'EOCN workbook', ...counts, added: out.addedIds, removed: out.removedIds, total: out.total }, reqIp(req));
        if (out.addedIds || out.removedIds) await notify.notify('listChange', 'MoneyBee: UAE Local Terrorist List updated', `${out.addedIds} listing${out.addedIds === 1 ? '' : 's'} added and ${out.removedIds} removed. The list now has ${out.total} records. Monitored customers are being re-screened.`);
        return res.json({ ...out, counts, skipped: counts.skippedDelisted });
      }
    }
    const rows = await upload.readRows(b.filename, fileBuffer(b));
    const { entries, skipped } = upload.buildEntries(rows, Number(b.headerRow) || 0, b.mapping || {}, def.key);
    if (!entries.length) throw new ValidationError('No usable rows were found with that column mapping.');
    const out = await manager.importEntries(def.key, entries, { mode: b.mode === 'append' ? 'append' : 'replace', sourceLabel: 'Upload: ' + String(b.filename).slice(0, 100) });
    await audit(req.user, 'lists.import', 'list', def.key, { file: b.filename, mode: b.mode, entries: entries.length, skipped, total: out.total }, reqIp(req));
    res.json({ ...out, skipped });
  });

  r.delete('/lists/:key/entries', admin, async (req, res) => {
    const def = uploadKey(req);
    await manager.clearUploaded(def.key);
    await audit(req.user, 'lists.clear', 'list', def.key, null, reqIp(req));
    res.json({ ok: true });
  });

  // ---------- country lists (admin) ----------
  r.put('/country-lists/:key', admin, async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.countries)) throw new ValidationError('Countries must be a list.');
    const seen = new Map();
    for (const c of b.countries) {
      const iso2 = toIso2(String((c && (c.iso2 || c.name)) || ''));
      if (!iso2) throw new ValidationError('Country not recognised: ' + ((c && (c.iso2 || c.name)) || ''));
      seen.set(iso2, String((c && c.note) || '').slice(0, 300));
    }
    if (b.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(b.asOf)) throw new ValidationError('As-of date must be YYYY-MM-DD.');
    await manager.updateCountryList(req.params.key, { countries: [...seen].map(([iso2, note]) => ({ iso2, note })), as_of: b.asOf || null, source: String(b.source || '').slice(0, 500) });
    await audit(req.user, 'countrylist.update', 'list', req.params.key, { count: seen.size, asOf: b.asOf }, reqIp(req));
    res.json({ countryLists: manager.countryLists() });
  });

  r.post('/country-lists/:key/verify', admin, async (req, res) => {
    await manager.verifyCountryList(req.params.key, req.user);
    await audit(req.user, 'countrylist.verify', 'list', req.params.key, null, reqIp(req));
    res.json({ countryLists: manager.countryLists() });
  });

  // ---------- users (admin) ----------
  r.get('/users', admin, async (req, res) => {
    res.json({ rows: (await db.query('select u.id,u.email,u.name,u.role,u.active,u.must_change,u.created_at,u.last_login,u.client_id,u.totp_enabled as two_factor,c.name as client_name from users u left join clients c on c.id=u.client_id order by u.id')).rows });
  });

  r.post('/users', admin, async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    if (!auth.ROLES.includes(b.role)) throw new ValidationError('Choose a role.');
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Enter a name.');
    const problem = auth.passwordProblem(b.password);
    if (problem) throw new ValidationError(problem);
    let clientId = null;
    if (b.clientId) {
      clientId = Number(b.clientId);
      if (!(await db.query('select 1 from clients where id=$1', [clientId])).rows[0]) throw new ValidationError('That client does not exist.');
    }
    try {
      const u = (await db.query('insert into users(email,name,role,password_hash,must_change,client_id) values($1,$2,$3,$4,true,$5) returning id,email,name,role', [email, name, b.role, await auth.hashPassword(b.password), clientId])).rows[0];
      await audit(req.user, 'user.create', 'user', u.id, { email, role: b.role }, reqIp(req));
      res.json(u);
    } catch (e) {
      if (e.code === '23505') throw new ValidationError('A user with that email already exists.');
      throw e;
    }
  });

  r.patch('/users/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const u = (await db.query('select * from users where id=$1', [id])).rows[0];
    if (!u) throw httpError(404, 'User not found.');
    const role = b.role !== undefined ? b.role : u.role;
    const active = b.active !== undefined ? !!b.active : u.active;
    if (!auth.ROLES.includes(role)) throw new ValidationError('Choose a role.');
    if (id === req.user.id && (role !== 'admin' || !active)) throw new ValidationError('You cannot remove your own administrator access.');
    if (b.password) {
      const problem = auth.passwordProblem(b.password);
      if (problem) throw new ValidationError(problem);
      await db.query('update users set password_hash=$2, must_change=true where id=$1', [id, await auth.hashPassword(b.password)]);
    }
    await db.query('update users set role=$2, active=$3 where id=$1', [id, role, active]);
    if (b.resetTwoFactor) {
      await db.query("update users set totp_enabled=false, totp_secret=null, recovery_codes='[]'::jsonb where id=$1", [id]);
      await db.query('delete from sessions where user_id=$1', [id]);
      await audit(req.user, 'twofactor.reset', 'user', id, null, reqIp(req));
    }
    if (!active || b.password) await db.query('delete from sessions where user_id=$1', [id]);
    await audit(req.user, 'user.update', 'user', id, { role, active, passwordReset: !!b.password }, reqIp(req));
    res.json({ ok: true });
  });

  // ---------- invitations (admin) ----------
  r.post('/invites', admin, async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Enter a name.');
    if (!auth.ROLES.includes(b.role)) throw new ValidationError('Choose a role.');
    if ((await db.query('select 1 from users where email=$1', [email])).rows[0]) throw new ValidationError('A user with that email already exists.');
    let clientId = req.user.clientId || null;
    if (!req.user.clientId && b.clientId) {
      clientId = Number(b.clientId);
      if (!(await db.query('select 1 from clients where id=$1', [clientId])).rows[0]) throw new ValidationError('That client does not exist.');
    }
    const { token, expiresAt } = await invites.createInvite({ email, name, role: b.role, clientId, days: b.days, createdBy: req.user.id });
    await audit(req.user, 'invite.create', 'invite', email, { role: b.role, clientId }, reqIp(req));
    res.json({ token, expiresAt, email, name, role: b.role });
  });

  r.get('/invites', admin, async (req, res) => {
    const params = [];
    const scope = req.user.clientId ? (params.push(req.user.clientId), ` and i.client_id=$${params.length}`) : '';
    const rows = (await db.query(`select i.id,i.email,i.name,i.role,i.expires_at,i.created_at,c.name as client_name,u.name as invited_by
      from invites i left join clients c on c.id=i.client_id left join users u on u.id=i.created_by
      where i.consumed_at is null and i.expires_at > now()${scope} order by i.id desc`, params)).rows;
    res.json({ rows });
  });

  r.delete('/invites/:id', admin, async (req, res) => {
    const params = [Number(req.params.id)];
    const scope = req.user.clientId ? (params.push(req.user.clientId), ` and client_id=$${params.length}`) : '';
    await db.query(`delete from invites where id=$1${scope}`, params);
    await audit(req.user, 'invite.revoke', 'invite', req.params.id, null, reqIp(req));
    res.json({ ok: true });
  });

  // ---------- audit and settings (admin) ----------
  r.get('/audit', admin, async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.action) {
      params.push(String(req.query.action) + '%');
      where.push(`action like $${params.length}`);
    }
    if (req.query.user) {
      params.push('%' + String(req.query.user).toLowerCase() + '%');
      where.push(`lower(user_email) like $${params.length}`);
    }
    const w = where.length ? 'where ' + where.join(' and ') : '';
    const page = Math.max(0, Number(req.query.page) || 0);
    const rows = (await db.query(`select id,at,user_email,action,entity,entity_id,detail,ip from audit_log ${w} order by id desc limit 100 offset ${page * 100}`, params)).rows;
    res.json({ rows, page });
  });

  r.get('/settings/criteria', admin, async (req, res) => res.json(await screening.getDefaultCriteria()));
  r.put('/settings/criteria', admin, async (req, res) => {
    const crit = screening.cleanCriteria(req.body, screening.DEFAULT_CRITERIA);
    await db.setSetting('criteria', crit);
    await audit(req.user, 'settings.criteria', 'settings', 'criteria', crit, reqIp(req));
    res.json(crit);
  });

  // ---------- clients (platform administrators) ----------
  const platform = (req, res, next) => (req.user.clientId ? res.status(403).json({ error: 'Only platform administrators can manage clients.' }) : next());
  r.get('/clients', any, async (req, res) => {
    const rows = (await db.query(`select c.id,c.name,c.active,c.created_at,(select count(*)::int from customers x where x.client_id=c.id) as customers,
      (select count(*)::int from users u where u.client_id=c.id) as users from clients c order by c.id`)).rows;
    res.json({ rows: req.user.clientId ? rows.filter((c) => c.id === req.user.clientId) : rows });
  });
  r.post('/clients', admin, platform, async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    if (name.length < 2) throw new ValidationError('Enter the client name.');
    try {
      const c = (await db.query('insert into clients(name) values($1) returning id,name,active', [name])).rows[0];
      await audit(req.user, 'client.create', 'client', c.id, { name }, reqIp(req));
      res.json(c);
    } catch (e) {
      if (e.code === '23505') throw new ValidationError('A client with that name already exists.');
      throw e;
    }
  });
  r.patch('/clients/:id', admin, platform, async (req, res) => {
    const b = req.body || {};
    const c = (await db.query('select * from clients where id=$1', [Number(req.params.id)])).rows[0];
    if (!c) throw httpError(404, 'Client not found.');
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) : c.name;
    const active = b.active !== undefined ? !!b.active : c.active;
    await db.query('update clients set name=$2, active=$3 where id=$1', [c.id, name, active]);
    if (!active) await db.query('delete from sessions where user_id in (select id from users where client_id=$1)', [c.id]);
    await audit(req.user, 'client.update', 'client', c.id, { name, active }, reqIp(req));
    res.json({ ok: true });
  });

  // ---------- security, risk, retention, notifications (admin) ----------
  async function securitySettings() {
    return {
      fourEyes: (await db.getSetting('fourEyes', false)) === true,
      require2fa: (await db.getSetting('require2fa', false)) === true,
      retentionYears: Number(await db.getSetting('retentionYears', 0)) || 0,
      risk: await risk.getRiskConfig(),
      notifications: await notify.getConfig(),
      emailReady: notify.emailReady(),
      encryption: { algorithm: 'AES-256-GCM', dedicatedKey: !!process.env.ID_ENC_KEY },
    };
  }
  r.get('/settings/security', admin, async (req, res) => res.json(await securitySettings()));
  r.put('/settings/security', admin, async (req, res) => {
    const b = req.body || {};
    if (b.fourEyes !== undefined) await db.setSetting('fourEyes', !!b.fourEyes);
    if (b.require2fa === true && !req.user.twoFactor) throw new ValidationError('Turn on two-factor sign in for your own account first (My security), otherwise you would lock yourself out.');
    if (b.require2fa !== undefined) await db.setSetting('require2fa', !!b.require2fa);
    if (b.retentionYears !== undefined) {
      const y = Number(b.retentionYears);
      if (!Number.isInteger(y) || y < 0 || y > 30 || (y > 0 && y < 5)) throw new ValidationError('Retention must be 0 (keep everything) or between 5 and 30 years. UAE rules require at least 5 years.');
      await db.setSetting('retentionYears', y);
    }
    if (b.risk && b.risk.reviewMonths) await db.setSetting('risk', { reviewMonths: b.risk.reviewMonths });
    if (b.notifications) {
      const n = b.notifications;
      const url = String(n.webhookUrl || '').trim();
      if (url) await notify.checkWebhook(url).catch((e) => { throw new ValidationError(e.message); });
      const email = String(n.emailTo || '').trim();
      if (email && !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(email)) throw new ValidationError('Enter one valid email address for alerts.');
      await db.setSetting('notifications', { enabled: !!n.enabled, webhookUrl: url, emailTo: email, events: n.events || {} });
    }
    const out = await securitySettings();
    await audit(req.user, 'settings.security', 'settings', 'security', { fourEyes: out.fourEyes, require2fa: out.require2fa, retentionYears: out.retentionYears, notifications: { enabled: out.notifications.enabled, webhook: !!out.notifications.webhookUrl, email: !!out.notifications.emailTo }, reviewMonths: out.risk.reviewMonths }, reqIp(req));
    res.json(out);
  });
  r.post('/settings/notifications/test', admin, async (req, res) => {
    const cfg = await notify.getConfig();
    if (!cfg.webhookUrl && !cfg.emailTo) throw new ValidationError('Add a webhook address or an email address and save first.');
    const out = {};
    if (cfg.webhookUrl) out.webhook = await notify.sendWebhook(cfg.webhookUrl, 'MoneyBee Screening: this is a test alert. No action needed.').then(() => 'sent', (e) => 'failed: ' + e.message);
    if (cfg.emailTo) out.email = await notify.sendEmail(cfg.emailTo, 'MoneyBee Screening test alert', 'This is a test alert. No action needed.').then(() => 'sent', (e) => 'failed: ' + e.message);
    await audit(req.user, 'notifications.test', 'settings', 'notifications', out, reqIp(req));
    res.json(out);
  });
  r.get('/backup', admin, async (req, res) => {
    if (req.user.clientId) throw httpError(403, 'Only platform administrators can export a full backup.');
    const data = await backup.buildBackup();
    await audit(req.user, 'backup.export', 'system', null, data.meta.counts, reqIp(req));
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="moneybee-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    res.send(JSON.stringify(data, null, 2));
  });

  r.get('/retention/preview', admin, async (req, res) => {
    const y = Number(await db.getSetting('retentionYears', 0)) || 0;
    const n = y ? (await db.query("select count(*)::int n from customers where coalesce(last_screened_at,created_at) < now() - ($1 || ' years')::interval and risk_status<>'confirmed_match'", [String(y)])).rows[0].n : 0;
    res.json({ years: y, eligible: n });
  });

  // ---------- customer risk rating and reviews ----------
  r.patch('/customers/:id/risk', writer, async (req, res) => {
    const c = await ownCustomer(req, req.params.id);
    const b = req.body || {};
    if (b.override !== null && !['high', 'medium', 'low'].includes(b.override)) throw new ValidationError('Choose high, medium, low, or clear the override.');
    const why = String(b.reason || '').trim();
    if (b.override && why.length < 5) throw new ValidationError('Give a reason for overriding the rating (at least 5 characters).');
    await db.query('update customers set risk_override=$2, risk_override_reason=$3 where id=$1', [c.id, b.override || null, b.override ? why.slice(0, 500) : null]);
    const last = (await db.query('select results from screenings where customer_id=$1 order by created_at desc, id desc limit 1', [c.id])).rows[0];
    if (last) await risk.applyRisk(c.id, last.results, c.risk_status === 'confirmed_match');
    await audit(req.user, 'risk.override', 'customer', c.id, { ref: c.ref, override: b.override || null, reason: why }, reqIp(req));
    res.json({ customer: await ownCustomer(req, c.id) });
  });
  r.post('/customers/:id/review-complete', writer, async (req, res) => {
    const c = await ownCustomer(req, req.params.id);
    await db.query('update customers set last_reviewed_at=now() where id=$1', [c.id]);
    const last = (await db.query('select results from screenings where customer_id=$1 order by created_at desc, id desc limit 1', [c.id])).rows[0];
    if (last) await risk.applyRisk(c.id, last.results, c.risk_status === 'confirmed_match');
    await audit(req.user, 'review.complete', 'customer', c.id, { ref: c.ref, note: String((req.body && req.body.note) || '').slice(0, 300) }, reqIp(req));
    res.json({ customer: await ownCustomer(req, c.id) });
  });

  return r;
};
