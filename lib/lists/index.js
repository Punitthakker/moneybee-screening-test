'use strict';
// Owns every list: downloads feeds, caches them in the database, keeps in-memory indexes,
// handles uploaded lists (UAE, custom) and the editable country-risk lists.

const EventEmitter = require('events');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const { ListIndex } = require('../match');
const parsers = require('./parsers');
const extra = require('./extra');
const providers = require('../providers');
const { countryName } = require('../countries');

const SANCTION_LISTS = [
  { key: 'un', name: 'UN Security Council Consolidated List', category: 'Sanctions', mode: 'feed', required: true, parse: parsers.parseUN },
  { key: 'ofac', name: 'OFAC SDN List (US)', category: 'Sanctions', mode: 'feed', required: true, parse: parsers.parseOFAC },
  { key: 'eu', name: 'EU Consolidated Financial Sanctions List', category: 'Sanctions', mode: 'feed', required: true, parse: parsers.parseEU },
  { key: 'uk', name: 'UK Sanctions List', category: 'Sanctions', mode: 'feed', required: true, parse: parsers.parseUK },
  { key: 'canada', name: 'Canada Consolidated Sanctions (SEMA)', category: 'Sanctions', mode: 'feed', required: false, parse: extra.parseCanada },
  { key: 'swiss', name: 'Switzerland SECO Sanctions List', category: 'Sanctions', mode: 'feed', required: false, parse: extra.parseSwiss },
  { key: 'australia', name: 'Australia DFAT Consolidated List', category: 'Sanctions', mode: 'feed', required: false, binary: true, parse: extra.parseAustralia },
  { key: 'uae', name: 'UAE Local Terrorist List (EOCN)', category: 'Sanctions', mode: 'upload', required: true },
  { key: 'custom', name: 'Custom list (internal watchlist)', category: 'Internal', mode: 'upload', required: false },
];

const COUNTRY_SEEDS = [
  {
    key: 'fatf_black',
    name: 'FATF High-Risk Jurisdictions subject to a Call for Action (black list)',
    as_of: '2026-06-19',
    source: 'FATF black and grey lists page, update of 19 June 2026. Check for a newer plenary outcome.',
    countries: { KP: '', IR: '', MM: '' },
  },
  {
    key: 'fatf_grey',
    name: 'FATF Jurisdictions under Increased Monitoring (grey list)',
    as_of: '2026-06-19',
    source: 'FATF black and grey lists page, update of 19 June 2026. Check for a newer plenary outcome.',
    countries: Object.fromEntries(['AO', 'BO', 'BA', 'BG', 'CM', 'CI', 'CD', 'HT', 'IQ', 'KE', 'KW', 'LA', 'LB', 'MC', 'NP', 'PG', 'SS', 'SY', 'VE', 'VN', 'VG', 'YE'].map((c) => [c, ''])),
  },
  {
    key: 'un_country',
    name: 'UN Security Council country sanctions regimes',
    as_of: null,
    source: 'Seeded from general knowledge and NOT checked against the UN website. Review before go live.',
    countries: Object.fromEntries(['AF', 'CF', 'CD', 'HT', 'IQ', 'KP', 'LY', 'SO', 'SS', 'SD', 'YE', 'GW'].map((c) => [c, 'UN Security Council sanctions regime'])),
  },
];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const META_COLS = new Set(['status', 'error', 'version', 'record_count', 'source_url', 'published', 'hash', 'fetched_at', 'changed_at', 'diagnostics']);

class ListManager extends EventEmitter {
  constructor() {
    super();
    this.state = new Map();
    this.country = new Map();
    this.timer = null;
    this.refreshing = false;
  }

