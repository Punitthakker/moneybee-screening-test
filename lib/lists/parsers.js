'use strict';
// Parsers turn each published list into one common entry shape:
// { id, type: person|company|other, name, aliases[], dobs[], nationalities[iso2], countries[iso2],
//   ids[{type,number,country}], gender, ref, program, listedOn, remarks }

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { parseDobOne, parseDobList } = require('../dates');
const { toIso2List } = require('../countries');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });

const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']).trim() : '';
  return String(v).trim();
};
const uniq = (a) => [...new Set(a.filter(Boolean))];

function collect(node, tag, out) {
  out = out || [];
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, tag, out));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === tag) {
      for (const item of arr(v)) {
        const t = text(item);
        if (t) out.push(t);
        if (item && typeof item === 'object') collect(item, tag, out);
      }
    } else if (typeof v === 'object') collect(v, tag, out);
  }
  return out;
}

function entryType(s) {
  const t = String(s || '').toLowerCase();
  if (/individual|person|^p$/.test(t)) return 'person';
  if (/entity|enterprise|organi[sz]ation|company|^e$/.test(t)) return 'company';
  return 'other';
}

function stableId(prefix, parts) {
  return prefix + '-' + crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function parseXml(raw, label) {
  try {
    return xml.parse(raw);
  } catch (e) {
    throw new Error(`${label}: XML could not be parsed (${e.message})`);
  }
}

function rootInfo(doc) {
  const keys = Object.keys(doc).filter((k) => !k.startsWith('?'));
  const root = keys[0] || '(none)';
  const childKeys = doc[root] && typeof doc[root] === 'object' ? Object.keys(doc[root]).slice(0, 8) : [];
  return `root=${root} children=[${childKeys.join(',')}]`;
}

// ---------------- UN Security Council consolidated list ----------------
function unDob(d) {
  const t = text(d.TYPE_OF_DATE).toUpperCase();
  const approx = t === 'APPROXIMATE' || t === 'BETWEEN';
  if (d.DATE && text(d.DATE)) {
    const o = parseDobOne(text(d.DATE));
    if (o) return approx ? { ...o, approx: true } : o;
  }
  if (d.YEAR && text(d.YEAR)) return { y: +text(d.YEAR), ...(approx ? { approx: true } : {}) };
  if (d.FROM_YEAR && d.TO_YEAR) return { yMin: +text(d.FROM_YEAR), yMax: +text(d.TO_YEAR), approx: true };
  return null;
}

function parseUN(raw) {
  const doc = parseXml(raw, 'UN');
  const root = doc.CONSOLIDATED_LIST;
  if (!root) throw new Error('UN: unrecognised format, ' + rootInfo(doc));
  const entries = [];
  for (const p of arr(root.INDIVIDUALS && root.INDIVIDUALS.INDIVIDUAL)) {
    const name = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].map(text).filter(Boolean).join(' ');
    if (!name) continue;
    const aliases = uniq([...arr(p.INDIVIDUAL_ALIAS).map((a) => text(a.ALIAS_NAME)), text(p.NAME_ORIGINAL_SCRIPT)]).filter((a) => a !== name);
    const countries = [
      ...arr(p.INDIVIDUAL_PLACE_OF_BIRTH).map((x) => text(x.COUNTRY)),
      ...arr(p.INDIVIDUAL_ADDRESS).map((x) => text(x.COUNTRY)),
    ];
    entries.push({
      id: text(p.DATAID) || stableId('un', [name]),
      type: 'person',
      name,
      aliases,
      dobs: arr(p.INDIVIDUAL_DATE_OF_BIRTH).map(unDob).filter(Boolean),
      nationalities: toIso2List(arr(p.NATIONALITY).flatMap((n) => arr(n.VALUE)).map(text)),
      countries: toIso2List(countries),
      ids: arr(p.INDIVIDUAL_DOCUMENT)
        .map((d) => ({ type: text(d.TYPE_OF_DOCUMENT), number: text(d.NUMBER), country: toIso2List([text(d.ISSUING_COUNTRY)])[0] || '' }))
        .filter((d) => d.number),
      gender: '',
      ref: text(p.REFERENCE_NUMBER),
      program: text(p.UN_LIST_TYPE),
      listedOn: text(p.LISTED_ON),
      remarks: text(p.COMMENTS1).slice(0, 400),
    });
  }
  for (const e of arr(root.ENTITIES && root.ENTITIES.ENTITY)) {
    const name = text(e.FIRST_NAME);
    if (!name) continue;
    entries.push({
      id: text(e.DATAID) || stableId('un', [name]),
      type: 'company',
      name,
      aliases: uniq(arr(e.ENTITY_ALIAS).map((a) => text(a.ALIAS_NAME))).filter((a) => a !== name),
      dobs: [],
      nationalities: [],
      countries: toIso2List(arr(e.ENTITY_ADDRESS).map((x) => text(x.COUNTRY))),
      ids: [],
      gender: '',
      ref: text(e.REFERENCE_NUMBER),
      program: text(e.UN_LIST_TYPE),
      listedOn: text(e.LISTED_ON),
      remarks: text(e.COMMENTS1).slice(0, 400),
    });
  }
  return { entries, published: String(root['@_dateGenerated'] || '').slice(0, 10) };
}

