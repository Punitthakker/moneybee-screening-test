'use strict';
// Name normalisation and fuzzy scoring. Handles Latin and Arabic script, common Arabic name
// transliteration variants, company legal suffixes, initials and merged or split tokens.

const FOLD = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i', 'þ': 'th', 'ð': 'd' };
const ARABIC_FOLD = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };

function normalise(s) {
  let t = String(s == null ? '' : s).normalize('NFKD');
  t = t.replace(/[̀-ًͯ-ٰٟـ]/g, '');
  t = t.toLowerCase();
  t = t.replace(/[øłđßæœıþð]/g, (c) => FOLD[c]);
  t = t.replace(/[أإآٱىةؤئ]/g, (c) => ARABIC_FOLD[c]);
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

const VARIANT_GROUPS = [
  ['muhammad', 'mohammed', 'mohamed', 'muhammed', 'mohammad', 'muhamad', 'mohamad', 'mouhamed', 'mohamud', 'mahmoud'],
  ['ahmad', 'ahmed', 'ahmet'],
  ['hussein', 'hussain', 'husain', 'hosein', 'hossein', 'husayn'],
  ['hasan', 'hassan'],
  ['yusuf', 'yousef', 'youssef', 'yousuf', 'yusef', 'yousif'],
  ['umar', 'omar', 'omer'],
  ['usama', 'osama'],
  ['khalid', 'khaled', 'khaled'],
  ['ibrahim', 'ebrahim', 'ibrahem'],
  ['mustafa', 'moustafa', 'mostafa', 'mustapha'],
  ['abdallah', 'abdullah', 'abdulla', 'abdalla'],
  ['abd', 'abdul', 'abdel', 'abdal', 'abdil'],
  ['bin', 'ibn', 'ben', 'bn'],
  ['al', 'el'],
  ['abu', 'abou', 'aboo'],
  ['said', 'saeed', 'saied', 'sayed'],
  ['ali', 'aly'],
  ['rahman', 'rahmane', 'rehman'],
  ['sheikh', 'shaikh', 'shaykh', 'cheikh', 'sheik'],
  ['nasser', 'nasir', 'naser', 'nasr'],
  ['salim', 'saleem', 'selim'],
  ['jamal', 'gamal', 'jamel'],
  ['aziz', 'azeez'],
  ['karim', 'kareem'],
  ['hamad', 'hamed', 'hamid', 'hameed'],
];
const VARIANTS = {};
for (const g of VARIANT_GROUPS) for (const w of g) VARIANTS[w] = g[0];

const COMPANY_STOP = new Set([
  'ltd', 'limited', 'llc', 'fze', 'fzco', 'fzc', 'fz', 'fzllc', 'inc', 'incorporated', 'corp', 'corporation', 'co',
  'company', 'plc', 'gmbh', 'sa', 'ag', 'bv', 'nv', 'pjsc', 'jsc', 'ojsc', 'pvt', 'private', 'est', 'establishment',
  'llp', 'lp', 'sarl', 'srl', 'spa', 'oy', 'ab', 'as', 'pte', 'bhd', 'sdn', 'the', 'of', 'and', 'for', 'dmcc', 'ooo', 'zao',
]);

function tokensOf(name, company) {
  let toks = normalise(name).split(' ').filter(Boolean).map((t) => VARIANTS[t] || t);
  if (company) {
    const kept = toks.filter((t) => !COMPANY_STOP.has(t));
    if (kept.length) toks = kept;
  }
  return toks;
}

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const am = new Array(la).fill(false);
  const bm = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!bm[j] && a[i] === b[j]) {
        am[i] = true;
        bm[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (am[i]) {
      while (!bm[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
  }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}

function jaroWinkler(a, b) {
  const j = jaro(a, b);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

// Consonant skeleton: first letter kept, later vowels dropped, repeats collapsed.
// muhammad and mohammed both become mhmd.
function skeleton(t) {
  if (!/^[a-z]+$/.test(t) || t.length < 4) return t;
  let out = t[0];
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if ('aeiouyw'.includes(c)) continue;
    if (out[out.length - 1] !== c) out += c;
  }
  return out;
}

function tokenScore(q, c) {
  if (q === c) return 1;
  if (q.length === 1 && c[0] === q) return 0.9;
  if (c.length === 1 && q[0] === c) return 0.9;
  const jw = jaroWinkler(q, c);
  if (q.length >= 4 && c.length >= 4 && skeleton(q) === skeleton(c)) return Math.max(jw, 0.93);
  return jw;
}

// Score two token arrays from 0 to 100. Query coverage weighs more than candidate coverage so a
// customer name that is a sub-set or super-set of a listed name still scores sensibly.
function scoreTokens(q, c, qCompact, cCompact) {
  if (!q.length || !c.length) return 0;
  if (q.join(' ') === c.join(' ')) return 100;
  const pairs = [];
  for (let i = 0; i < q.length; i++) {
    for (let j = 0; j < c.length; j++) pairs.push([i, j, tokenScore(q[i], c[j])]);
  }
  pairs.sort((x, y) => y[2] - x[2]);
  const qu = new Set();
  const cu = new Set();
  let sum = 0;
  for (const [i, j, s] of pairs) {
    if (qu.has(i) || cu.has(j)) continue;
    qu.add(i);
    cu.add(j);
    sum += s;
  }
  let score = 0.7 * (sum / q.length) + 0.3 * (sum / c.length);
  if (qCompact && cCompact && qCompact.length >= 6 && cCompact.length >= 6) {
    score = Math.max(score, jaroWinkler(qCompact, cCompact) - 0.02);
  }
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

module.exports = { normalise, tokensOf, jaroWinkler, skeleton, tokenScore, scoreTokens, COMPANY_STOP };
