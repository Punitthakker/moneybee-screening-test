'use strict';
// Canada (SEMA), Switzerland (SECO) and Australia (DFAT) consolidated lists. These parsers are
// written tolerantly from the published layouts. The first live download is checked by the
// record count and the first name shown on the Lists screen.

const { XMLParser } = require('fast-xml-parser');
const { parseDobList } = require('../dates');
const { toIso2List } = require('../countries');
const { stableId } = require('./parsers');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });
const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']).trim() : '';
  return String(v).trim();
};
const uniq = (a) => [...new Set(a.filter(Boolean))];

function largestArray(node) {
  let best = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      if (n.length > best.length && typeof n[0] === 'object') best = n;
      n.forEach(walk);
      return;
    }
    Object.values(n).forEach(walk);
  };
  walk(node);
  return best;
}

const pickKey = (o, re) => {
  const k = Object.keys(o).find((x) => re.test(x));
  return k === undefined ? '' : text(o[k]);
};

// ---------------- Canada: Special Economic Measures Act consolidated list ----------------
function parseCanada(raw) {
  const doc = xml.parse(raw);
  const recs = largestArray(doc);
  if (!recs.length) throw new Error('Canada: no records found in the file');
  const entries = [];
  for (const r of recs) {
    const entity = pickKey(r, /^entity$/i);
    const given = pickKey(r, /^givenname$/i);
    const last = pickKey(r, /^lastname$/i);
    const name = entity || [given, last].filter(Boolean).join(' ').trim() || Object.keys(r).filter((k) => /name|entity|individual/i.test(k) && !/alias/i.test(k)).map((k) => text(r[k])).find(Boolean) || '';
    if (!name) continue;
    const aliases = pickKey(r, /^alias/i).split(/[;|]|,\s(?=[A-Z])/).map((x) => x.trim()).filter((x) => x && x !== name);
    const country = pickKey(r, /^country/i);
    const dob = pickKey(r, /birth/i);
    const sched = pickKey(r, /^schedule$/i);
    entries.push({
      id: stableId('ca', [name.toLowerCase(), dob, pickKey(r, /^item$/i), sched]),
      type: entity ? 'company' : 'person',
      name,
      aliases: uniq(aliases),
      dobs: parseDobList(dob),
      nationalities: [],
      countries: toIso2List(country),
      ids: [],
      gender: '',
      ref: pickKey(r, /^item$/i),
      program: sched ? 'Canada SEMA, ' + sched : 'Canada SEMA',
      listedOn: pickKey(r, /listing/i),
      remarks: pickKey(r, /^(title|remarks?|comment)/i).slice(0, 400),
    });
  }
  if (!entries.length) throw new Error('Canada: no names found. First record fields: ' + Object.keys(recs[0] || {}).slice(0, 12).join(', '));
  return { entries, published: '' };
}