// ---------------- OFAC SDN (legacy sdn.xml format) ----------------
function parseOFAC(raw) {
  const doc = parseXml(raw, 'OFAC');
  const root = doc.sdnList;
  if (!root) throw new Error('OFAC: unrecognised format (expected sdnList), ' + rootInfo(doc));
  const entries = [];
  for (const s of arr(root.sdnEntry)) {
    const name = [text(s.firstName), text(s.lastName)].filter(Boolean).join(' ');
    if (!name) continue;
    const aliases = uniq(arr(s.akaList && s.akaList.aka).map((a) => [text(a.firstName), text(a.lastName)].filter(Boolean).join(' '))).filter((a) => a !== name);
    const remarks = text(s.remarks);
    const gm = remarks.match(/Gender\s+(Male|Female)/i);
    const countries = [
      ...arr(s.addressList && s.addressList.address).map((a) => text(a.country)),
      ...arr(s.placeOfBirthList && s.placeOfBirthList.placeOfBirthItem).map((p) => {
        const parts = text(p.placeOfBirth).split(',');
        return parts[parts.length - 1].trim();
      }),
    ];
    entries.push({
      id: text(s.uid) || stableId('ofac', [name]),
      type: entryType(text(s.sdnType)),
      name,
      aliases,
      dobs: arr(s.dateOfBirthList && s.dateOfBirthList.dateOfBirthItem).flatMap((d) => parseDobList(text(d.dateOfBirth))),
      nationalities: toIso2List([
        ...arr(s.nationalityList && s.nationalityList.nationality).map((n) => text(n.country)),
        ...arr(s.citizenshipList && s.citizenshipList.citizenship).map((n) => text(n.country)),
      ]),
      countries: toIso2List(countries),
      ids: arr(s.idList && s.idList.id)
        .map((i) => ({ type: text(i.idType), number: text(i.idNumber), country: toIso2List([text(i.idCountry)])[0] || '' }))
        .filter((i) => i.number),
      gender: gm ? gm[1].toLowerCase() : '',
      ref: text(s.uid),
      program: arr(s.programList && s.programList.program).map(text).join(', '),
      listedOn: '',
      remarks: remarks.slice(0, 400),
    });
  }
  const info = root.publshInformation || root.publishInformation || {};
  return { entries, published: text(info.Publish_Date) };
}

// ---------------- EU consolidated financial sanctions (FSF 1.1) ----------------
function parseEU(raw) {
  const doc = parseXml(raw, 'EU');
  const root = doc.export;
  if (!root) throw new Error('EU: unrecognised format (expected export), ' + rootInfo(doc));
  const entries = [];
  for (const s of arr(root.sanctionEntity)) {
    const aliasNodes = arr(s.nameAlias);
    const names = aliasNodes
      .map((a) => ({
        n: String(a['@_wholeName'] || [a['@_firstName'], a['@_middleName'], a['@_lastName']].filter(Boolean).join(' ')).trim(),
        strong: String(a['@_strong']) === 'true',
        gender: String(a['@_gender'] || ''),
      }))
      .filter((a) => a.n);
    if (!names.length) continue;
    const primary = names.find((n) => n.strong) || names[0];
    const st = s.subjectType || {};
    const gender = (names.find((n) => n.gender) || {}).gender || '';
    const reg = arr(s.regulation)[0] || {};
    entries.push({
      id: String(s['@_logicalId'] || '') || stableId('eu', [primary.n]),
      type: entryType(String(st['@_code'] || st['@_classificationCode'] || '')),
      name: primary.n,
      aliases: uniq(names.map((n) => n.n)).filter((n) => n !== primary.n),
      dobs: arr(s.birthdate)
        .map((b) => {
          const o = parseDobOne(b['@_birthdate']) || (b['@_year'] ? { y: +b['@_year'] } : null);
          if (o && String(b['@_circa']) === 'true') o.approx = true;
          return o;
        })
        .filter(Boolean),
      nationalities: toIso2List(arr(s.citizenship).map((c) => c['@_countryIso2Code'] || c['@_countryDescription'])),
      countries: toIso2List([
        ...arr(s.address).map((a) => a['@_countryIso2Code'] || a['@_countryDescription']),
        ...arr(s.birthdate).map((b) => b['@_countryIso2Code'] || b['@_countryDescription']),
      ]),
      ids: arr(s.identification)
        .map((i) => ({
          type: String(i['@_identificationTypeDescription'] || i['@_identificationTypeCode'] || ''),
          number: String(i['@_number'] || ''),
          country: toIso2List([i['@_countryIso2Code'] || i['@_countryDescription']])[0] || '',
        }))
        .filter((i) => i.number),
      gender: /^f/i.test(gender) ? 'female' : /^m/i.test(gender) ? 'male' : '',
      ref: String(s['@_euReferenceNumber'] || ''),
      program: String(reg['@_programme'] || ''),
      listedOn: String(reg['@_entryIntoForceDate'] || reg['@_publicationDate'] || ''),
      remarks: text(arr(s.remark)[0]).slice(0, 400),
    });
  }
  return { entries, published: String(root['@_generationDate'] || '').slice(0, 10) };
}

