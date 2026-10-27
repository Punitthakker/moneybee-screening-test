'use strict';
// Customer risk rating and periodic review dates. The score is explained factor by factor so a
// reviewer can see why a customer is rated the way they are.

const db = require('./db');

const DEFAULT_RISK = { reviewMonths: { high: 6, medium: 12, low: 36 }, highAt: 60, mediumAt: 25 };

async function getRiskConfig() {
  const s = await db.getSetting('risk', null);
  const m = (s && s.reviewMonths) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 120 ? Math.round(Number(v)) : d);
  return { reviewMonths: { high: n(m.high, 6), medium: n(m.medium, 12), low: n(m.low, 36) }, highAt: DEFAULT_RISK.highAt, mediumAt: DEFAULT_RISK.mediumAt };
}

function assess(customer, results, confirmed) {
  const factors = [];
  const add = (points, label) => factors.push({ points, label });
  if (confirmed) add(100, 'Confirmed sanctions match');
  const hits = (results.subjects || []).reduce((n, s) => n + s.hits.length, 0);
  if (hits && !confirmed) add(60, `${hits} unresolved possible sanctions match${hits === 1 ? '' : 'es'}`);
  const flagged = new Map();
  for (const s of results.subjects || []) for (const f of s.countryFlags || []) flagged.set(f.listKey + f.iso2, f);
  for (const f of flagged.values()) {
    const pts = f.listKey === 'fatf_black' ? 50 : f.listKey === 'un_country' ? 40 : f.listKey === 'fatf_grey' ? 25 : 20;
    add(pts, `${f.country} is on ${f.listName} (${f.role.toLowerCase()})`);
  }
  if (customer.type === 'company') add(5, 'Legal entity: ownership must be understood');
  const subs = results.subjects || [];
  if (subs.length && !subs.some((s) => s.idNumber)) add(10, 'No identity document recorded');
  if (subs.length > 3) add(5, 'Many related parties');
  if ((results.incompleteReasons || []).length) add(10, 'Screening was incomplete because a required list was unavailable');
  const score = Math.min(100, factors.reduce((n, f) => n + f.points, 0));
  return { score, factors };
}

function ratingFor(score, cfg) {
  return score >= cfg.highAt ? 'high' : score >= cfg.mediumAt ? 'medium' : 'low';
}

function addMonths(date, m) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + m);
  return d;
}

// Recalculates and stores the rating and next review date for one customer.
async function applyRisk(customerId, results, confirmed) {
  const c = (await db.query('select * from customers where id=$1', [customerId])).rows[0];
  if (!c) return null;
  const cfg = await getRiskConfig();
  const { score, factors } = assess(c, results, confirmed);
  const calculated = ratingFor(score, cfg);
  const rating = c.risk_override || calculated;
  const base = c.last_reviewed_at || c.created_at;
  const next = addMonths(base, cfg.reviewMonths[rating]);
  await db.query('update customers set risk_score=$2,risk_rating=$3,risk_factors=$4,next_review_at=$5 where id=$1', [customerId, score, rating, JSON.stringify({ calculated, factors }), next]);
  return { score, rating, calculated, nextReviewAt: next };
}

module.exports = { assess, ratingFor, applyRisk, getRiskConfig, DEFAULT_RISK };