  async init() {
    for (const def of SANCTION_LISTS) {
      await db.query('insert into lists(key,name) values($1,$2) on conflict (key) do update set name=excluded.name', [def.key, def.name]);
    }
    const rows = (await db.query('select * from lists')).rows;
    for (const def of SANCTION_LISTS) {
      this.state.set(def.key, { def, index: null, meta: rows.find((r) => r.key === def.key) || {} });
    }
    await this.seedCountryLists();
    await this.loadCountryRisk();
    for (const def of SANCTION_LISTS) {
      try {
        if (def.mode === 'feed') await this.loadFromCache(def.key);
        else await this.loadUploaded(def.key);
      } catch (e) {
        console.error(`[lists] could not load ${def.key} at start:`, e.message);
      }
    }
  }

  async setMeta(key, patch) {
    const cols = Object.keys(patch).filter((c) => META_COLS.has(c));
    if (!cols.length) return;
    const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
    const vals = cols.map((c) => (c === 'diagnostics' && patch[c] ? JSON.stringify(patch[c]) : patch[c]));
    await db.query(`update lists set ${sets} where key=$1`, [key, ...vals]);
    Object.assign(this.state.get(key).meta, patch);
  }

  async loadFromCache(key) {
    const r = await db.query('select data from list_cache where key=$1', [key]);
    if (!r.rows[0]) return;
    const entries = JSON.parse(zlib.gunzipSync(r.rows[0].data).toString('utf8'));
    const st = this.state.get(key);
    st.index = new ListIndex(key, entries);
    if (st.meta.status !== 'ready') await this.setMeta(key, { status: 'ready' });
    console.log(`[lists] ${key}: restored ${entries.length} entries from the database cache`);
  }

  async loadUploaded(key) {
    const r = await db.query('select entry from list_entries where list_key=$1 order by id', [key]);
    const st = this.state.get(key);
    if (r.rows.length) {
      st.index = new ListIndex(key, r.rows.map((x) => x.entry));
      if (st.meta.status !== 'ready') await this.setMeta(key, { status: 'ready' });
    } else {
      st.index = null;
      if (st.meta.status !== 'empty') await this.setMeta(key, { status: 'empty' });
    }
  }

