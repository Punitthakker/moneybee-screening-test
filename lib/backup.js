'use strict';
// Full database backup and restore. The backup is a single JSON file covering every client,
// customer, screening, decision and the audit log. ID numbers (and TOTP secrets) are read in
// their stored, encrypted form and stay encrypted in the file, so a backup is useless to anyone
// without ID_ENC_KEY. Downloadable sanctions feeds (list_cache) are left out because they can be
// fetched again; uploaded lists (list_entries, e.g. the UAE and custom lists) are kept.

const db = require('./db');

// Restore order respects foreign keys; wipe runs in reverse.
const ORDER = ['clients', 'users', 'settings', 'lists', 'country_lists', 'country_risk', 'list_entries', 'customers', 'batches', 'screenings', 'dispositions', 'audit_log'];

// jsonb columns read as ::text so the encrypted-at-rest bytes are preserved (the jsonb type
// parser would otherwise decrypt them on the way out).
const JSONB = {
  customers: ['subjects', 'risk_factors'],
  screenings: ['criteria', 'results'],
  batches: ['errors'],
  audit_log: ['detail'],
  settings: ['value'],
  users: ['recovery_codes'],
};

async function columns(table) {
  return (await db.query('select column_name from information_schema.columns where table_name=$1 order by ordinal_position', [table])).rows.map((r) => r.column_name);
}

async function buildBackup() {
  const out = {
    meta: {
      product: 'MoneyBee Screening',
      format: 1,
      created_at: new Date().toISOString(),
      note: 'ID numbers and two-factor secrets are stored encrypted (AES-256-GCM). This backup keeps them encrypted and cannot be read or restored usefully without the same ID_ENC_KEY.',
    },
    tables: {},
  };
  for (const t of ORDER) {
    const cols = await columns(t);
    const jcols = JSONB[t] || [];
    const select = cols.map((c) => (jcols.includes(c) ? `${c}::text as "${c}"` : `"${c}"`)).join(',');
    const orderBy = cols.includes('id') ? 'id' : cols[0];
    out.tables[t] = (await db.query(`select ${select} from ${t} order by ${orderBy}`)).rows;
  }
  out.meta.counts = Object.fromEntries(ORDER.map((t) => [t, out.tables[t].length]));
  return out;
}

async function restoreBackup(data, { wipe = true } = {}) {
  if (!data || !data.tables) throw new Error('That file is not a MoneyBee backup.');
  const summary = {};
  await db.tx(async (c) => {
    if (wipe) for (const t of [...ORDER].reverse()) await c.query(`delete from ${t}`);
    for (const t of ORDER) {
      const rows = data.tables[t] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const ph = cols.map((_, i) => `$${i + 1}`);
        await c.query(`insert into ${t}(${cols.map((x) => `"${x}"`).join(',')}) values(${ph.join(',')})`, cols.map((k) => row[k]));
      }
      summary[t] = rows.length;
      const hasId = (await c.query("select 1 from information_schema.columns where table_name=$1 and column_name='id'", [t])).rowCount > 0;
      if (hasId) {
        const seq = (await c.query('select pg_get_serial_sequence($1,$2) s', [t, 'id'])).rows[0].s;
        if (seq) await c.query(`select setval($1, greatest((select coalesce(max(id),0) from ${t}),1))`, [seq]);
      }
    }
  });
  return summary;
}

module.exports = { buildBackup, restoreBackup, ORDER };
