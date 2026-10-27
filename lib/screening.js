'use strict';

const db = require('./db');
const { audit } = require('./audit');
const providers = require('./providers');
const { normalise } = require('./names');
const { parseDobOne, dobToText } = require('./dates');
const { toIso2, toIso2List, countryName } = require('./countries');
const { SANCTION_LISTS } = require('./lists');

class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}

const DEFAULT_CRITERIA = {
  nameThreshold: 85,
  operation: 'AND',
  dobEnforce: true,
  dobMode: 'exact',
  countryEnforce: false,
  idMatch: true,
  lists: null,
};

const COUNTRY_KEYS = ['fatf_black', 'fatf_grey', 'un_country'];
const ALL_LIST_KEYS = [...SANCTION_LISTS.map((l) => l.key), ...COUNTRY_KEYS];

function cleanCriteria(input, base) {
  const b = { ...DEFAULT_CRITERIA, ...(base || {}) };
  const i = input || {};
  const out = { ...b };
  if (i.nameThreshold !== undefined) {
    const n = Number(i.nameThreshold);
    if (!Number.isFinite(n) || n < 50 || n > 100) throw new ValidationError('Name match threshold must be between 50 and 100.');
    out.nameThreshold = Math.round(n);
  }
  if (i.operation !== undefined) {
    if (!['AND', 'OR'].includes(i.operation)) throw new ValidationError('Operation must be AND or OR.');
    out.operation = i.operation;
  }
  if (i.dobEnforce !== undefined) out.dobEnforce = !!i.dobEnforce;
  if (i.dobMode !== undefined) {
    if (!['exact', 'year'].includes(i.dobMode)) throw new ValidationError('Date of birth mode must be exact or year.');
    out.dobMode = i.dobMode;
  }
  if (i.countryEnforce !== undefined) out.countryEnforce = !!i.countryEnforce;
  if (i.idMatch !== undefined) out.idMatch = !!i.idMatch;
  if (i.lists !== undefined) {
    if (i.lists === null) out.lists = null;
    else {
      if (!Array.isArray(i.lists) || i.lists.some((k) => !ALL_LIST_KEYS.includes(k))) throw new ValidationError('Unknown list selected.');
      out.lists = [...new Set(i.lists)];
    }
  }
  return out;
}

async function getDefaultCriteria() {
  const saved = await db.getSetting('criteria', {});
  return cleanCriteria(saved, DEFAULT_CRITERIA);
}

const clean = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);


// Identity document handling. The ID number is a search parameter in its own right: an exact
// match on a list entry is flagged even when the name is spelled differently.
const ID_KINDS = { emiratesid: 'Emirates ID', passport: 'Passport', nationalid: 'National ID', residencepermit: 'Residence permit', residence: 'Residence permit', tradelicence: 'Trade licence', tradelicense: 'Trade licence', other: 'Other' };

function cleanId(raw, label, country) {
  const typeKey = clean(raw.idType, 60).toLowerCase().replace(/[^a-z]/g, '');
  const idType = ID_KINDS[typeKey] || clean(raw.idType, 60);
  let idNumber = clean(raw.idNumber, 60);
  let idCountry = country('idCountry', 'ID issuing country');
  if (idNumber) {
    if (idType === 'Emirates ID') {
      const d = idNumber.replace(/\D/g, '');
      if (!/^784\d{12}$/.test(d)) throw new ValidationError(`Emirates ID for ${label} must be 15 digits starting with 784, for example 784-1990-1234567-1.`);
      idNumber = `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}`;
      if (!idCountry) idCountry = 'AE';
    } else {
      idNumber = idNumber.toUpperCase();
      if (idNumber.replace(/[^A-Z0-9]/g, '').length < 5) throw new ValidationError(`The ID number for ${label} is too short to match reliably (at least 5 letters or digits).`);
    }
  }
  return { idType: idNumber || idType ? idType : '', idNumber, idCountry };
}

