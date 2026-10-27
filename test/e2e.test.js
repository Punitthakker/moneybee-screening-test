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

  test('teardown', async () => {
    server.close();
    await db.close();
  });
}
