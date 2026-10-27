'use strict';
// Field-level protection for identity document numbers (AES-256-GCM) plus a keyed blind index
// so customers can still be found by ID number without storing it in the clear.

const crypto = require('crypto');
const pgTypes = require('pg').types;
const cfg = require('./config');

let encKey = null;
let idxKey = null;
const PREFIX = 'enc:v1:';

function setup() {
  const root = process.env.ID_ENC_KEY || cfg.sessionSecret;
  if (!root) throw new Error('ID_ENC_KEY (or SESSION_SECRET) must be set to protect ID numbers.');
  const master = crypto.scryptSync(root, 'moneybee-id-v1', 32);
  encKey = crypto.createHmac('sha256', master).update('encrypt').digest();
  idxKey = crypto.createHmac('sha256', master).update('index').digest();
  if (cfg.production && !process.env.ID_ENC_KEY) console.warn('ID_ENC_KEY is not set: ID numbers are protected with a key derived from SESSION_SECRET. Set a separate ID_ENC_KEY.');
}

function encrypt(text) {
  if (!encKey) setup();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  if (!encKey) setup();
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (e) {
    return '[unreadable: wrong key]';
  }
}

// Blind index of an ID number: same input always gives the same value, but it cannot be reversed.
function blind(idNumber) {
  if (!idxKey) setup();
  const flat = String(idNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return flat.length >= 5 ? crypto.createHmac('sha256', idxKey).update(flat).digest('hex') : null;
}

// Copies a JSON value, applying fn to the customer's own ID number fields.
function mapIds(value, fn, parent) {
  if (Array.isArray(value)) return value.map((v) => mapIds(v, fn, parent));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v && (k === 'idNumber' || (k === 'number' && parent === 'idMatch'))) out[k] = fn(v);
      else out[k] = mapIds(v, fn, k);
    }
    return out;
  }
  return value;
}

const seal = (obj) => mapIds(obj, (v) => (v.startsWith(PREFIX) ? v : encrypt(v)));
const open = (obj) => mapIds(obj, decrypt);

// All Postgres jsonb values are opened on the way out, so the rest of the application sees plain numbers.
function install() {
  pgTypes.setTypeParser(3802, (text) => {
    const v = JSON.parse(text);
    return text.includes(PREFIX) ? open(v) : v;
  });
}

function blindIndexes(subjects) {
  return [...new Set((subjects || []).map((s) => blind(s.idNumber)).filter(Boolean))];
}

module.exports = { encrypt, decrypt, blind, seal, open, install, blindIndexes, PREFIX };
