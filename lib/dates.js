'use strict';
// Date of birth parsing and comparison. List entries often carry partial or approximate dates.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function mk(y, m, d, approx) {
  if (y < 1800 || y > 2200) return null;
  if (m != null && (m < 1 || m > 12)) return null;
  if (d != null && (d < 1 || d > 31)) return null;
  const o = { y };
  if (m != null) o.m = m;
  if (d != null) o.d = d;
  if (approx) o.approx = true;
  return o;
}

// Returns {y,m?,d?,approx?} or {yMin,yMax,approx} or null.
function parseDobOne(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return null;
  let approx = false;
  const pre = /^(circa|ca\.?|c\.|approx\.?|approximately|about)\s*/;
  if (pre.test(s)) {
    approx = true;
    s = s.replace(pre, '');
  }
  let m;
  if ((m = s.match(/^(\d{4})\s*(?:-|to|and)\s*(\d{4})$/))) {
    const a = +m[1];
    const b = +m[2];
    return { yMin: Math.min(a, b), yMax: Math.max(a, b), approx: true };
  }
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[t\s].*)?$/))) return mk(+m[1], +m[2], +m[3], approx);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/))) {
    const a = +m[1];
    const b = +m[2];
    const [d, mo] = b > 12 ? [b, a] : [a, b];
    return mk(+m[3], mo, d, approx);
  }
  if ((m = s.match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/)) && MONTHS[m[2]]) return mk(+m[3], MONTHS[m[2]], +m[1], approx);
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTHS[m[1]]) return mk(+m[3], MONTHS[m[1]], +m[2], approx);
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{4})$/)) && MONTHS[m[1]]) return mk(+m[2], MONTHS[m[1]], null, approx);
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})$/))) return mk(+m[1], +m[2], null, approx);
  if ((m = s.match(/^(\d{4})$/))) return mk(+m[1], null, null, approx);
  return null;
}

// Parse a field that may hold several dates separated by semicolons or "or".
function parseDobList(input) {
  const out = [];
  for (const part of String(input == null ? '' : input).split(/;|\bor\b|\|/i)) {
    const o = parseDobOne(part);
    if (o) out.push(o);
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dobToText(d) {
  if (!d) return '';
  if (d.yMin != null) return `${d.yMin}-${d.yMax}`;
  let s = String(d.y);
  if (d.m != null) s += '-' + pad(d.m);
  if (d.d != null) s += '-' + pad(d.d);
  return d.approx ? 'c. ' + s : s;
}

function dobCompat(subj, entryDobs, mode) {
  if (!subj) return { flag: 'n/a' };
  if (!entryDobs || !entryDobs.length) return { flag: 'unknown' };
  let transposed = false;
  for (const e of entryDobs) {
    if (e.yMin != null) {
      if (subj.y >= e.yMin - 1 && subj.y <= e.yMax + 1) return { flag: 'match' };
      continue;
    }
    const tol = e.approx ? 1 : 0;
    if (Math.abs(subj.y - e.y) > tol) continue;
    if (mode === 'year' || e.m == null || subj.m == null || e.approx) return { flag: 'match' };
    if (e.m === subj.m && (e.d == null || subj.d == null || e.d === subj.d)) return { flag: 'match' };
    if (e.d != null && subj.d != null && e.m === subj.d && e.d === subj.m) transposed = true;
  }
  return transposed ? { flag: 'match', note: 'Day and month appear transposed' } : { flag: 'mismatch' };
}

module.exports = { parseDobOne, parseDobList, dobToText, dobCompat };