function normaliseSubject(raw, idx) {
  raw = raw || {};
  const label = idx === 0 ? 'the customer' : `related party ${idx}`;
  const type = raw.type === 'company' ? 'company' : 'person';
  const name = clean(raw.name);
  if (name.length < 2) throw new ValidationError(`A name is required for ${label}.`);
  let dob = '';
  if (clean(raw.dob)) {
    const d = parseDobOne(clean(raw.dob));
    if (!d || d.yMin != null) throw new ValidationError(`Date of birth for ${label} was not understood. Use YYYY-MM-DD or DD/MM/YYYY.`);
    dob = dobToText({ y: d.y, m: d.m, d: d.d });
  }
  const country = (field, what) => {
    const v = clean(raw[field]);
    if (!v) return '';
    const c = toIso2(v);
    if (!c) throw new ValidationError(`${what} for ${label} was not recognised: ${v}`);
    return c;
  };
  const gender = ['male', 'female'].includes(String(raw.gender || '').toLowerCase()) ? String(raw.gender).toLowerCase() : '';
  const s = {
    key: normalise(name),
    role: clean(raw.role, 60) || (idx === 0 ? 'Primary' : 'Related party'),
    type,
    name,
    gender,
    dob,
    nationality: country('nationality', 'Nationality'),
    country: country('country', type === 'company' ? 'Country of incorporation' : 'Country of residence'),
    ...cleanId(raw, label, country),
    idIssue: clean(raw.idIssue, 20),
    idExpiry: clean(raw.idExpiry, 20),
  };
  if (type === 'company') s.gender = '';
  return s;
}

function normaliseSubjects(list) {
  if (!Array.isArray(list) || !list.length) throw new ValidationError('At least one name is required.');
  if (list.length > 20) throw new ValidationError('A customer can have at most 20 names (customer plus related parties).');
  return list.map((s, i) => normaliseSubject(s, i));
}

function searchSubject(s) {
  const d = s.dob ? parseDobOne(s.dob) : null;
  return {
    type: s.type,
    name: s.name,
    dob: d,
    gender: s.gender,
    nationalities: [s.nationality, s.country].filter(Boolean),
    ids: s.idNumber ? [{ type: s.idType, number: s.idNumber, country: s.idCountry }] : [],
  };
}

function enabledKeys(crit) {
  return crit.lists === null ? ALL_LIST_KEYS : crit.lists;
}

// What each list contributed to this screening. Recorded so a report can be reproduced later.
function coverage(manager, crit) {
  const enabled = new Set(enabledKeys(crit));
  const rows = [];
  let incomplete = false;
  const reasons = [];
  for (const l of manager.listStatus()) {
    if (l.kind === 'provider') {
      rows.push({ key: l.key, name: l.name, category: l.category, kind: 'provider', status: l.status, note: l.note });
      continue;
    }
    if (!enabled.has(l.key)) {
      rows.push({ key: l.key, name: l.name, category: l.category, kind: l.kind, status: 'not_included' });
      continue;
    }
    if (l.kind === 'country') {
      rows.push({
        key: l.key, name: l.name, category: l.category, kind: 'country', status: 'screened', records: l.records, asOf: l.asOf,
        note: l.verifiedBy ? '' : 'List content not yet confirmed by an administrator.',
      });
      continue;
    }
    let status = 'screened';
    let note = '';
    if (l.status !== 'ready') {
      status = l.status === 'empty' && !l.required ? 'not_included' : 'unavailable';
      note = l.status === 'empty' ? (l.required ? 'No data loaded for this list.' : 'Optional list has no records.') : l.status === 'loading' ? 'List is still loading.' : 'List could not be loaded. ' + (l.error || '');
    } else if (l.stale) {
      status = 'unavailable';
      note = 'List has not been refreshed recently, so it may be out of date.';
    }
    if (status === 'unavailable' && l.required) {
      incomplete = true;
      reasons.push(`${l.name}: ${note}`.trim());
    }
    rows.push({
      key: l.key, name: l.name, category: l.category, kind: 'sanctions', status, note, records: l.records, version: l.version, published: l.published, fetchedAt: l.fetchedAt,
    });
  }
  return { rows, incomplete, reasons };
}

