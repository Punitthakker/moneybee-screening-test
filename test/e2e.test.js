'use strict';
// End to end against a real Postgres. Needs TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('e2e skipped (set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.DISABLE_FEEDS = 'true';
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_PASSWORD = 'Initial-pass-1';
  const db = require('../lib/db');
  const cfg = require('../lib/config');
  const { createApp } = require('../server');
  const { ListManager } = require('../lib/lists');
  const auth = require('../lib/auth');
  const monitor = require('../lib/monitor');

  const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
  let server, base, manager;

  function client() {
    let cookie = '';
    return async (method, p, body, raw) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* not json */ }
      return { status: res.status, json, text };
    };
  }

  test('setup', async () => {
    db.init(url, false);
    await db.query('drop schema public cascade; create schema public;');
    await db.migrate();
    await auth.seedAdmin();
    manager = new ListManager();
    await manager.init();
    await manager.ingest('un', fx('un-sample.xml'));
    await manager.ingest('ofac', fx('ofac-sample.xml'));
    await manager.ingest('eu', fx('eu-sample.xml'));
    await manager.ingest('uk', fx('uk-sample.xml'));
    const app = await createApp(manager);
    server = app.listen(0);
    base = 'http://127.0.0.1:' + server.address().port;
  });

  const admin = client();
  const analyst = client();
  const viewer = client();

  test('auth: login, forced password change, roles, CSRF header', async () => {
    assert.strictEqual((await admin('GET', '/api/me')).status, 401);
    assert.strictEqual((await admin('POST', '/api/login', { email: 'admin@example.com', password: 'wrong' })).status, 401);
    const l = await admin('POST', '/api/login', { email: 'admin@example.com', password: 'Initial-pass-1' });
    assert.strictEqual(l.status, 200);
    assert.strictEqual(l.json.user.mustChange, true);
    assert.strictEqual((await admin('GET', '/api/meta')).status, 403);
    assert.strictEqual((await admin('POST', '/api/password', { current: 'Initial-pass-1', next: 'short' })).status, 400);
    assert.strictEqual((await admin('POST', '/api/password', { current: 'Initial-pass-1', next: 'Better-pass-22' })).status, 200);
    assert.strictEqual((await admin('GET', '/api/meta')).status, 200);
    for (const [email, role] of [['analyst@example.com', 'analyst'], ['viewer@example.com', 'viewer']]) {
      const r = await admin('POST', '/api/users', { email, name: role, role, password: 'Temp-pass-123' });
      assert.strictEqual(r.status, 200, r.text);
    }
    for (const [c, email] of [[analyst, 'analyst@example.com'], [viewer, 'viewer@example.com']]) {
      await c('POST', '/api/login', { email, password: 'Temp-pass-123' });
      await c('POST', '/api/password', { current: 'Temp-pass-123', next: 'Another-pass-9' });
    }
    assert.strictEqual((await viewer('POST', '/api/screenings', { subjects: [{ name: 'Test Person' }] })).status, 403);
    assert.strictEqual((await analyst('GET', '/api/users')).status, 403);
    const noHeader = await fetch(base + '/api/screenings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(noHeader.status, 401);
  });

  let first;
  test('screening: hit, AND logic discards wrong DOB, review decisions, false positive suppression', async () => {
    const withDob = { subjects: [{ name: 'Alexei Testov Demoson', dob: '1975-03-12', type: 'person' }] };
    const r = await analyst('POST', '/api/screenings', withDob);
    assert.strictEqual(r.status, 200, r.text);
    first = r.json;
    const s = r.json.screening;
    assert.strictEqual(s.alert, true);
    assert.strictEqual(s.results.subjects[0].hits[0].flags.dob, 'match');
    assert.strictEqual(s.reviewStatus, 'open');
    assert.ok(s.results.lists.find((l) => l.key === 'pep').status === 'not_connected');
    assert.strictEqual(s.incomplete, true, 'UAE list not uploaded so screening must be incomplete');

    const wrong = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Alexei Testov Demoson', dob: '1990-01-01' }] });
    assert.strictEqual(wrong.json.screening.alert, false);
    assert.strictEqual(wrong.json.screening.results.subjects[0].discarded.dob, 1);

    const hit = s.results.subjects[0].hits[0];
    const key = `${hit.listKey}:${hit.entryId}`;
    const bad = await analyst('POST', `/api/screenings/${s.id}/review`, { subjectKey: s.results.subjects[0].key, hitKey: key, decision: 'false_positive', reason: 'x' });
    assert.strictEqual(bad.status, 400);
    const ok = await analyst('POST', `/api/screenings/${s.id}/review`, { subjectKey: s.results.subjects[0].key, hitKey: key, decision: 'false_positive', reason: 'Different date of birth confirmed from passport copy' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.json.screening.reviewStatus, 'closed');
    assert.strictEqual(ok.json.screening.outcome, 'cleared');

    const again = await analyst('POST', '/api/customers/' + first.customerId + '/rescreen');
    assert.strictEqual(again.json.screening.alert, false);
    assert.strictEqual(again.json.screening.results.subjects[0].suppressed.length, 1);
  });

  test('multi-list and related parties: OFAC id match, company, related party', async () => {
    const r = await analyst('POST', '/api/screenings', {
      ref: 'C-9',
      monitor: true,
      subjects: [
        { name: 'Northwind Sample Shipping Company', type: 'company', country: 'AE' },
        { name: 'Someone Different', type: 'person', role: 'Director', idNumber: 'OF123456' },
        { name: 'Vladislav Samplenko', type: 'person', role: 'Shareholder', dob: '1969-11-02' },
      ],
    });
    assert.strictEqual(r.status, 200, r.text);
    const subs = r.json.screening.results.subjects;
    assert.strictEqual(subs[0].hits[0].listKey, 'ofac');
    assert.strictEqual(subs[1].hits[0].idMatch.number, 'OF123456');
    assert.strictEqual(subs[2].hits[0].listKey, 'eu');
    assert.strictEqual(r.json.customerRef, 'C-9');
  });

  test('country risk flag for FATF listed country', async () => {
    const r = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Harmless Person', nationality: 'Iran' }] });
    assert.strictEqual(r.json.screening.riskFlag, true);
    assert.ok(r.json.screening.results.subjects[0].countryFlags.some((f) => f.listKey === 'fatf_black'));
  });

  test('validation errors are clear', async () => {
    const a = await analyst('POST', '/api/screenings', { subjects: [{ name: 'A' }] });
    assert.strictEqual(a.status, 400);
    const b = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Valid Name', dob: 'not a date' }] });
    assert.match(b.json.error, /Date of birth/);
    const c = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Valid Name', nationality: 'Atlantis' }] });
    assert.match(c.json.error, /Nationality/);
  });

  test('UAE list upload: preview, import, then screening is complete and matches', async () => {
    const csv = 'Serial,Name,Aliases,Nationality,Date of Birth,Passport\n1,Hamad Testbin Example,Hamad T Example,United Arab Emirates,1980-04-04,UAE777\n2,Fictional Charity Foundation,,,,\n';
    const data = Buffer.from(csv).toString('base64');
    assert.strictEqual((await analyst('POST', '/api/lists/uae/preview', { filename: 'uae.csv', data })).status, 403);
    const p = await admin('POST', '/api/lists/uae/preview', { filename: 'uae.csv', data });
    assert.strictEqual(p.status, 200, p.text);
    assert.deepStrictEqual(p.json.mapping.name, ['Name']);
    const imp = await admin('POST', '/api/lists/uae/import', { filename: 'uae.csv', data, headerRow: p.json.headerRow, mapping: p.json.mapping, mode: 'replace' });
    assert.strictEqual(imp.json.total, 2, imp.text);
    const r = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Hamad Testbin Example', dob: '1980-04-04' }] });
    const s = r.json.screening;
    assert.strictEqual(s.results.subjects[0].hits[0].listKey, 'uae');
    assert.strictEqual(s.incomplete, false);
  });

  test('identity document: Emirates ID validated, formatted, matched on the UAE list and searchable', async () => {
    const csv = 'Serial,Name,Emirates ID\n1,Khalid Sampleman Testbin,784-1985-7654321-2\n';
    const data = Buffer.from(csv).toString('base64');
    const p = await admin('POST', '/api/lists/custom/preview', { filename: 'c.csv', data });
    assert.strictEqual(p.json.mapping.idNumber, 'Emirates ID');
    await admin('POST', '/api/lists/custom/import', { filename: 'c.csv', data, headerRow: p.json.headerRow, mapping: p.json.mapping, mode: 'replace' });
    const bad = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Some Person', idType: 'Emirates ID', idNumber: '123-45' }] });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /Emirates ID/);
    const short = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Some Person', idType: 'Passport', idNumber: 'AB1' }] });
    assert.match(short.json.error, /too short/);
    const r = await analyst('POST', '/api/screenings', { ref: 'EID-1', subjects: [{ name: 'Totally Different Name', idType: 'Emirates ID', idNumber: '784198576543212' }] });
    assert.strictEqual(r.status, 200, r.text);
    const sub = r.json.screening.results.subjects[0];
    assert.strictEqual(sub.idNumber, '784-1985-7654321-2');
    assert.strictEqual(sub.idCountry, 'AE');
    assert.strictEqual(sub.hits[0].listKey, 'custom');
    assert.strictEqual(sub.hits[0].idMatch.number, '784-1985-7654321-2');
    const found = await analyst('GET', '/api/customers?q=784198576543212');
    assert.strictEqual(found.json.rows[0].ref, 'EID-1');
    await admin('DELETE', '/api/lists/custom/entries');
  });

  test('PDF report renders', async () => {
    const r = await analyst('GET', `/api/screenings/${first.screeningId}/pdf`, null, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buf.slice(0, 5).toString(), '%PDF-');
    assert.ok(r.buf.length > 3000);
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'out', 'sample.pdf'), r.buf);
  });

  test('batch: groups rows, runs, returns results csv', async () => {
    const csv = 'customer_ref,name,type,role,dob,nationality,monitor\nB1,Alexei Testov Demoson,person,Customer,1975-03-12,,yes\nB1,Maria Fictionova,person,Director,,,\nB2,Totally Clean Person,person,Customer,,,\nB3,,person,,,,\n';
    const b = await analyst('POST', '/api/batches', { name: 'test', csv });
    assert.strictEqual(b.status, 200, b.text);
    assert.strictEqual(b.json.total, 3);
    let st;
    for (let i = 0; i < 50; i++) {
      st = (await analyst('GET', '/api/batches/' + b.json.id)).json;
      if (st.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(st.status, 'finished');
    assert.strictEqual(st.done, 3);
    assert.strictEqual(st.errors.length, 1);
    const out = await analyst('GET', `/api/batches/${b.json.id}/csv`);
    assert.match(out.text, /B1/);
  });

  test('monitoring: list change creates a new alert for a monitored customer, unchanged does not', async () => {
    const before = (await db.query('select count(*)::int n from screenings')).rows[0].n;
    const none = await monitor.runMonitoring(manager, 'test');
    assert.ok(none.checked >= 2);
    assert.strictEqual((await db.query('select count(*)::int n from screenings')).rows[0].n, before, 'no change means no new screenings');
    const c = await analyst('POST', '/api/screenings', { ref: 'M1', monitor: true, subjects: [{ name: 'Newly Listed Person', dob: '1990-02-02' }] });
    assert.strictEqual(c.json.screening.alert, false);
    const extra = fx('un-sample.xml').replace('</INDIVIDUALS>', `<INDIVIDUAL><DATAID>900050</DATAID><FIRST_NAME>Newly</FIRST_NAME><SECOND_NAME>Listed</SECOND_NAME><THIRD_NAME>Person</THIRD_NAME><UN_LIST_TYPE>Sample</UN_LIST_TYPE><REFERENCE_NUMBER>SAMPLE.050</REFERENCE_NUMBER><LISTED_ON>2026-10-20</LISTED_ON><INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1990-02-02</DATE></INDIVIDUAL_DATE_OF_BIRTH></INDIVIDUAL></INDIVIDUALS>`);
    await manager.ingest('un', extra);
    const run = await monitor.runMonitoring(manager, 'test list change');
    assert.ok(run.newAlerts >= 1, JSON.stringify(run));
    const alerts = await analyst('GET', '/api/alerts?status=open');
    assert.ok(alerts.json.rows.some((a) => a.ref === 'M1'));
    const cust = (await analyst('GET', '/api/customers?q=M1')).json.rows[0];
    assert.strictEqual(cust.risk_status, 'open_alert');
  });

  test('dashboard and CSV exports', async () => {
    const d = await analyst('GET', '/api/dashboard');
    assert.strictEqual(d.status, 200, d.text);
    assert.ok(d.json.customers.total >= 5);
    assert.strictEqual(d.json.days.length, 7);
    assert.ok(d.json.recent.length > 0);
    assert.ok(d.json.lists.find((l) => l.key === 'un'));
    const c = await analyst('GET', '/api/customers.csv');
    assert.match(c.text, /reference,name,type/);
    assert.match(c.text, /C-9/);
    const a = await analyst('GET', '/api/alerts.csv');
    assert.match(a.text, /screening_id,reference/);
  });

  test('audit log records actions and is admin only', async () => {
    assert.strictEqual((await analyst('GET', '/api/audit')).status, 403);
    const a = await admin('GET', '/api/audit?action=screening');
    assert.ok(a.json.rows.length > 3);
    const all = await admin('GET', '/api/audit');
    const actions = new Set(all.json.rows.map((x) => x.action));
    for (const need of ['login', 'password.change', 'user.create', 'screening.review', 'lists.import', 'report.download']) assert.ok(actions.has(need), 'missing audit action ' + need);
  });

  test('country list edit needs verification again', async () => {
    const lists = (await admin('GET', '/api/lists')).json.countryLists;
    const grey = lists.find((l) => l.key === 'fatf_grey');
    const edited = await admin('PUT', '/api/country-lists/fatf_grey', { asOf: '2026-10-24', source: 'test', countries: grey.countries.map((c) => ({ iso2: c.iso2, note: c.note })).concat([{ iso2: 'ZW', note: 'test' }]) });
    assert.strictEqual(edited.status, 200, edited.text);
    assert.strictEqual(edited.json.countryLists.find((l) => l.key === 'fatf_grey').verifiedBy, null);
    const v = await admin('POST', '/api/country-lists/fatf_grey/verify');
    assert.strictEqual(v.json.countryLists.find((l) => l.key === 'fatf_grey').verifiedBy, 'admin@example.com');
  });


  test('official EOCN workbook: recognised, delisted skipped, import reports changes, matches', async () => {
    const data = fs.readFileSync(path.join(__dirname, 'fixtures', 'eocn-official.xlsx')).toString('base64');
    const p = await admin('POST', '/api/lists/uae/preview', { filename: 'eocn.xlsx', data });
    assert.strictEqual(p.json.eocn, true, p.text);
    assert.strictEqual(p.json.counts.individuals > 100, true);
    assert.strictEqual(p.json.counts.skippedDelisted > 0, true);
    const imp = await admin('POST', '/api/lists/uae/import', { filename: 'eocn.xlsx', data, mode: 'replace' });
    assert.strictEqual(imp.status, 200, imp.text);
    assert.strictEqual(imp.json.total, p.json.total);
    const again = await admin('POST', '/api/lists/uae/import', { filename: 'eocn.xlsx', data, mode: 'replace' });
    assert.strictEqual(again.json.addedIds, 0);
    assert.strictEqual(again.json.removedIds, 0);
    const r = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Khalifa Mohd T Al Subaey', dob: '1965-01-01', nationality: 'Qatar' }] });
    const hit = r.json.screening.results.subjects[0].hits.find((h) => h.listKey === 'uae');
    assert.ok(hit, 'listed person is found on the UAE list');
    const delisted = await analyst('POST', '/api/screenings', { subjects: [{ name: 'Mohammad Saeed Bin Helwan Al-Seqatri' }] });
    assert.strictEqual(delisted.json.screening.results.subjects[0].hits.filter((h) => /SEQATRI/i.test(h.name)).length, 0, 'delisted person is not on the list');
  });

  test('ID numbers are encrypted at rest but readable and searchable in the app', async () => {
    const r = await analyst('POST', '/api/screenings', { ref: 'ENC-1', subjects: [{ name: 'Encrypted Sample Person', idType: 'Passport', idNumber: 'P9988776' }] });
    assert.strictEqual(r.status, 200, r.text);
    const raw = (await db.query("select c.subjects::text as a, (select string_agg(s.results::text, '') from screenings s where s.customer_id=c.id) as b from customers c where ref='ENC-1'")).rows[0];
    assert.ok(!raw.a.includes('P9988776') && !raw.b.includes('P9988776'), 'plain ID not stored');
    assert.ok(raw.a.includes('enc:v1:'));
    const detail = await analyst('GET', '/api/customers/' + r.json.customerId);
    assert.strictEqual(detail.json.customer.subjects[0].idNumber, 'P9988776');
    assert.strictEqual((await analyst('GET', '/api/customers?q=p-9988776')).json.rows[0].ref, 'ENC-1');
    const { sealExisting } = require('../lib/maintenance');
    await db.query("update customers set subjects=jsonb_set(subjects,'{0,idNumber}','\"LEGACY123\"') where ref='ENC-1'");
    assert.ok((await sealExisting()) >= 1);
    assert.ok(!(await db.query("select subjects::text t from customers where ref='ENC-1'")).rows[0].t.includes('LEGACY123'));
  });

  test('two-factor sign in: enrol, challenge, wrong code, recovery code, admin reset', async () => {
    const totp = require('../lib/totp');
    const c = client();
    await admin('POST', '/api/users', { email: 'otp@example.com', name: 'Otp User', role: 'analyst', password: 'Temp-pass-123' });
    await c('POST', '/api/login', { email: 'otp@example.com', password: 'Temp-pass-123' });
    await c('POST', '/api/password', { current: 'Temp-pass-123', next: 'Otp-pass-12345' });
    const setup = await c('POST', '/api/2fa/setup');
    assert.match(setup.json.qr, /^data:image\/png/);
    assert.strictEqual((await c('POST', '/api/2fa/enable', { code: '000000' })).status, 400);
    const en = await c('POST', '/api/2fa/enable', { code: totp.code(setup.json.secret, Math.floor(Date.now() / 30000)) });
    assert.strictEqual(en.json.recoveryCodes.length, 8);
    const c2 = client();
    const l = await c2('POST', '/api/login', { email: 'otp@example.com', password: 'Otp-pass-12345' });
    assert.strictEqual(l.json.needs2fa, true);
    assert.strictEqual((await c2('GET', '/api/me')).status, 401, 'no session before the code');
    assert.strictEqual((await c2('POST', '/api/login/2fa', { challenge: l.json.challenge, code: '123456' })).status, 401);
    const ok = await c2('POST', '/api/login/2fa', { challenge: l.json.challenge, code: totp.code(setup.json.secret, Math.floor(Date.now() / 30000)) });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await c2('GET', '/api/me')).status, 200);
    assert.strictEqual((await c2('POST', '/api/login/2fa', { challenge: 'x.1.y', code: '1' })).status, 401);
    const c3 = client();
    const l3 = await c3('POST', '/api/login', { email: 'otp@example.com', password: 'Otp-pass-12345' });
    const rec = await c3('POST', '/api/login/2fa', { challenge: l3.json.challenge, code: en.json.recoveryCodes[0] });
    assert.strictEqual(rec.status, 200);
    const c4 = client();
    const l4 = await c4('POST', '/api/login', { email: 'otp@example.com', password: 'Otp-pass-12345' });
    assert.strictEqual((await c4('POST', '/api/login/2fa', { challenge: l4.json.challenge, code: en.json.recoveryCodes[0] })).status, 401, 'recovery code works once');
    const uid = (await admin('GET', '/api/users')).json.rows.find((u) => u.email === 'otp@example.com').id;
    await admin('PATCH', '/api/users/' + uid, { resetTwoFactor: true });
    assert.strictEqual((await client()('POST', '/api/login', { email: 'otp@example.com', password: 'Otp-pass-12345' })).json.needs2fa, undefined);
  });

  test('require two-factor blocks work until the user enrols', async () => {
    const c = client();
    await admin('POST', '/api/users', { email: 'must@example.com', name: 'Must', role: 'analyst', password: 'Temp-pass-123' });
    await c('POST', '/api/login', { email: 'must@example.com', password: 'Temp-pass-123' });
    await c('POST', '/api/password', { current: 'Temp-pass-123', next: 'Must-pass-12345' });
    assert.strictEqual((await admin('PUT', '/api/settings/security', { require2fa: true })).status, 400, 'admin must enrol first');
    const totp = require('../lib/totp');
    const as = await admin('POST', '/api/2fa/setup');
    await admin('POST', '/api/2fa/enable', { code: totp.code(as.json.secret, Math.floor(Date.now() / 30000)) });
    await admin('GET', '/api/me');
    assert.strictEqual((await admin('PUT', '/api/settings/security', { require2fa: true })).status, 200);
    const blocked = await c('GET', '/api/customers');
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.json.mustEnroll2fa, true);
    assert.strictEqual((await c('POST', '/api/2fa/setup')).status, 200);
    await admin('PUT', '/api/settings/security', { require2fa: false });
    assert.strictEqual((await c('GET', '/api/customers')).status, 200);
    const off = await admin('POST', '/api/2fa/disable', { password: 'Better-pass-22', code: totp.code(as.json.secret, Math.floor(Date.now() / 30000)) });
    assert.strictEqual(off.status, 200, off.text);
  });

  test('four-eyes: true match needs a different person to approve', async () => {
    await admin('PUT', '/api/settings/security', { fourEyes: true });
    const r = await analyst('POST', '/api/screenings', { ref: 'FE-1', subjects: [{ name: 'Alexei Testov Demoson', dob: '1975-03-12' }] });
    const sc = r.json.screening;
    const sub = sc.results.subjects[0];
    const hit = sub.hits[0];
    const key = hit.listKey + ':' + hit.entryId;
    const rev = await analyst('POST', `/api/screenings/${sc.id}/review`, { subjectKey: sub.key, hitKey: key, decision: 'true_match', reason: 'Name and date of birth agree' });
    assert.strictEqual(rev.json.awaitingApproval, true);
    assert.strictEqual(rev.json.screening.reviewStatus, 'open');
    assert.strictEqual(rev.json.screening.outcome, 'pending_approval');
    const self = await analyst('POST', `/api/screenings/${sc.id}/approve`, { subjectKey: sub.key, hitKey: key, approve: true });
    assert.strictEqual(self.status, 400);
    assert.match(self.json.error, /different person/);
    assert.strictEqual((await viewer('POST', `/api/screenings/${sc.id}/approve`, { subjectKey: sub.key, hitKey: key, approve: true })).status, 403);
    const rej = await admin('POST', `/api/screenings/${sc.id}/approve`, { subjectKey: sub.key, hitKey: key, approve: false });
    assert.strictEqual(rej.status, 400, 'a rejection needs a reason');
    await analyst('POST', `/api/screenings/${sc.id}/review`, { subjectKey: sub.key, hitKey: key, decision: 'true_match', reason: 'Confirmed again' });
    const ok = await admin('POST', `/api/screenings/${sc.id}/approve`, { subjectKey: sub.key, hitKey: key, approve: true, note: 'Agreed' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.json.screening.reviewStatus, 'closed');
    assert.strictEqual(ok.json.screening.outcome, 'true_match');
    assert.strictEqual(ok.json.screening.dispositions[0].approval, 'approved');
    const again = await analyst('POST', '/api/screenings', { ref: 'FE-1', subjects: [{ name: 'Alexei Testov Demoson', dob: '1975-03-12' }] });
    assert.ok(again.json.screening.results.subjects[0].hits[0].previouslyConfirmed, 'approved match is carried forward');
    await admin('PUT', '/api/settings/security', { fourEyes: false });
  });

  test('risk rating, explanation, override and periodic review', async () => {
    const r = await analyst('POST', '/api/screenings', { ref: 'RISK-1', subjects: [{ name: 'Risky Trading Company', type: 'company', country: 'Kuwait' }] });
    const c = (await analyst('GET', '/api/customers/' + r.json.customerId)).json.customer;
    assert.strictEqual(c.risk_rating, 'medium');
    assert.ok(c.risk_factors.factors.some((f) => /Kuwait/.test(f.label)));
    assert.ok(new Date(c.next_review_at) > new Date());
    const bad = await analyst('PATCH', `/api/customers/${c.id}/risk`, { override: 'low', reason: 'x' });
    assert.strictEqual(bad.status, 400);
    const ov = await analyst('PATCH', `/api/customers/${c.id}/risk`, { override: 'high', reason: 'Senior management decision' });
    assert.strictEqual(ov.json.customer.risk_rating, 'high');
    await db.query("update customers set next_review_at = now() - interval '1 day' where id=$1", [c.id]);
    assert.strictEqual((await analyst('GET', '/api/customers?due=yes')).json.rows.some((x) => x.id === c.id), true);
    const done = await analyst('POST', `/api/customers/${c.id}/review-complete`, { note: 'ok' });
    assert.ok(new Date(done.json.customer.next_review_at) > new Date());
    assert.strictEqual((await analyst('GET', '/api/customers?due=yes')).json.rows.some((x) => x.id === c.id), false);
    assert.strictEqual((await analyst('GET', '/api/customers?rating=high')).json.rows.some((x) => x.id === c.id), true);
  });

  test('clients are separated: a client user cannot see or touch another client', async () => {
    const a = (await admin('POST', '/api/clients', { name: 'Client Alpha' })).json;
    const b = (await admin('POST', '/api/clients', { name: 'Client Beta' })).json;
    assert.strictEqual((await analyst('POST', '/api/clients', { name: 'x' })).status, 403);
    const ua = client();
    const ub = client();
    for (const [c, email, cl] of [[ua, 'alpha@example.com', a], [ub, 'beta@example.com', b]]) {
      const mk = await admin('POST', '/api/users', { email, name: email, role: 'analyst', password: 'Temp-pass-123', clientId: cl.id });
      assert.strictEqual(mk.status, 200, mk.text);
      await c('POST', '/api/login', { email, password: 'Temp-pass-123' });
      await c('POST', '/api/password', { current: 'Temp-pass-123', next: 'Client-pass-123' });
    }
    const sa = await ua('POST', '/api/screenings', { ref: 'SAME-REF', subjects: [{ name: 'Alpha Customer', idType: 'Passport', idNumber: 'ALPHA1234' }] });
    const sb = await ub('POST', '/api/screenings', { ref: 'SAME-REF', subjects: [{ name: 'Beta Customer' }] });
    assert.strictEqual(sa.status, 200, sa.text);
    assert.strictEqual(sb.status, 200, sb.text);
    assert.notStrictEqual(sa.json.customerId, sb.json.customerId, 'the same reference can exist in two clients');
    assert.strictEqual((await ub('GET', '/api/customers/' + sa.json.customerId)).status, 404);
    assert.strictEqual((await ub('GET', '/api/screenings/' + sa.json.screeningId)).status, 404);
    assert.strictEqual((await ub('GET', `/api/screenings/${sa.json.screeningId}/pdf`)).status, 404);
    assert.strictEqual((await ub('POST', `/api/customers/${sa.json.customerId}/rescreen`)).status, 404);
    assert.strictEqual((await ub('PATCH', `/api/customers/${sa.json.customerId}`, { monitor: true })).status, 404);
    const listB = (await ub('GET', '/api/customers')).json;
    assert.deepStrictEqual(listB.rows.map((r) => r.name), ['Beta Customer']);
    assert.strictEqual((await ub('GET', '/api/customers?q=ALPHA1234')).json.rows.length, 0, 'ID search does not cross clients');
    assert.strictEqual((await ub('GET', '/api/alerts?status=all')).json.rows.every((r) => r.name === 'Beta Customer'), true);
    const dash = (await ub('GET', '/api/dashboard')).json;
    assert.strictEqual(dash.customers.total, 1);
    const csv = (await ub('GET', '/api/customers.csv', null, true)).buf.toString();
    assert.ok(!csv.includes('Alpha Customer'));
    const spoof = await ub('GET', '/api/customers?client=' + a.id);
    assert.deepStrictEqual(spoof.json.rows.map((r) => r.name), ['Beta Customer'], 'a client user cannot widen scope with ?client=');
    const plat = (await admin('GET', '/api/customers?client=' + a.id)).json;
    assert.deepStrictEqual(plat.rows.map((r) => r.name), ['Alpha Customer']);
    const dest = await ub('POST', '/api/screenings', { subjects: [{ name: 'Sneaky' }], clientId: a.id });
    assert.strictEqual((await ub('GET', '/api/customers/' + dest.json.customerId)).status, 200, 'client users are always placed in their own client');
    assert.strictEqual((await ua('GET', '/api/customers/' + dest.json.customerId)).status, 404);
  });

  test('notifications: webhook receives a message without ID numbers; private addresses are refused', async () => {
    const http = require('http');
    const got = [];
    const hook = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => { got.push(b); res.end('ok'); });
    });
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    const notify = require('../lib/notify');
    const bad = await admin('PUT', '/api/settings/security', { notifications: { enabled: true, webhookUrl: 'https://127.0.0.1/hook', events: {} } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /public/);
    process.env.ALLOW_INSECURE_WEBHOOK = 'true';
    const ok = await admin('PUT', '/api/settings/security', { notifications: { enabled: true, webhookUrl: `http://127.0.0.1:${hook.address().port}/h`, events: { alert: true, confirmed: true } } });
    assert.strictEqual(ok.status, 200, ok.text);
    const t = await admin('POST', '/api/settings/notifications/test');
    assert.strictEqual(t.json.webhook, 'sent');
    const out = await notify.notify('alert', 'Subject line', 'Body without secrets');
    assert.strictEqual(out.webhook, 'sent');
    assert.ok(got.some((b) => b.includes('Subject line')));
    assert.ok(!got.join('').includes('P9988776'));
    await admin('PUT', '/api/settings/security', { notifications: { enabled: false, webhookUrl: '', events: {} } });
    assert.strictEqual((await notify.notify('alert', 'Off', 'x')).skipped, true);
    delete process.env.ALLOW_INSECURE_WEBHOOK;
    hook.close();
  });

  test('retention: bad values refused, old customers purged, confirmed matches kept', async () => {
    assert.strictEqual((await admin('PUT', '/api/settings/security', { retentionYears: 2 })).status, 400);
    const old = await analyst('POST', '/api/screenings', { ref: 'OLD-1', subjects: [{ name: 'Long Gone Customer' }] });
    await db.query("update customers set created_at=now() - interval '8 years', last_screened_at=now() - interval '7 years' where id=$1", [old.json.customerId]);
    await db.query("update customers set last_screened_at=now() - interval '9 years', risk_status='confirmed_match' where ref='FE-1'");
    assert.strictEqual((await admin('PUT', '/api/settings/security', { retentionYears: 5 })).status, 200);
    assert.strictEqual((await admin('GET', '/api/retention/preview')).json.eligible, 1);
    const { applyRetention } = require('../lib/maintenance');
    const out = await applyRetention();
    assert.strictEqual(out.deleted, 1);
    assert.strictEqual((await db.query("select count(*)::int n from customers where ref='OLD-1'")).rows[0].n, 0);
    assert.strictEqual((await db.query("select count(*)::int n from customers where ref='FE-1'")).rows[0].n, 1);
    await admin('PUT', '/api/settings/security', { retentionYears: 0 });
  });


  test('full backup: platform-admin only, ID numbers stay encrypted, round-trip restore works', async () => {
    const seed = await admin('POST', '/api/screenings', { ref: 'BKP-1', subjects: [{ name: 'Backup Sample Person', idType: 'Passport', idNumber: 'BK7654321' }] });
    assert.strictEqual(seed.status, 200, seed.text);
    const bkpId = seed.json.customerId;
    assert.strictEqual((await analyst('GET', '/api/backup')).status, 403);
    const raw = await admin('GET', '/api/backup', null, true);
    assert.strictEqual(raw.status, 200);
    const text = raw.buf.toString();
    const data = JSON.parse(text);
    assert.ok(data.tables.customers.length >= 1);
    assert.ok(data.tables.audit_log.length >= 1);
    assert.ok(data.meta.counts.screenings >= 1);
    // the sample ID P9988776 was stored encrypted; it must not appear in the clear anywhere in the backup
    assert.ok(text.includes('enc:v1:'), 'backup keeps the encrypted form');
    assert.ok(!text.includes('BK7654321'), 'no plain ID number in the backup');
    // round-trip: wipe and restore into the same database, then read back through the app (which decrypts)
    const before = (await db.query('select count(*)::int n from customers')).rows[0].n;
    const backup = require('../lib/backup');
    const summary = await backup.restoreBackup(data, { wipe: true });
    assert.strictEqual(summary.customers, data.tables.customers.length);
    assert.strictEqual((await db.query('select count(*)::int n from customers')).rows[0].n, before);
    // restore wipes users, so active sessions cascade away: re-authenticate (same credentials survive)
    const admin2 = client();
    const relog = await admin2('POST', '/api/login', { email: 'admin@example.com', password: 'Better-pass-22' });
    assert.strictEqual(relog.status, 200, relog.text);
    const restored = await admin2('GET', '/api/customers/' + bkpId);
    assert.strictEqual(restored.status, 200, restored.text);
    assert.strictEqual(restored.json.customer.subjects[0].idNumber, 'BK7654321', 'encrypted ID decrypts after restore');
    // a new insert still works (id sequence was reset)
    const fresh = await admin2('POST', '/api/screenings', { ref: 'POST-RESTORE', subjects: [{ name: 'After Restore' }] });
    assert.strictEqual(fresh.status, 200, fresh.text);
  });


  test('invite links: admin creates, guest sets own password and signs in, single-use, revoke, scoping', async () => {
    // a prior test may have reset sessions, so establish fresh logins here
    const adm = client();
    assert.strictEqual((await adm('POST', '/api/login', { email: 'admin@example.com', password: 'Better-pass-22' })).status, 200);
    const anl = client();
    assert.strictEqual((await anl('POST', '/api/login', { email: 'analyst@example.com', password: 'Another-pass-9' })).status, 200);
    assert.strictEqual((await anl('POST', '/api/invites', { email: 'x@e.com', name: 'X', role: 'viewer' })).status, 403);
    assert.strictEqual((await adm('POST', '/api/invites', { email: 'bad', name: 'X', role: 'viewer' })).status, 400);
    const inv = await adm('POST', '/api/invites', { email: 'guest@example.com', name: 'Guest Tester', role: 'analyst', days: 7 });
    assert.strictEqual(inv.status, 200, inv.text);
    assert.match(inv.json.token, /^[a-f0-9]{64}$/);
    // appears in the pending list
    assert.ok((await adm('GET', '/api/invites')).json.rows.some((r) => r.email === 'guest@example.com'));
    // public lookup works without a session
    const guest = client();
    const look = await guest('GET', '/api/invite/' + inv.json.token);
    assert.strictEqual(look.status, 200, look.text);
    assert.strictEqual(look.json.name, 'Guest Tester');
    assert.strictEqual(look.json.role, 'analyst');
    assert.strictEqual((await guest('GET', '/api/me')).status, 401, 'not signed in before accepting');
    // weak password refused
    assert.strictEqual((await guest('POST', '/api/invite/' + inv.json.token + '/accept', { password: 'short' })).status, 400);
    // accept: sets password and signs in
    const acc = await guest('POST', '/api/invite/' + inv.json.token + '/accept', { password: 'Guest-pass-2026' });
    assert.strictEqual(acc.status, 200, acc.text);
    assert.strictEqual(acc.json.user.role, 'analyst');
    assert.strictEqual((await guest('GET', '/api/me')).status, 200, 'signed in after accepting');
    assert.strictEqual((await guest('POST', '/api/screenings', { subjects: [{ name: 'Guest Ran This' }] })).status, 200, 'analyst can work');
    // single-use: the link no longer works, and is gone from pending
    assert.strictEqual((await guest('GET', '/api/invite/' + inv.json.token)).status, 410);
    assert.strictEqual((await client()('POST', '/api/invite/' + inv.json.token + '/accept', { password: 'Another-pass-99' })).status, 410);
    assert.ok(!(await adm('GET', '/api/invites')).json.rows.some((r) => r.email === 'guest@example.com'));
    // the new account can sign in normally afterwards
    assert.strictEqual((await client()('POST', '/api/login', { email: 'guest@example.com', password: 'Guest-pass-2026' })).status, 200);
    // a bad/old token is rejected
    assert.strictEqual((await guest('GET', '/api/invite/' + 'f'.repeat(64))).status, 410);
    // revoke: a fresh invite can be cancelled before use
    const inv2 = await adm('POST', '/api/invites', { email: 'revoked@example.com', name: 'Revoked', role: 'viewer' });
    const id2 = (await adm('GET', '/api/invites')).json.rows.find((r) => r.email === 'revoked@example.com').id;
    assert.strictEqual((await adm('DELETE', '/api/invites/' + id2)).status, 200);
    assert.strictEqual((await client()('POST', '/api/invite/' + inv2.json.token + '/accept', { password: 'Will-fail-123' })).status, 410);
    // cannot invite an email that already has an account
    assert.strictEqual((await adm('POST', '/api/invites', { email: 'guest@example.com', name: 'Dup', role: 'viewer' })).status, 400);
  });

  test('teardown', async () => {
    server.close();
    await db.close();
  });
}