  // Parse raw feed text, index it, cache it. Throws if the file looks wrong.
  async ingest(key, raw, info = {}) {
    const st = this.state.get(key);
    const hash = sha(raw);
    const prev = st.meta || {};
    if (st.index && prev.hash === hash) {
      await this.setMeta(key, { fetched_at: new Date(), error: null, status: 'ready', source_url: info.sourceUrl || prev.source_url });
      console.log(`[lists] ${key}: unchanged since last download`);
      return { changed: false };
    }
    const parsed = await st.def.parse(raw);
    const n = parsed.entries.length;
    if (!n) throw new Error('The file parsed but contained 0 entries');
    if (prev.record_count > 100 && n < prev.record_count * 0.6) {
      throw new Error(`Refusing to replace ${prev.record_count} entries with a file of only ${n}. Kept the previous list.`);
    }
    const index = new ListIndex(key, parsed.entries);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(parsed.entries)));
    await db.query(
      'insert into list_cache(key,hash,data,updated_at) values($1,$2,$3,now()) on conflict (key) do update set hash=excluded.hash,data=excluded.data,updated_at=now()',
      [key, hash, gz]
    );
    st.index = index;
    const rssMb = Math.round(process.memoryUsage().rss / 1e6);
    await this.setMeta(key, {
      status: 'ready',
      error: null,
      version: hash.slice(0, 10),
      record_count: n,
      source_url: info.sourceUrl || null,
      published: parsed.published || null,
      hash,
      fetched_at: new Date(),
      changed_at: new Date(),
      diagnostics: { bytes: info.bytes || raw.length, ms: info.ms || null, rssMb, names: index.names.length, first: parsed.entries[0] && parsed.entries[0].name },
    });
    console.log(`[lists] ${key}: loaded ${n} entries, ${index.names.length} names, published=${parsed.published || 'n/a'}, rss=${rssMb}MB`);
    this.emit('changed', key);
    return { changed: true };
  }

  async refreshFeed(key) {
    const st = this.state.get(key);
    if (!st || st.def.mode !== 'feed') throw new Error('Not a downloadable list: ' + key);
    const errors = [];
    for (const url of cfg.feeds[key] || []) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'MoneyBeeScreening/1.0', accept: 'application/xml,text/xml,*/*' },
          signal: AbortSignal.timeout(180000),
          redirect: 'follow',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = st.def.binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
        if (!st.def.binary && !raw.trimStart().startsWith('<')) {
          throw new Error(`Response is not XML (content-type ${res.headers.get('content-type')}, starts with: ${raw.slice(0, 80).replace(/\s+/g, ' ')})`);
        }
        await this.ingest(key, raw, { sourceUrl: url, ms: Date.now() - t0, bytes: raw.length });
        return { ok: true, url };
      } catch (e) {
        errors.push(`${url}: ${e.message}`);
        console.error(`[lists] ${key} failed for ${url}: ${e.message}`);
      }
    }
    const msg = errors.join(' | ') || 'No download URL configured';
    await this.setMeta(key, { error: msg.slice(0, 1500), status: st.index ? 'ready' : 'error' });
    return { ok: false, error: msg };
  }

  async refreshAll() {
    if (this.refreshing || cfg.disableFeeds) return;
    this.refreshing = true;
    try {
      for (const def of SANCTION_LISTS.filter((d) => d.mode === 'feed')) {
        await this.refreshFeed(def.key);
        if (global.gc) global.gc();
      }
    } finally {
      this.refreshing = false;
    }
  }

  startScheduler() {
    if (cfg.disableFeeds) return;
    setTimeout(() => this.refreshAll().catch((e) => console.error('[lists] refresh failed:', e.message)), 1500);
    this.timer = setInterval(() => this.refreshAll().catch((e) => console.error('[lists] refresh failed:', e.message)), cfg.refreshHours * 3600 * 1000);
    this.timer.unref();
  }

  async importEntries(key, entries, { mode, sourceLabel }) {
    const st = this.state.get(key);
    if (!st || st.def.mode !== 'upload') throw new Error('This list is not upload-managed.');
    const before = new Set(st.index ? st.index.entries.map((e) => e.id) : []);
    let toInsert = entries;
    if (mode === 'append' && st.index) {
      const have = new Set(st.index.entries.map((e) => e.id));
      toInsert = entries.filter((e) => !have.has(e.id));
    }
    await db.tx(async (c) => {
      if (mode !== 'append') await c.query('delete from list_entries where list_key=$1', [key]);
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500);
        const vals = [];
        const ph = chunk.map((e, j) => {
          vals.push(JSON.stringify(e));
          return `($1,$${j + 2})`;
        });
        await c.query(`insert into list_entries(list_key,entry) values ${ph.join(',')}`, [key, ...vals]);
      }
    });
    await this.loadUploaded(key);
    const count = st.index ? st.index.entries.length : 0;
    await this.setMeta(key, {
      status: count ? 'ready' : 'empty',
      error: null,
      version: sha(String(Date.now()) + key).slice(0, 10),
      record_count: count,
      source_url: sourceLabel || 'upload',
      fetched_at: new Date(),
      changed_at: new Date(),
    });
    this.emit('changed', key);
    const after = new Set(st.index ? st.index.entries.map((e) => e.id) : []);
    let addedIds = 0;
    let removedIds = 0;
    for (const id of after) if (!before.has(id)) addedIds++;
    for (const id of before) if (!after.has(id)) removedIds++;
    return { added: toInsert.length, total: count, addedIds, removedIds };
  }

  async clearUploaded(key) {
    await db.query('delete from list_entries where list_key=$1', [key]);
    await this.loadUploaded(key);
    await this.setMeta(key, { record_count: 0, changed_at: new Date(), version: null, source_url: null });
    this.emit('changed', key);
  }

  // ---------------- country risk lists ----------------
  async seedCountryLists() {
    for (const s of COUNTRY_SEEDS) {
      const ins = await db.query('insert into country_lists(key,name,as_of,source) values($1,$2,$3,$4) on conflict (key) do nothing returning key', [s.key, s.name, s.as_of, s.source]);
      if (ins.rows.length) {
        for (const [iso2, note] of Object.entries(s.countries)) {
          await db.query('insert into country_risk(list_key,iso2,note) values($1,$2,$3) on conflict do nothing', [s.key, iso2, note]);
        }
      }
    }
  }

  async loadCountryRisk() {
    const lists = (await db.query('select * from country_lists order by key')).rows;
    const risk = (await db.query('select * from country_risk')).rows;
    this.country = new Map();
    for (const l of lists) this.country.set(l.key, { meta: l, countries: new Map() });
    for (const r of risk) {
      const c = this.country.get(r.list_key);
      if (c) c.countries.set(r.iso2, r.note || '');
    }
  }

  async updateCountryList(key, { countries, as_of, source }) {
    if (!this.country.has(key)) throw new Error('Unknown country list');
    await db.tx(async (c) => {
      await c.query('delete from country_risk where list_key=$1', [key]);
      for (const x of countries) await c.query('insert into country_risk(list_key,iso2,note) values($1,$2,$3) on conflict do nothing', [key, x.iso2, x.note || '']);
      await c.query('update country_lists set as_of=$2, source=$3, verified_by=null, verified_at=null where key=$1', [key, as_of || null, source || null]);
    });
    await this.loadCountryRisk();
    this.emit('changed', key);
  }

  async verifyCountryList(key, user) {
    await db.query('update country_lists set verified_by=$2, verified_at=now() where key=$1', [key, user.email]);
    await this.loadCountryRisk();
  }

  // ---------------- views ----------------
  getIndex(key) {
    const st = this.state.get(key);
    return st ? st.index : null;
  }

  sanctionStatus(def) {
    const st = this.state.get(def.key);
    const m = st.meta || {};
    let status = st.index ? 'ready' : m.status === 'error' ? 'error' : m.status === 'loading' ? 'loading' : 'empty';
    let stale = false;
    if (def.mode === 'feed' && st.index && m.fetched_at) {
      stale = Date.now() - new Date(m.fetched_at).getTime() > cfg.staleHours * 3600 * 1000;
    }
    if (!st.index && def.mode === 'feed' && status === 'empty') status = this.refreshing || !m.error ? 'loading' : 'error';
    return {
      key: def.key,
      name: def.name,
      category: def.category,
      kind: 'sanctions',
      mode: def.mode,
      required: def.required,
      status,
      stale,
      error: m.error || null,
      records: st.index ? st.index.entries.length : 0,
      version: m.version || null,
      published: m.published || null,
      fetchedAt: m.fetched_at || null,
      changedAt: m.changed_at || null,
      source: m.source_url || null,
      diagnostics: m.diagnostics || null,
    };
  }

  listStatus() {
    const out = SANCTION_LISTS.map((d) => this.sanctionStatus(d));
    for (const [key, c] of this.country) {
      out.push({
        key,
        name: c.meta.name,
        category: 'Country risk',
        kind: 'country',
        required: true,
        status: 'ready',
        records: c.countries.size,
        asOf: c.meta.as_of,
        source: c.meta.source,
        verifiedBy: c.meta.verified_by,
        verifiedAt: c.meta.verified_at,
      });
    }
    return out.concat(providers.statusList());
  }

  countryLists() {
    return [...this.country.entries()].map(([key, c]) => ({
      key,
      name: c.meta.name,
      asOf: c.meta.as_of,
      source: c.meta.source,
      verifiedBy: c.meta.verified_by,
      verifiedAt: c.meta.verified_at,
      countries: [...c.countries.entries()].map(([iso2, note]) => ({ iso2, name: countryName(iso2), note })).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }
}

module.exports = { ListManager, SANCTION_LISTS, COUNTRY_SEEDS };
