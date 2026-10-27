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
const { SANCTION_LISTS } = require('./lists');

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
    auth.loginOk(key);
    await auth.createSession(res, u.id);
    await db.query('update users set last_login=now() where id=$1', [u.id]);
    await audit({ id: u.id, email: u.email }, 'login', 'user', u.id, null, reqIp(req));
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role, mustChange: u.must_change } });
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
    });
  });

  // ---------- screening ----------
  r.post('/screenings', writer, async (req, res) => {
    const b = req.body || {};
    const out = await screening.screenCustomer(manager, { ref: b.ref, subjects: b.subjects, monitor: b.monitor, criteria: b.criteria, user: req.user });
    res.json({ ...out, screening: await screening.getScreening(out.screeningId) });
  });

  r.get('/screenings/:id', any, async (req, res) => {
    const s = await screening.getScreening(Number(req.params.id));
    if (!s) throw httpError(404, 'Screening not found.');
    res.json(s);
  });

  r.get('/screenings/:id/pdf', any, async (req, res) => {
    const s = await screening.getScreening(Number(req.params.id));
    if (!s) throw httpError(404, 'Screening not found.');
    const pdf = await report.render(s, { name: req.user.name });
    await audit(req.user, 'report.download', 'screening', s.id, null, reqIp(req));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="screening-${s.customerRef}-${s.id}.pdf"` });
    res.send(pdf);
  });

  r.post('/screenings/:id/review', writer, async (req, res) => {
    const out = await screening.reviewHit(req.user, Number(req.params.id), req.body || {}, reqIp(req));
    res.json({ ...out, screening: await screening.getScreening(Number(req.params.id)) });
  });

  // ---------- customers ----------
  r.get('/customers', any, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const page = Math.max(0, Number(req.query.page) || 0);
    const params = [];
    const where = [];
    if (q) {
      params.push('%' + q.toLowerCase() + '%');
      let cond = `lower(c.name) like $${params.length} or lower(c.ref) like $${params.length}`;
      const flat = q.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (flat.length >= 5) {
        params.push('%' + flat + '%');
        cond += ` or regexp_replace(lower(c.subjects::text), '[^a-z0-9]', '', 'g') like $${params.length}`;
      }
      where.push('(' + cond + ')');
    }
    if (['clear', 'open_alert', 'confirmed_match'].includes(status)) {
      params.push(status);
      where.push(`c.risk_status=$${params.length}`);
    }
    if (req.query.monitor === 'yes') where.push('c.monitor=true');
    const w = where.length ? 'where ' + where.join(' and ') : '';
    const total = (await db.query(`select count(*)::int n from customers c ${w}`, params)).rows[0].n;
    const rows = (await db.query(
      `select c.id,c.ref,c.type,c.name,c.monitor,c.risk_status,c.last_screened_at,c.created_at,
        (select count(*)::int from screenings s where s.customer_id=c.id) as screenings
       from customers c ${w} order by c.last_screened_at desc nulls last, c.id desc limit 50 offset ${page * 50}`, params)).rows;
    res.json({ total, page, rows });
  });

  r.get('/customers/:id', any, async (req, res) => {
    const c = (await db.query('select * from customers where id=$1', [Number(req.params.id)])).rows[0];
    if (!c) throw httpError(404, 'Customer not found.');
    const history = (await db.query(
      `select s.id,s.trigger,s.created_at,s.alert,s.risk_flag,s.incomplete,s.hit_count,s.review_status,s.outcome,u.name as by_name
       from screenings s left join users u on u.id=s.created_by where s.customer_id=$1 order by s.created_at desc, s.id desc limit 100`, [c.id])).rows;
    res.json({ customer: c, history });
  });

  r.post('/customers/:id/rescreen', writer, async (req, res) => {
    const out = await screening.rescreenCustomer(manager, Number(req.params.id), { user: req.user, trigger: 'rescreen' });
    res.json({ screeningId: out.id, screening: await screening.getScreening(out.id) });
  });

  r.patch('/customers/:id', writer, async (req, res) => {
    const monitorOn = !!(req.body && req.body.monitor);
    const c = (await db.query('update customers set monitor=$2, updated_at=now() where id=$1 returning id,ref,monitor', [Number(req.params.id), monitorOn])).rows[0];
    if (!c) throw httpError(404, 'Customer not found.');
    await audit(req.user, monitorOn ? 'monitoring.enable' : 'monitoring.disable', 'customer', c.id, { ref: c.ref }, reqIp(req));
    res.json(c);
  });

  // ---------- alerts ----------
  r.get('/alerts', any, async (req, res) => {
    const st = String(req.query.status || 'open');
    const where = st === 'closed' ? "s.review_status='closed'" : st === 'all' ? "s.review_status in ('open','closed')" : "s.review_status='open'";
    const rows = (await db.query(
      `select s.id,s.customer_id,s.trigger,s.created_at,s.hit_count,s.review_status,s.outcome,s.incomplete,c.ref,c.name
       from screenings s join customers c on c.id=s.customer_id where ${where} order by s.created_at desc, s.id desc limit 200`)).rows;
    res.json({ rows });
  });

  // ---------- dashboard and exports ----------
  r.get('/dashboard', any, async (req, res) => {
    const one = async (sql) => (await db.query(sql)).rows[0];
    const c = await one(`select count(*)::int total, count(*) filter (where monitor)::int monitored,
      count(*) filter (where risk_status='confirmed_match')::int confirmed from customers`);
    const a = await one("select count(*)::int open from screenings where review_status='open'");
    const w = await one(`select count(*)::int week, count(*) filter (where incomplete)::int incomplete
      from screenings where created_at > now() - interval '7 days'`);
    const days = (await db.query(`select to_char(d::date,'YYYY-MM-DD') as day,
        (select count(*)::int from screenings s where s.created_at::date = d::date) as n,
        (select count(*)::int from screenings s where s.created_at::date = d::date and s.alert) as alerts
      from generate_series(now() - interval '6 days', now(), interval '1 day') d order by d`)).rows;
    const recent = (await db.query(`select s.id,s.created_at,s.alert,s.hit_count,s.review_status,s.outcome,s.incomplete,s.trigger,c.ref,c.name
      from screenings s join customers c on c.id=s.customer_id order by s.id desc limit 8`)).rows;
    res.json({ customers: c, openAlerts: a.open, week: w, days, recent, lists: manager.listStatus().filter((l) => l.kind === 'sanctions') });
  });

  r.get('/customers.csv', any, async (req, res) => {
    const rows = (await db.query(`select c.ref,c.name,c.type,c.monitor,c.risk_status,c.last_screened_at,c.created_at,
      (select count(*)::int from screenings s where s.customer_id=c.id) as screenings from customers c order by c.id`)).rows;
    const lines = [['reference', 'name', 'type', 'monitored', 'status', 'last_screened', 'created', 'screenings'].join(',')];
    for (const x of rows) lines.push([x.ref, x.name, x.type, x.monitor ? 'yes' : 'no', x.risk_status, x.last_screened_at ? x.last_screened_at.toISOString() : '', x.created_at.toISOString(), x.screenings].map(batch.csvCell).join(','));
    await audit(req.user, 'export.customers', 'customer', null, { rows: rows.length }, reqIp(req));
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="customers.csv"' });
    res.send(lines.join('\n') + '\n');
  });

  r.get('/alerts.csv', any, async (req, res) => {
    const rows = (await db.query(`select s.id,c.ref,c.name,s.created_at,s.trigger,s.hit_count,s.review_status,s.outcome,s.incomplete
      from screenings s join customers c on c.id=s.customer_id where s.alert order by s.id desc`)).rows;
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
    res.json(await batch.startBatch(manager, req.user, b.name, b.csv, reqIp(req)));
  });
  r.get('/batches', any, async (req, res) => {
    res.json({ rows: (await db.query('select b.id,b.name,b.total,b.done,b.alerts,b.status,jsonb_array_length(b.errors) as errors,b.created_at,u.name as by_name from batches b left join users u on u.id=b.created_by order by b.id desc limit 50')).rows });
  });
  r.get('/batches/:id', any, async (req, res) => {
    const b = (await db.query('select * from batches where id=$1', [Number(req.params.id)])).rows[0];
    if (!b) throw httpError(404, 'Batch not found.');
    res.json(b);
  });
  r.get('/batches/:id/csv', any, async (req, res) => {
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
    uploadKey(req);
    const rows = await upload.readRows(req.body.filename, fileBuffer(req.body));
    const headerRow = upload.detectHeaderRow(rows);
    const headers = rows[headerRow];
    res.json({ headerRow, headers, mapping: upload.autoMapping(headers), sample: rows.slice(headerRow + 1, headerRow + 6), rows: rows.length - headerRow - 1 });
  });

  r.post('/lists/:key/import', admin, async (req, res) => {
    const def = uploadKey(req);
    const b = req.body || {};
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
    res.json({ rows: (await db.query('select id,email,name,role,active,must_change,created_at,last_login from users order by id')).rows });
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
    try {
      const u = (await db.query('insert into users(email,name,role,password_hash,must_change) values($1,$2,$3,$4,true) returning id,email,name,role', [email, name, b.role, await auth.hashPassword(b.password)])).rows[0];
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
    if (!active || b.password) await db.query('delete from sessions where user_id=$1', [id]);
    await audit(req.user, 'user.update', 'user', id, { role, active, passwordReset: !!b.password }, reqIp(req));
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

  return r;
};
