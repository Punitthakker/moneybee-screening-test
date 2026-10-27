'use strict';
// Batch screening from a CSV. One row per name. Rows that share a customer_ref are one customer:
// the first row is the customer, the following rows are its related parties.

const { parse: parseCsv } = require('csv-parse/sync');
const db = require('./db');
const { audit } = require('./audit');
const { screenCustomer, resolveClient, ValidationError } = require('./screening');

const MAX_ROWS = 2000;
const COLS = ['customer_ref', 'name', 'type', 'role', 'dob', 'gender', 'nationality', 'country', 'id_type', 'id_number', 'id_country', 'monitor'];

const TEMPLATE =
  COLS.join(',') + '\n' +
  'C-1001,Example Trading LLC,company,Customer,,,,AE,,,,yes\n' +
  'C-1001,Jane Example,person,Director,1980-05-17,female,GB,AE,Passport,X1234567,GB,\n' +
  'C-1002,John Sample,person,Customer,1975-01-02,male,IN,AE,Emirates ID,784-0000-0000000-0,AE,no\n';

function parseBatch(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = parseCsv(text, { delimiter, bom: true, columns: (h) => h.map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, '_')), skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
  if (!rows.length) throw new ValidationError('The file has no rows.');
  if (rows.length > MAX_ROWS) throw new ValidationError(`The file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  if (!('name' in rows[0])) throw new ValidationError('The file needs a "name" column. Download the template for the expected columns.');
  const groups = [];
  const byRef = new Map();
  rows.forEach((r, i) => {
    const subject = {
      name: r.name, type: /^(company|entity|organi[sz]ation|corporate)/i.test(r.type || '') ? 'company' : 'person',
      role: r.role, dob: r.dob, gender: r.gender, nationality: r.nationality, country: r.country,
      idType: r.id_type, idNumber: r.id_number, idCountry: r.id_country,
    };
    const ref = (r.customer_ref || '').trim();
    const monitor = /^(y|yes|true|1)$/i.test((r.monitor || '').trim());
    if (ref && byRef.has(ref)) {
      const g = byRef.get(ref);
      g.subjects.push(subject);
      g.rows.push(i + 2);
      if (monitor) g.monitor = true;
    } else {
      const g = { ref, subjects: [subject], monitor, rows: [i + 2] };
      groups.push(g);
      if (ref) byRef.set(ref, g);
    }
  });
  return groups;
}

async function startBatch(manager, user, name, text, ip, clientId) {
  const groups = parseBatch(text);
  const cid = await resolveClient(user, clientId);
  const b = (await db.query('insert into batches(name,total,created_by,client_id) values($1,$2,$3,$4) returning id', [String(name || 'Batch').slice(0, 120), groups.length, user.id, cid])).rows[0];
  await audit(user, 'batch.start', 'batch', b.id, { customers: groups.length }, ip);
  (async () => {
    let done = 0, alerts = 0;
    const errors = [];
    for (const g of groups) {
      try {
        const r = await screenCustomer(manager, { ref: g.ref, subjects: g.subjects, monitor: g.monitor, user, trigger: 'batch', batchId: b.id, clientId: cid });
        const s = (await db.query('select alert from screenings where id=$1', [r.screeningId])).rows[0];
        if (s && s.alert) alerts++;
      } catch (e) {
        errors.push({ rows: g.rows.join(','), ref: g.ref, name: g.subjects[0].name, error: e.message });
      }
      done++;
      if (done % 5 === 0 || done === groups.length) {
        await db.query('update batches set done=$2, alerts=$3, errors=$4 where id=$1', [b.id, done, alerts, JSON.stringify(errors)]);
      }
      await new Promise((r) => setImmediate(r));
    }
    await db.query("update batches set done=$2, alerts=$3, errors=$4, status='finished' where id=$1", [b.id, done, alerts, JSON.stringify(errors)]);
    await audit(user, 'batch.finish', 'batch', b.id, { done, alerts, errors: errors.length });
  })().catch(async (e) => {
    console.error('[batch] failed', e);
    await db.query("update batches set status='failed' where id=$1", [b.id]).catch(() => {});
  });
  return { id: b.id, total: groups.length };
}

const q = (v) => {
  const s = String(v == null ? '' : v);
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // stop spreadsheet formula injection
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

async function resultsCsv(id) {
  const rows = (await db.query(
    `select s.id, c.ref, c.name, s.alert, s.risk_flag, s.incomplete, s.hit_count, s.review_status, s.outcome, s.created_at
     from screenings s join customers c on c.id=s.customer_id where s.batch_id=$1 order by s.id`, [id])).rows;
  const head = ['screening_id', 'customer_ref', 'customer_name', 'alert', 'possible_matches', 'country_risk_flag', 'incomplete', 'review_status', 'outcome', 'screened_at'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.id, r.ref, r.name, r.alert ? 'yes' : 'no', r.hit_count, r.risk_flag ? 'yes' : 'no', r.incomplete ? 'yes' : 'no', r.review_status, r.outcome || '', r.created_at.toISOString()].map(q).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { startBatch, resultsCsv, TEMPLATE, parseBatch, csvCell: q };