function countryFlags(manager, s, crit) {
  const enabled = new Set(enabledKeys(crit));
  const checks = [
    ['Nationality', s.nationality],
    [s.type === 'company' ? 'Country of incorporation' : 'Country of residence', s.country],
    ['ID issuing country', s.idCountry],
  ].filter((c) => c[1]);
  const flags = [];
  for (const [listKey, c] of manager.country) {
    if (!enabled.has(listKey)) continue;
    for (const [role, iso2] of checks) {
      if (c.countries.has(iso2)) flags.push({ listKey, listName: c.meta.name, iso2, country: countryName(iso2), role, note: c.countries.get(iso2) || '', asOf: c.meta.as_of });
    }
  }
  return flags;
}

async function priorDispositions(customerId) {
  const r = await db.query(
    `select d.subject_key,d.hit_key,d.decision,d.reason,d.screening_id,d.created_at,u.email as by_email from dispositions d
     left join users u on u.id=d.user_id where d.customer_id=$1 order by d.created_at asc, d.id asc`,
    [customerId]
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.subject_key + '|' + row.hit_key, row); // last one wins
  return map;
}

const hitKeyOf = (h) => `${h.listKey}:${h.entryId}`;

function runSearch(manager, subjects, crit) {
  const keys = enabledKeys(crit).filter((k) => SANCTION_LISTS.some((l) => l.key === k));
  return subjects.map((s) => {
    const q = searchSubject(s);
    const hits = [];
    const discarded = { dob: 0, country: 0 };
    let truncated = false;
    for (const key of keys) {
      const index = manager.getIndex(key);
      if (!index) continue;
      const r = index.search(q, crit);
      hits.push(...r.hits);
      discarded.dob += r.discarded.dob;
      discarded.country += r.discarded.country;
      truncated = truncated || r.truncated;
    }
    hits.sort((a, b) => (b.idMatch ? 1 : 0) - (a.idMatch ? 1 : 0) || b.score - a.score);
    return { ...s, hits, suppressed: [], countryFlags: countryFlags(manager, s, crit), discarded, truncated };
  });
}

function effectiveKeys(results) {
  const keys = [];
  for (const s of results.subjects) {
    for (const h of s.hits) keys.push(`${s.key}|${hitKeyOf(h)}`);
    for (const f of s.countryFlags) keys.push(`${s.key}|cflag:${f.listKey}:${f.iso2}:${f.role}`);
  }
  return keys.sort();
}

async function customerRiskStatus(customerId) {
  const r = await db.query('select review_status,outcome from screenings where customer_id=$1 order by created_at desc, id desc limit 1', [customerId]);
  const s = r.rows[0];
  if (!s) return 'clear';
  if (s.review_status === 'open') return 'open_alert';
  if (s.review_status === 'closed' && s.outcome === 'true_match') return 'confirmed_match';
  return 'clear';
}

// Core: screen a stored customer. opts.persist 'always' | 'if_changed'
async function executeScreening(manager, customer, subjects, crit, opts = {}) {
  const user = opts.user || null;
  const searched = runSearch(manager, subjects, crit);
  const prior = await priorDispositions(customer.id);
  const carry = [];
  for (const s of searched) {
    const keep = [];
    for (const h of s.hits) {
      const p = prior.get(s.key + '|' + hitKeyOf(h));
      if (p && p.decision === 'false_positive') {
        s.suppressed.push({ ...h, cleared: { by: p.by_email, at: p.created_at, reason: p.reason, screeningId: p.screening_id } });
      } else {
        if (p && p.decision === 'true_match') {
          h.previouslyConfirmed = { by: p.by_email, at: p.created_at, screeningId: p.screening_id };
          carry.push({ subjectKey: s.key, hitKey: hitKeyOf(h), p });
        }
        keep.push(h);
      }
    }
    s.hits = keep;
  }
  const cov = coverage(manager, crit);
  const results = {
    subjects: searched,
    lists: cov.rows,
    incompleteReasons: cov.reasons,
    generatedBy: user ? { id: user.id, name: user.name, email: user.email } : { name: 'System (ongoing monitoring)' },
  };
  const hitCount = searched.reduce((n, s) => n + s.hits.length, 0);
  const riskFlag = searched.some((s) => s.countryFlags.length > 0);

  if (opts.persist === 'if_changed') {
    const last = await db.query('select results from screenings where customer_id=$1 order by created_at desc, id desc limit 1', [customer.id]);
    if (last.rows[0]) {
      const same = JSON.stringify(effectiveKeys(last.rows[0].results)) === JSON.stringify(effectiveKeys(results));
      if (same) {
        await db.query('update customers set last_screened_at=now() where id=$1', [customer.id]);
        return { unchanged: true };
      }
    }
  }

  const ins = await db.query(
    `insert into screenings(customer_id,trigger,batch_id,criteria,results,alert,risk_flag,incomplete,hit_count,review_status,created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [customer.id, opts.trigger || 'manual', opts.batchId || null, JSON.stringify(crit), JSON.stringify(results), hitCount > 0, riskFlag, cov.incomplete, hitCount, hitCount > 0 ? 'open' : 'none', user ? user.id : null]
  );
  const id = ins.rows[0].id;
  for (const c of carry) {
    await db.query(
      `insert into dispositions(screening_id,customer_id,subject_key,hit_key,decision,reason,user_id) values($1,$2,$3,$4,'true_match',$5,$6)
       on conflict (screening_id,subject_key,hit_key) do nothing`,
      [id, customer.id, c.subjectKey, c.hitKey, `Carried forward from screening #${c.p.screening_id}: ${c.p.reason}`, user ? user.id : null]
    );
  }
  if (carry.length) await refreshReview(id);
  await db.query('update customers set last_screened_at=now(), risk_status=$2, updated_at=now() where id=$1', [customer.id, await customerRiskStatus(customer.id)]);
  await audit(user, 'screening.run', 'screening', id, { customer: customer.ref, trigger: opts.trigger || 'manual', hits: hitCount, riskFlag, incomplete: cov.incomplete });
  return { id };
}

