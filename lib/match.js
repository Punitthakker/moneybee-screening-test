'use strict';
// Matching engine. One ListIndex per list. A search finds candidate names through a token
// vocabulary, scores them, then applies the screening criteria (name threshold, DOB, country, ID).

const { tokensOf, jaroWinkler, skeleton, scoreTokens } = require('./names');
const { dobCompat, dobToText } = require('./dates');

const GROUPS = { c: 'k', k: 'k', q: 'k', s: 's', z: 's' };
const bucketOf = (t) => GROUPS[t[0]] || t[0];
const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class ListIndex {
  constructor(key, entries) {
    this.key = key;
    this.entries = entries;
    this.names = []; // {e, tokens, compact, primary}
    this.vocab = new Map(); // token -> number[] name indexes
    this.buckets = new Map(); // bucket -> token[]
    this.skel = new Map(); // skeleton -> token[]
    this.ids = new Map(); // normalised id -> entry index[]
    entries.forEach((entry, ei) => {
      const company = entry.type !== 'person';
      [entry.name, ...(entry.aliases || [])].forEach((n, i) => {
        const tokens = tokensOf(n, company);
        if (!tokens.length) return;
        const idx = this.names.length;
        this.names.push({ e: ei, tokens, compact: tokens.join(''), primary: i === 0 });
        for (const t of new Set(tokens)) {
          let p = this.vocab.get(t);
          if (!p) {
            p = [];
            this.vocab.set(t, p);
            const b = bucketOf(t);
            if (!this.buckets.has(b)) this.buckets.set(b, []);
            this.buckets.get(b).push(t);
            const sk = skeleton(t);
            if (sk !== t) {
              if (!this.skel.has(sk)) this.skel.set(sk, []);
              this.skel.get(sk).push(t);
            }
          }
          p.push(idx);
        }
      });
      for (const id of entry.ids || []) {
        const k = normId(id.number);
        if (k.length >= 5) {
          if (!this.ids.has(k)) this.ids.set(k, []);
          this.ids.get(k).push(ei);
        }
      }
    });
  }

  similarTokens(q) {
    const out = new Set();
    if (this.vocab.has(q)) out.add(q);
    const sk = skeleton(q);
    const viaSkel = this.skel.get(sk);
    if (viaSkel) viaSkel.forEach((t) => out.add(t));
    if (this.vocab.has(sk)) out.add(sk);
    const minJw = q.length >= 5 ? 0.8 : 0.86;
    const bucket = this.buckets.get(bucketOf(q)) || [];
    for (const v of bucket) {
      if (v === q) continue;
      if (Math.abs(v.length - q.length) > 4) continue;
      if (q.length >= 3 && v.length >= 3 && (v.startsWith(q) || q.startsWith(v))) {
        out.add(v);
        continue;
      }
      if (jaroWinkler(q, v) >= minJw) out.add(v);
    }
    return out;
  }

  // Returns best name score per entry index: Map(entryIdx -> {score, name, alias})
  scoreCandidates(qTokens) {
    const qCompact = qTokens.join('');
    const counts = new Map();
    for (const q of new Set(qTokens)) {
      const hit = new Set();
      for (const t of this.similarTokens(q)) for (const ni of this.vocab.get(t)) hit.add(ni);
      for (const ni of hit) counts.set(ni, (counts.get(ni) || 0) + 1);
    }
    let cands = [...counts.keys()];
    if (cands.length > 20000 && qTokens.length >= 2) cands = cands.filter((ni) => counts.get(ni) >= 2);
    const best = new Map();
    for (const ni of cands) {
      const rec = this.names[ni];
      const score = scoreTokens(qTokens, rec.tokens, qCompact, rec.compact);
      const cur = best.get(rec.e);
      if (!cur || score > cur.score) best.set(rec.e, { score, nameIdx: ni });
    }
    return best;
  }

  // subject: normalised subject from screening.js. criteria: see screening.js defaults.
  search(subject, criteria) {
    const company = subject.type === 'company';
    const qTokens = tokensOf(subject.name, company);
    const result = { hits: [], discarded: { dob: 0, country: 0 }, truncated: false };
    if (!qTokens.length) return result;

    const wantPerson = subject.type === 'person';
    const typeOk = (entry) => (wantPerson ? entry.type === 'person' || entry.type === 'other' : entry.type !== 'person');

    const found = new Map(); // entryIdx -> hit
    const subjIds = (subject.ids || []).map((i) => ({ ...i, n: normId(i.number) })).filter((i) => i.n.length >= 5);

    if (criteria.idMatch !== false) {
      for (const sid of subjIds) {
        for (const ei of this.ids.get(sid.n) || []) {
          const entry = this.entries[ei];
          const eid = (entry.ids || []).find((x) => normId(x.number) === sid.n);
          found.set(ei, {
            entryIdx: ei,
            score: 100,
            matchedName: entry.name,
            isAlias: false,
            idMatch: { number: sid.number, type: eid && eid.type, entryCountry: eid && eid.country, subjectCountry: sid.country },
          });
        }
      }
    }

    const scored = this.scoreCandidates(qTokens);
    for (const [ei, s] of scored) {
      if (s.score < criteria.nameThreshold) continue;
      const entry = this.entries[ei];
      if (!typeOk(entry) && !found.has(ei)) continue;
      const rec = this.names[s.nameIdx];
      const nameText = rec.primary ? entry.name : (entry.aliases || []).find((a) => tokensOf(a, entry.type !== 'person').join(' ') === rec.tokens.join(' ')) || entry.name;
      const existing = found.get(ei);
      if (existing) {
        existing.nameScore = s.score;
        existing.matchedName = nameText;
        existing.isAlias = !rec.primary;
      } else {
        found.set(ei, { entryIdx: ei, score: s.score, nameScore: s.score, matchedName: nameText, isAlias: !rec.primary });
      }
    }

    for (const hit of found.values()) {
      const entry = this.entries[hit.entryIdx];
      const idHit = !!hit.idMatch;
      const dob = dobCompat(subject.dob, entry.dobs, criteria.dobMode);
      const subjCountries = subject.nationalities || [];
      let country = { flag: 'n/a' };
      if (subjCountries.length) {
        const entryCountries = [...(entry.nationalities || []), ...(entry.countries || [])];
        if (!entryCountries.length) country = { flag: 'unknown' };
        else country = { flag: subjCountries.some((c) => entryCountries.includes(c)) ? 'match' : 'mismatch' };
      }
      let gender = { flag: 'n/a' };
      if (subject.gender) gender = { flag: !entry.gender ? 'unknown' : entry.gender === subject.gender ? 'match' : 'mismatch' };

      if (!idHit && criteria.operation === 'AND') {
        if (criteria.dobEnforce && dob.flag === 'mismatch') {
          result.discarded.dob++;
          continue;
        }
        if (criteria.countryEnforce && country.flag === 'mismatch') {
          result.discarded.country++;
          continue;
        }
      }
      let strength = 'Low';
      if (idHit) strength = 'Strong';
      else if (dob.flag === 'match') strength = hit.score >= 90 ? 'Strong' : 'Medium';
      else if (hit.score >= 95) strength = 'Medium';
      result.hits.push({
        listKey: this.key,
        entryId: entry.id,
        name: entry.name,
        matchedName: hit.matchedName,
        isAlias: hit.isAlias,
        score: hit.score,
        strength,
        type: entry.type,
        ref: entry.ref,
        program: entry.program,
        listedOn: entry.listedOn,
        dobs: (entry.dobs || []).map(dobToText),
        nationalities: entry.nationalities || [],
        countries: entry.countries || [],
        ids: (entry.ids || []).slice(0, 5),
        aliases: (entry.aliases || []).slice(0, 6),
        remarks: entry.remarks || '',
        flags: { dob: dob.flag, dobNote: dob.note || '', country: country.flag, gender: gender.flag, id: idHit ? 'match' : subjIds.length ? 'none' : 'n/a' },
        idMatch: hit.idMatch || null,
      });
    }
    result.hits.sort((a, b) => (b.idMatch ? 1 : 0) - (a.idMatch ? 1 : 0) || b.score - a.score);
    if (result.hits.length > 25) {
      result.hits = result.hits.slice(0, 25);
      result.truncated = true;
    }
    return result;
  }
}

module.exports = { ListIndex, normId };
