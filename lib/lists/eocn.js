'use strict';
// Reader for the official UAE Local Terrorist List workbook published by the Executive Office
// for Control and Non-Proliferation (EOCN). The workbook has Arabic sheet names: individuals,
// organisations, entities, and two delisted sheets (which are skipped on purpose).

const { parseDobList } = require('../dates');
const { toIso2List } = require('../countries');
const { stableId } = require('./parsers');

const arNames = new Intl.DisplayNames(['ar'], { type: 'region' });
const AR2ISO = new Map();
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try {
      const n = arNames.of(code);
      if (n && n !== code) AR2ISO.set(arKey(n), code);
    } catch (e) {
      /* ignore */
    }
  }
}
// Spellings used in the EOCN file that differ from the standard Arabic region names.
for (const [k, v] of Object.entries({ 'الامارات': 'AE', 'الإمارات': 'AE', 'ليبيا': 'LY', 'فلسطين': 'PS', 'الولايات المتحده': 'US', 'امريكا': 'US', 'بريطانيا': 'GB', 'المملكه المتحده': 'GB', 'ايران': 'IR', 'سوريا': 'SY', 'اليمن': 'YE', 'مصر': 'EG', 'قطر': 'QA', 'تركيا': 'TR', 'الجزائر': 'DZ', 'السعوديه': 'SA', 'ايراني': 'IR', 'إيراني': 'IR', 'سوري': 'SY', 'نيجيري': 'NG', 'لبناني': 'LB', 'يمني': 'YE', 'مصري': 'EG', 'ليبي': 'LY', 'صومالي': 'SO', 'افغاني': 'AF', 'باكستاني': 'PK', 'اردني': 'JO', 'كويتي': 'KW', 'قطري': 'QA', 'سعودي': 'SA', 'عراقي': 'IQ', 'سانت كيتس - نافيس': 'KN', 'سانت كيتس ونيفيس': 'KN' })) AR2ISO.set(arKey(k), v);

function arKey(s) {
  return String(s || '')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

const DOC = [[/الرقم الموحد/, 'Unified number'], [/جواز/, 'Passport'], [/تأشير/, 'Visa'], [/هوي/, 'National ID']];
const docType = (t) => (DOC.find(([re]) => re.test(t)) || [0, t || 'Document'])[1];

const clean = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '-' || s === '–' ? '' : s;
};

function countries(text) {
  const out = [];
  for (const part of clean(text).split(/[;,\/،:]/)) {
    const k = arKey(part).replace(/^(الحاليه|السابقه)\s*/, '');
    let c = AR2ISO.get(k) || toIso2List(part)[0];
    if (!c) {
      for (const [name, iso] of AR2ISO) if (name.length >= 4 && k.includes(name)) { c = iso; break; }
    }
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function decisionYear(text) {
  const m = /\((\d+)\)\s*(?:لسنة|\/)\s*(\d{4})/.exec(String(text || ''));
  return m ? `Cabinet Resolution ${m[1]} of ${m[2]}` : '';
}

// Finds the header row (the one starting with "#") and returns the data rows below it.
function dataRows(sheet) {
  const rows = sheet.data || [];
  const h = rows.findIndex((r) => String(r[0] || '').trim() === '#');
  return h < 0 ? [] : rows.slice(h + 1).filter((r) => r.some((c) => clean(c)));
}

function looksLikeEocn(sheets) {
  return sheets.some((s) => dataRows(s).length && /الإرهاب|الارهاب|إرهاب/.test(JSON.stringify((s.data || []).slice(0, 2))));
}

function parseWorkbook(sheets, listKey) {
  const entries = [];
  const seen = new Set();
  const counts = { individuals: 0, organisations: 0, entities: 0, skippedDelisted: 0, skippedRows: 0 };
  const push = (e) => {
    if (seen.has(e.id)) {
      counts.skippedRows++;
      return false;
    }
    seen.add(e.id);
    entries.push(e);
    return true;
  };
  sheets.forEach((sheet, idx) => {
    const titleText = clean(((sheet.data || [])[0] || [])[0]);
    const rows = dataRows(sheet);
    if (!rows.length) return;
    if (/رفع/.test(String(sheet.sheet || '')) || /المرفوع/.test(titleText)) {
      counts.skippedDelisted += rows.length;
      return;
    }
    const isPeople = /الأفراد|الافراد/.test(titleText + sheet.sheet);
    const isOrgs = /التنظيمات/.test(titleText + sheet.sheet);
    const isEntities = /الكيانات/.test(titleText + sheet.sheet);
    for (const r of rows) {
      const seq = clean(r[0]);
      if (isPeople) {
        const name = clean(r[6]);
        const family = clean(r[4]);
        const full = name || family;
        if (!full) {
          counts.skippedRows++;
          continue;
        }
        const nat = countries(r[2]);
        const docs = clean(r[14]) ? [{ type: docType(clean(r[13])), number: clean(r[14]), country: countries(r[15])[0] || '' }] : [];
        const dobText = clean(r[7]);
        const ok = push({
          id: stableId(listKey, ['p', seq, full.toLowerCase(), dobText]),
          type: 'person',
          name: full,
          aliases: family && family !== full ? [family] : [],
          dobs: parseDobList(dobText),
          nationalities: nat,
          countries: [...new Set([...countries(r[8]), ...countries(r[12])])],
          ids: docs,
          gender: '',
          ref: 'EOCN-I-' + seq,
          program: 'UAE Local Terrorist List',
          listedOn: '',
          remarks: [decisionYear(clean(r[18])), clean(r[5]) ? 'Arabic name: ' + clean(r[5]) : ''].filter(Boolean).join('. ').slice(0, 400),
        });
        if (ok) counts.individuals++;
      } else if (isOrgs || isEntities) {
        const name = isOrgs ? clean(r[2]) : clean(r[3]);
        if (!name) {
          counts.skippedRows++;
          continue;
        }
        const lic = isEntities ? clean(r[5]) : '';
        const arabic = isOrgs ? clean(r[3]) : clean(r[4]) || clean(r[2]);
        const hq = isEntities ? clean(r[7]) : '';
        const other = isOrgs ? clean(r[4]) : clean(r[9]);
        const ok = push({
          id: stableId(listKey, [isOrgs ? 'o' : 'e', seq, name.toLowerCase()]),
          type: 'company',
          name,
          aliases: [],
          dobs: [],
          nationalities: [],
          countries: countries(hq),
          ids: lic ? [{ type: 'Licence', number: lic, country: '' }] : [],
          gender: '',
          ref: (isOrgs ? 'EOCN-O-' : 'EOCN-E-') + seq,
          program: 'UAE Local Terrorist List',
          listedOn: '',
          remarks: [decisionYear(other), arabic ? 'Arabic name: ' + arabic : ''].filter(Boolean).join('. ').slice(0, 400),
        });
        if (ok) counts[isOrgs ? 'organisations' : 'entities']++;
      }
    }
  });
  return { entries, counts };
}

module.exports = { looksLikeEocn, parseWorkbook };