async function refreshReview(screeningId) {
  const r = await db.query('select id,customer_id,results from screenings where id=$1', [screeningId]);
  const s = r.rows[0];
  if (!s) return null;
  const keys = [];
  for (const sub of s.results.subjects) for (const h of sub.hits) keys.push(sub.key + '|' + hitKeyOf(h));
  const decs = new Map((await db.query('select subject_key,hit_key,decision from dispositions where screening_id=$1', [screeningId])).rows.map((x) => [x.subject_key + '|' + x.hit_key, x.decision]));
  let status = 'none';
  let outcome = null;
  if (keys.length) {
    const open = keys.filter((k) => !decs.has(k) || decs.get(k) === 'escalate');
    const all = keys.map((k) => decs.get(k));
    if (open.length) {
      status = 'open';
      if (all.includes('escalate')) outcome = 'escalated';
    } else {
      status = 'closed';
      outcome = all.includes('true_match') ? 'true_match' : 'cleared';
    }
  }
  await db.query('update screenings set review_status=$2,outcome=$3 where id=$1', [screeningId, status, outcome]);
  await db.query('update customers set risk_status=$2 where id=$1', [s.customer_id, await customerRiskStatus(s.customer_id)]);
  return { status, outcome };
}

async function reviewHit(user, screeningId, { subjectKey, hitKey, decision, reason }, ip) {
  if (!['true_match', 'false_positive', 'escalate'].includes(decision)) throw new ValidationError('Choose true match, false positive or escalate.');
  const why = clean(reason, 1000);
  if (why.length < 5) throw new ValidationError('A reason of at least 5 characters is required.');
  const r = await db.query('select id,customer_id,results from screenings where id=$1', [screeningId]);
  const s = r.rows[0];
  if (!s) {
    const e = new Error('Screening not found');
    e.status = 404;
    throw e;
  }
  const sub = s.results.subjects.find((x) => x.key === subjectKey);
  if (!sub || !sub.hits.some((h) => hitKeyOf(h) === hitKey)) throw new ValidationError('That match is not part of this screening.');
  await db.query(
    `insert into dispositions(screening_id,customer_id,subject_key,hit_key,decision,reason,user_id) values($1,$2,$3,$4,$5,$6,$7)
     on conflict (screening_id,subject_key,hit_key) do update set decision=excluded.decision,reason=excluded.reason,user_id=excluded.user_id,created_at=now()`,
    [screeningId, s.customer_id, subjectKey, hitKey, decision, why, user.id]
  );
  const out = await refreshReview(screeningId);
  await audit(user, 'screening.review', 'screening', screeningId, { subject: subjectKey, hit: hitKey, decision, reason: why }, ip);
  return out;
}

