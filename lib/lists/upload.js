'use strict';
// Reads an uploaded CSV or Excel file (for the UAE Local Terrorist List and the custom list),
// guesses the column mapping, and turns rows into list entries.

const { parse: parseCsv } = require('csv-parse/sync');
const { parseDobList } = require('../dates');
const { toIso2List } = require('../countries');
const { normalise, COMPANY_STOP } = require('../names');
const { stableId } = require('./parsers');

const MAX_ROWS = 50000;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

async function readRows(filename, buffer) {
  const lower = String(filename || '').toLowerCase();
  let rows;
  if (lower.endsWith('.xlsx')) {
    const mod = await import('read-excel-file/node');
    const sheets = await mod.default(buffer);
    if (!sheets || !sheets.length) throw new Error('The Excel file has no sheets.');
    const best = sheets.reduce((a, b) => (b.data.length > a.data.length ? b : a));
    rows = best.data;
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const textContent = buffer.toString('utf8');
    const first = textContent.split(/\r?\n/, 1)[0] || '';
    const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    rows = parseCsv(textContent, { delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, relax_quotes: true });
  } else {
    throw new Error('Please upload a .csv or .xlsx file. Old .xls files and PDFs are not supported: open them in Excel and save as .xlsx or .csv.');
  }
  rows = rows.map((r) => r.map(cellText));
  if (rows.length > MAX_ROWS) throw new Error(`The file has more than ${MAX_ROWS} rows.`);
  return rows.filter((r) => r.some((c) => c));
}

const HEADER_WORDS = /name|alias|nationality|birth|dob|type|reference|passport|id\b|number|category|remark|country/i;

function detectHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const filled = rows[i].filter(Boolean);
    if (filled.length >= 2 && filled.some((c) => HEADER_WORDS.test(c))) return i;
  }
  return 0;
}

function autoMapping(headers) {
  const h = headers.map((x, i) => ({ x, l: x.toLowerCase(), i }));
  const pick = (re, exclude) => h.filter((c) => c.x && re.test(c.l) && !(exclude && exclude.test(c.l))).map((c) => c.x);
  const first = (a) => a[0] || '';
  const name = pick(/name/, /alias|arabic|original|script|father|mother|other|also|aka|former|previous/);
  return {
    name: name.length ? [name[0]] : [],
    aliases: pick(/alias|arabic|original script|other name|also known|aka|former name|previous name/),
    type: first(pick(/^type$|category|individual\/entity|entity type|designation type/)),
    dob: first(pick(/birth|dob/, /place|country|city/)),
    nationality: first(pick(/nationalit|citizen/)),
    country: first(pick(/country|place of birth|address/, /nationalit/)),
    idNumber: first(pick(/passport|id number|document|national id|emirates id|identification|id no/)),
    ref: first(pick(/^ref|reference|serial|^no\.?$|^id$|^#$/)),
    remarks: first(pick(/remark|note|comment|detail|basis|programme|program|reason/)),
  };
}

function inferType(name) {
  const toks = normalise(name).split(' ');
  if (toks.some((t) => COMPANY_STOP.has(t) && !['the', 'of', 'and', 'for', 'as', 'ab', 'oy'].includes(t))) return 'company';
  if (toks.some((t) => ['group', 'organization', 'organisation', 'foundation', 'bank', 'trading', 'company', 'movement', 'front', 'army', 'brigade', 'party', 'committee', 'council', 'association', 'society'].includes(t))) return 'company';
  return 'person';
}

function buildEntries(rows, headerRowIdx, mapping, listKey) {
  const headers = rows[headerRowIdx];
  const col = (hdr) => (hdr ? headers.indexOf(hdr) : -1);
  const get = (row, hdr) => {
    const i = col(hdr);
    return i >= 0 ? cellText(row[i]) : '';
  };
  const nameCols = (mapping.name || []).filter(Boolean);
  if (!nameCols.length) throw new Error('Choose at least one column for the name.');
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows.slice(headerRowIdx + 1)) {
    const name = nameCols.map((c) => get(row, c)).filter(Boolean).join(' ').trim();
    if (!name) {
      skipped++;
      continue;
    }
    const aliases = (mapping.aliases || [])
      .flatMap((c) => get(row, c).split(/[;|\n]|\s\/\s/))
      .map((s) => s.trim())
      .filter((s) => s && s !== name);
    const typeRaw = get(row, mapping.type).toLowerCase();
    const type = /entit|organi|company|group|enterprise|org/.test(typeRaw) ? 'company' : /individual|person|natural/.test(typeRaw) ? 'person' : inferType(name);
    const dobText = get(row, mapping.dob);
    const ref = get(row, mapping.ref);
    const ids = get(row, mapping.idNumber)
      .split(/[;|\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => ({ type: 'Document', number: n, country: '' }));
    const id = stableId(listKey, [normalise(name), ref, dobText]);
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    entries.push({
      id,
      type,
      name,
      aliases: [...new Set(aliases)],
      dobs: parseDobList(dobText),
      nationalities: toIso2List(get(row, mapping.nationality)),
      countries: toIso2List(get(row, mapping.country)),
      ids,
      gender: '',
      ref,
      program: '',
      listedOn: '',
      remarks: get(row, mapping.remarks).slice(0, 400),
    });
  }
  return { entries, skipped };
}

module.exports = { readRows, detectHeaderRow, autoMapping, buildEntries };