// ---------------- Switzerland: SECO sanctions list ----------------
function parseSwiss(raw) {
  const doc = xml.parse(raw);
  const root = doc['swiss-sanctions-list'] || doc[Object.keys(doc).find((k) => !k.startsWith('?'))];
  const targets = arr(root && root.target);
  if (!targets.length) throw new Error('Switzerland: no <target> records found in the file');
  const entries = [];
  for (const t of targets) {
    const kinds = ['individual', 'entity', 'object'].find((k) => t[k]);
    if (!kinds || kinds === 'object') continue;
    const node = t[kinds];
    const identities = arr(node.identity);
    const names = [];
    for (const idt of identities) {
      for (const nm of arr(idt.name)) {
        const parts = arr(nm['name-part']).map((p) => text(p.value || p)).filter(Boolean);
        const full = parts.join(' ').trim();
        if (full) names.push({ n: full, primary: /primary/i.test(nm['@_name-type'] || '') });
      }
    }
    if (!names.length) continue;
    const primary = names.find((n) => n.primary) || names[0];
    const dobs = [];
    for (const b of arr(node.day_month_year || node['day-month-year'])) {
      const y = b['@_year'];
      const m = b['@_month'];
      const d = b['@_day'];
      if (y) dobs.push(parseDobList([y, m, d].filter(Boolean).join('-'))[0]);
    }
    const nats = [];
    for (const n of arr(node.nationality)) nats.push(...toIso2List(text(n.country ? n.country['@_iso-code'] || n.country : n)));
    const ids = arr(node['identification-document']).map((d) => ({ type: d['@_document-type'] || 'Document', number: text(d.number), country: '' })).filter((d) => d.number);
    const ssid = t['@_ssid'] || '';
    entries.push({
      id: 'ch-' + (ssid || stableId('ch', [primary.n.toLowerCase()])),
      type: kinds === 'entity' ? 'company' : 'person',
      name: primary.n,
      aliases: uniq(names.filter((n) => n !== primary).map((n) => n.n)),
      dobs: dobs.filter(Boolean),
      nationalities: uniq(nats),
      countries: [],
      ids,
      gender: '',
      ref: ssid,
      program: 'Switzerland SECO',
      listedOn: '',
      remarks: '',
    });
  }
  return { entries, published: text(root && root['@_list-date'] || '').slice(0, 10) };
}

// ---------------- Australia: DFAT consolidated list (Excel) ----------------
async function parseAustralia(buffer) {
  const mod = await import('read-excel-file/node');
  const sheets = await mod.default(buffer);
  const sheet = sheets.reduce((a, b) => (b.data.length > a.data.length ? b : a), { data: [] });
  const rows = sheet.data;
  const h = rows.findIndex((r) => r.some((c) => /name of individual or entity/i.test(String(c || ''))));
  if (h < 0) throw new Error('Australia: could not find the "Name of Individual or Entity" column');
  const head = rows[h].map((c) => String(c || '').toLowerCase());
  const col = (re) => head.findIndex((x) => re.test(x));
  const cRef = col(/reference/), cName = col(/name of individual/), cType = col(/^type/), cNt = col(/name type/), cDob = col(/date of birth/), cPob = col(/place of birth/), cNat = col(/citizenship|nationality/), cAdd = col(/address/), cInfo = col(/additional/), cList = col(/listing information/);
  const cell = (r, i) => (i >= 0 && r[i] !== null && r[i] !== undefined ? (r[i] instanceof Date ? r[i].toISOString().slice(0, 10) : String(r[i]).trim()) : '');
  const groups = new Map();
  for (const r of rows.slice(h + 1)) {
    const ref = cell(r, cRef).replace(/[a-z]+$/i, '');
    const name = cell(r, cName);
    if (!ref || !name) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(r);
  }
  const entries = [];
  for (const [ref, rs] of groups) {
    const primary = rs.find((r) => /primary/i.test(cell(r, cNt))) || rs[0];
    const name = cell(primary, cName);
    const dobText = rs.map((r) => cell(r, cDob)).filter(Boolean).join(';');
    entries.push({
      id: 'au-' + ref,
      type: /entity/i.test(cell(primary, cType)) ? 'company' : 'person',
      name,
      aliases: uniq(rs.filter((r) => r !== primary).map((r) => cell(r, cName))).filter((n) => n !== name),
      dobs: parseDobList(dobText),
      nationalities: toIso2List(rs.map((r) => cell(r, cNat)).filter(Boolean)),
      countries: toIso2List(rs.flatMap((r) => [cell(r, cPob), cell(r, cAdd)]).filter(Boolean)),
      ids: [],
      gender: '',
      ref,
      program: 'Australia DFAT',
      listedOn: '',
      remarks: (cell(primary, cList) || cell(primary, cInfo)).slice(0, 400),
    });
  }
  return { entries, published: '' };
}

module.exports = { parseCanada, parseSwiss, parseAustralia };