async function upsertCustomer({ ref, subjects, monitor, userId }) {
  const type = subjects[0].type;
  const name = subjects[0].name;
  const cleanRef = clean(ref, 50);
  if (cleanRef) {
    const ex = (await db.query('select * from customers where ref=$1', [cleanRef])).rows[0];
    if (ex) {
      const r = await db.query(
        'update customers set type=$2,name=$3,subjects=$4,monitor=coalesce($5,monitor),updated_at=now() where id=$1 returning *',
        [ex.id, type, name, JSON.stringify(subjects), monitor === undefined ? null : !!monitor]
      );
      return { customer: r.rows[0], created: false };
    }
  }
  const id = (await db.query("select nextval(pg_get_serial_sequence('customers','id')) as id")).rows[0].id;
  const finalRef = cleanRef || 'MB' + String(id).padStart(6, '0');
  const r = await db.query(
    'insert into customers(id,ref,type,name,subjects,monitor,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',
    [id, finalRef, type, name, JSON.stringify(subjects), !!monitor, userId || null]
  );
  return { customer: r.rows[0], created: true };
}

async function screenCustomer(manager, { ref, subjects, monitor, criteria, user, trigger, batchId }) {
  const subs = normaliseSubjects(subjects);
  const crit = cleanCriteria(criteria, await getDefaultCriteria());
  const { customer, created } = await upsertCustomer({ ref, subjects: subs, monitor, userId: user && user.id });
  const out = await executeScreening(manager, customer, subs, crit, { user, trigger: trigger || (created ? 'manual' : 'rescreen'), batchId });
  if (created) await audit(user, 'customer.create', 'customer', customer.id, { ref: customer.ref, name: customer.name });
  return { customerId: customer.id, customerRef: customer.ref, created, screeningId: out.id };
}

async function rescreenCustomer(manager, customerId, { user, trigger, persist } = {}) {
  const c = (await db.query('select * from customers where id=$1', [customerId])).rows[0];
  if (!c) {
    const e = new Error('Customer not found');
    e.status = 404;
    throw e;
  }
  const crit = await getDefaultCriteria();
  return executeScreening(manager, c, c.subjects, crit, { user, trigger: trigger || 'rescreen', persist });
}

async function getScreening(id) {
  const r = await db.query(
    `select s.*, c.ref as customer_ref, c.name as customer_name, c.type as customer_type, c.monitor as customer_monitor, u.name as by_name, u.email as by_email
     from screenings s join customers c on c.id=s.customer_id left join users u on u.id=s.created_by where s.id=$1`,
    [id]
  );
  const s = r.rows[0];
  if (!s) return null;
  const d = await db.query(
    `select d.subject_key,d.hit_key,d.decision,d.reason,d.created_at,u.name as by_name,u.email as by_email from dispositions d left join users u on u.id=d.user_id where d.screening_id=$1 order by d.created_at`,
    [id]
  );
  return {
    id: s.id,
    customerId: s.customer_id,
    customerRef: s.customer_ref,
    customerName: s.customer_name,
    customerType: s.customer_type,
    customerMonitor: s.customer_monitor,
    trigger: s.trigger,
    batchId: s.batch_id,
    createdAt: s.created_at,
    createdBy: s.by_name ? { name: s.by_name, email: s.by_email } : { name: 'System (ongoing monitoring)' },
    criteria: s.criteria,
    results: s.results,
    alert: s.alert,
    riskFlag: s.risk_flag,
    incomplete: s.incomplete,
    hitCount: s.hit_count,
    reviewStatus: s.review_status,
    outcome: s.outcome,
    dispositions: d.rows.map((x) => ({ subjectKey: x.subject_key, hitKey: x.hit_key, decision: x.decision, reason: x.reason, at: x.created_at, by: x.by_name || x.by_email })),
  };
}

module.exports = {
  ValidationError,
  DEFAULT_CRITERIA,
  ALL_LIST_KEYS,
  cleanCriteria,
  getDefaultCriteria,
  normaliseSubjects,
  screenCustomer,
  rescreenCustomer,
  reviewHit,
  getScreening,
  refreshReview,
  hitKeyOf,
};