// ---------------- UK Sanctions List ----------------
const NAME_PARTS = ['Name1', 'Name2', 'Name3', 'Name4', 'Name5', 'Name6'];

function fullName(node) {
  return NAME_PARTS.map((k) => text(node[k])).filter(Boolean).join(' ');
}

function parseUKDesignations(root) {
  const entries = [];
  for (const d of arr(root.Designation)) {
    const nameNodes = arr(d.Names && d.Names.Name).map((n) => ({ n: fullName(n), type: text(n.NameType) })).filter((n) => n.n);
    if (!nameNodes.length) continue;
    const primary = nameNodes.find((n) => /primary name$/i.test(n.type)) || nameNodes[0];
    const kind = text(d.IndividualEntityShip) || (d.IndividualDetails ? 'Individual' : d.EntityDetails ? 'Entity' : '');
    const dobs = collect(d, 'DOB').flatMap((x) => parseDobList(x));
    const countries = toIso2List([...collect(d, 'AddressCountry'), ...collect(d, 'CountryOfBirth'), ...collect(d, 'Country')]);
    const ids = [
      ...collect(d, 'PassportNumber').map((n) => ({ type: 'Passport', number: n, country: '' })),
      ...collect(d, 'NationalIdNumber').map((n) => ({ type: 'National ID', number: n, country: '' })),
    ];
    entries.push({
      id: text(d.UniqueID) || text(d.OFSIGroupID) || stableId('uk', [primary.n]),
      type: entryType(kind),
      name: primary.n,
      aliases: uniq(nameNodes.map((n) => n.n)).filter((n) => n !== primary.n),
      dobs,
      nationalities: toIso2List(collect(d, 'Nationality')),
      countries,
      ids,
      gender: (collect(d, 'Gender')[0] || '').toLowerCase(),
      ref: text(d.UniqueID) || text(d.OFSIGroupID),
      program: text(d.RegimeName),
      listedOn: text(d.DateDesignated),
      remarks: text(d.UKStatementOfReasons).slice(0, 400),
    });
  }
  return entries;
}

function parseUKFlat(root) {
  const groups = new Map();
  for (const t of arr(root.FinancialSanctionsTarget)) {
    const gid = text(t.GroupID) || text(t.Id);
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(t);
  }
  const entries = [];
  for (const [gid, rows] of groups) {
    const names = rows.map((r) => ({ n: fullName(r), type: text(r.AliasType) })).filter((n) => n.n);
    if (!names.length) continue;
    const primary = names.find((n) => /primary/i.test(n.type)) || names[0];
    const r0 = rows[0];
    entries.push({
      id: gid,
      type: entryType(text(r0.GroupTypeDescription)),
      name: primary.n,
      aliases: uniq(names.map((n) => n.n)).filter((n) => n !== primary.n),
      dobs: rows.flatMap((r) => parseDobList(text(r.DateOfBirth))),
      nationalities: toIso2List(rows.map((r) => text(r.Nationality))),
      countries: toIso2List(rows.flatMap((r) => [text(r.Address6), text(r.CountryOfBirth)])),
      ids: rows.map((r) => text(r.PassportNumber)).filter(Boolean).map((n) => ({ type: 'Passport', number: n, country: '' })),
      gender: text(r0.Gender).toLowerCase(),
      ref: gid,
      program: text(r0.RegimeName),
      listedOn: text(r0.ListedOn),
      remarks: '',
    });
  }
  return entries;
}

function parseUK(raw) {
  const doc = parseXml(raw, 'UK');
  let entries;
  let published = '';
  if (doc.Designations) {
    entries = parseUKDesignations(doc.Designations);
    published = text(doc.Designations['@_DateGenerated'] || doc.Designations.DateGenerated || doc.Designations.LastUpdated).slice(0, 10);
  } else if (doc.ArrayOfFinancialSanctionsTarget) {
    entries = parseUKFlat(doc.ArrayOfFinancialSanctionsTarget);
  } else {
    throw new Error('UK: unrecognised format, ' + rootInfo(doc));
  }
  return { entries, published };
}

module.exports = { parseUN, parseOFAC, parseEU, parseUK, stableId, entryType };
