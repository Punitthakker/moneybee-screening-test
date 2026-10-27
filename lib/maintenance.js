'use strict';
// Housekeeping: protect ID numbers saved before encryption existed, apply the retention rule,
// and tell the team when customer reviews fall due.

const db = require('./db');
const idcrypto = require('./crypto');
const { audit } = require('./audit');
const { notify } = require('./notify');

async function sealExisting() {
  let n = 0;
  const plain = `'"idNumber": "[^e"]'`;
  const cs = (await db.query(`select id,subjects from customers where subjects::text ~ ${plain}`)).rows;
  for (const c of cs) {
    await db.query('update customers set subjects=$2, id_idx=$3 where id=$1', [c.id, JSON.stringify(idcrypto.seal(c.subjects)), idcrypto.blindIndexes(c.subjects)]);
    n++;
  }
  let last = 0;
  for (;;) {
    const ss = (await db.query(`select id,results from screenings where id>$1 and results::text ~ ${plain} order by id limit 200`, [last])).rows;
    if (!ss.length) break;
    for (const s of ss) {
      await db.query('update screenings set results=$2 where id=$1', [s.id, JSON.stringify(idcrypto.seal(s.results))]);
      last = s.id;
      n++;
    }
  }
  if (n) console.log(`[maintenance] protected ID numbers on ${n} existing records`);
  return n;
}

// Deletes customers (and their screening history) not screened for the configured number of years.
// A customer with a confirmed match is always kept.
async function applyRetention() {
  const years = Number(await db.getSetting('retentionYears', 0)) || 0;
  if (!years) return { years: 0, deleted: 0 };
  const r = await db.query(
    "delete from customers where coalesce(last_screened_at,created_at) < now() - ($1 || ' years')::interval and risk_status<>'confirmed_match' returning id",
    [String(years)]
  );
  if (r.rowCount) await audit(null, 'retention.purge', 'customers', null, { years, deleted: r.rowCount });
  return { years, deleted: r.rowCount };
}

async function reviewsDue() {
  const r = (await db.query("select count(*)::int n from customers where next_review_at <= now()")).rows[0].n;
  const last = await db.getSetting('reviewDueNotified', null);
  const today = new Date().toISOString().slice(0, 10);
  if (r > 0 && last !== today) {
    await db.setSetting('reviewDueNotified', today);
    await notify('reviewDue', 'MoneyBee: customer reviews are due', `${r} customer${r === 1 ? ' is' : 's are'} due for periodic review.`);
  }
  return r;
}

async function daily() {
  try {
    await applyRetention();
    await reviewsDue();
  } catch (e) {
    console.error('[maintenance] failed:', e.message);
  }
}

function start() {
  const t = setInterval(daily, 6 * 3600 * 1000);
  t.unref();
  setTimeout(daily, 60000).unref();
}

// First start with an empty UAE list: load the EOCN workbook shipped with the application, so the
// product is usable straight away. An administrator should still upload the current file, and the
// list is flagged out of date after STALE_HOURS if nobody does.
async function seedUae(manager) {
  const file = require('path').join(__dirname, '..', 'seed', 'eocn-seed.xlsx');
  const st = manager.listStatus().find((l) => l.key === 'uae');
  if (!st || st.records || !require('fs').existsSync(file)) return false;
  const upload = require('./lists/upload');
  const eocn = require('./lists/eocn');
  const sheets = await upload.readWorkbook('eocn-seed.xlsx', require('fs').readFileSync(file));
  if (!sheets || !eocn.looksLikeEocn(sheets)) return false;
  const { entries, counts } = eocn.parseWorkbook(sheets, 'uae');
  if (!entries.length) return false;
  const out = await manager.importEntries('uae', entries, { mode: 'replace', sourceLabel: 'Bundled EOCN workbook (initial load)' });
  await audit(null, 'lists.seed', 'list', 'uae', { ...counts, total: out.total });
  console.log(`[maintenance] loaded the bundled EOCN workbook: ${out.total} listings`);
  return true;
}

module.exports = { seedUae, sealExisting, applyRetention, reviewsDue, start };
