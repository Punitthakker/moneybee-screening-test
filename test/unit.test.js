'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scoreTokens, tokensOf } = require('../lib/names');
const { parseDobOne, dobCompat } = require('../lib/dates');
const { toIso2, countryName } = require('../lib/countries');
const parsers = require('../lib/lists/parsers');
const { ListIndex } = require('../lib/match');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('countries resolve names, ISO3 and aliases', () => {
  assert.strictEqual(toIso2('United Arab Emirates'), 'AE');
  assert.strictEqual(toIso2('ARE'), 'AE');
  assert.strictEqual(toIso2('UK'), 'GB');
  assert.strictEqual(toIso2('Virgin Islands (UK)'), 'VG');
  assert.strictEqual(countryName('AE'), 'United Arab Emirates');
});

test('dates parse common formats and compare', () => {
  assert.deepStrictEqual(parseDobOne('1975-03-12'), { y: 1975, m: 3, d: 12 });
  assert.deepStrictEqual(parseDobOne('14 Jul 1982'), { y: 1982, m: 7, d: 14 });
  assert.strictEqual(dobCompat(parseDobOne('1975-03-12'), [{ y: 1975, m: 3, d: 12 }], 'exact').flag, 'match');
  assert.strictEqual(dobCompat(parseDobOne('1975-03-12'), [{ y: 1980, m: 1, d: 1 }], 'exact').flag, 'mismatch');
  assert.strictEqual(dobCompat(parseDobOne('1975-03-12'), [], 'exact').flag, 'unknown');
  assert.strictEqual(dobCompat(parseDobOne('1975-03-12'), [{ y: 1975 }], 'year').flag, 'match');
});

test('every feed parser reads its fixture', () => {
  const un = parsers.parseUN(fx('un-sample.xml'));
  assert.strictEqual(un.entries.length, 3);
  const ofac = parsers.parseOFAC(fx('ofac-sample.xml'));
  assert.strictEqual(ofac.entries.length, 2);
  assert.strictEqual(ofac.entries[0].ids[0].country, 'AE');
  const eu = parsers.parseEU(fx('eu-sample.xml'));
  assert.strictEqual(eu.entries[1].type, 'company');
  const uk = parsers.parseUK(fx('uk-sample.xml'));
  assert.strictEqual(uk.entries[0].name, 'Oleg Samplington');
  assert.throws(() => parsers.parseUN('<foo/>'), /unrecognised/);
});

test('name scoring tolerates transliteration but not unrelated names', () => {
  const s = (a, b) => scoreTokens(tokensOf(a), tokensOf(b), a.replace(/\s/g, ''), b.replace(/\s/g, ''));
  assert.ok(s('Mohammed Ali', 'Muhammad Ali') >= 90);
  assert.ok(s('Aleksei Testov', 'Testov Alexei Demoson') >= 80);
  assert.ok(s('Jane Smith', 'Testov Alexei Demoson') < 70);
});

test('index search honours AND/OR with date of birth', () => {
  const idx = new ListIndex('un', parsers.parseUN(fx('un-sample.xml')).entries);
  const base = { type: 'person', name: 'Alexei Testov Demoson', dob: null, gender: '', nationalities: [], ids: [] };
  const crit = { nameThreshold: 85, operation: 'AND', dobEnforce: true, dobMode: 'exact', countryEnforce: false, idMatch: true };
  assert.strictEqual(idx.search(base, crit).hits.length, 1);
  const wrongDob = { ...base, dob: { y: 1990, m: 1, d: 1 } };
  const r = idx.search(wrongDob, crit);
  assert.strictEqual(r.hits.length, 0);
  assert.strictEqual(r.discarded.dob, 1);
  assert.strictEqual(idx.search(wrongDob, { ...crit, operation: 'OR', dobEnforce: false }).hits.length, 1);
  const byId = { ...base, name: 'Somebody Else', ids: [{ type: 'Passport', number: 'zz-900001', country: '' }] };
  assert.strictEqual(idx.search(byId, crit).hits.length, 1);
});
