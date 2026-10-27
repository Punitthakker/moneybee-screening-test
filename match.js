// Name matching helpers: normalisation, Jaro-Winkler, and a token-based score (0-100).

function normalise(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

// Score a query against one candidate name. Both are already normalised token arrays.
function scoreTokens(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  if (qTokens.join(" ") === cTokens.join(" ")) return 100;

  // For every query token, find the best candidate token (each candidate token used once).
  const used = new Set();
  let total = 0;
  for (const q of qTokens) {
    let best = 0;
    let bestIdx = -1;
    cTokens.forEach((c, idx) => {
      if (used.has(idx)) return;
      const s = jaroWinkler(q, c);
      if (s > best) {
        best = s;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
  }
  const coverageQuery = total / qTokens.length;

  // Penalise candidates with many extra tokens the query does not account for.
  const extra = Math.max(0, cTokens.length - qTokens.length);
  const penalty = Math.min(0.15, extra * 0.04);

  // Single-token queries are weak evidence, so cap them.
  const cap = qTokens.length === 1 ? 0.85 : 1;

  return Math.round(Math.max(0, Math.min(cap, coverageQuery - penalty)) * 100);
}

function scoreRecord(query, record) {
  const q = normalise(query).split(" ").filter(Boolean);
  let best = 0;
  let matchedName = record.name;
  for (const n of [record.name, ...(record.aliases || [])]) {
    const s = scoreTokens(q, normalise(n).split(" ").filter(Boolean));
    if (s > best) {
      best = s;
      matchedName = n;
    }
  }
  return { score: best, matchedName };
}

module.exports = { normalise, jaroWinkler, scoreRecord };
