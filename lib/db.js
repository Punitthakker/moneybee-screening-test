'use strict';

const { Pool } = require('pg');

let pool = null;

const SCHEMA = `
create table if not exists users (
  id serial primary key,
  email text unique not null,
  name text not null,
  role text not null default 'analyst',
  password_hash text not null,
  active boolean not null default true,
  must_change boolean not null default false,
  created_at timestamptz not null default now(),
  last_login timestamptz
);
create table if not exists sessions (
  id text primary key,
  user_id int not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists customers (
  id serial primary key,
  ref text unique not null,
  type text not null,
  name text not null,
  subjects jsonb not null,
  monitor boolean not null default false,
  risk_status text not null default 'clear',
  created_by int references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_screened_at timestamptz
);
create table if not exists batches (
  id serial primary key,
  name text,
  total int not null default 0,
  done int not null default 0,
  alerts int not null default 0,
  status text not null default 'running',
  errors jsonb not null default '[]'::jsonb,
  created_by int references users(id),
  created_at timestamptz not null default now()
);
create table if not exists screenings (
  id serial primary key,
  customer_id int not null references customers(id) on delete cascade,
  trigger text not null default 'manual',
  batch_id int references batches(id),
  criteria jsonb not null,
  results jsonb not null,
  alert boolean not null default false,
  risk_flag boolean not null default false,
  incomplete boolean not null default false,
  hit_count int not null default 0,
  review_status text not null default 'none',
  outcome text,
  created_by int references users(id),
  created_at timestamptz not null default now()
);
create index if not exists screenings_customer_idx on screenings(customer_id, created_at desc);
create index if not exists screenings_review_idx on screenings(review_status, created_at desc);
create index if not exists screenings_batch_idx on screenings(batch_id);
create table if not exists dispositions (
  id serial primary key,
  screening_id int not null references screenings(id) on delete cascade,
  customer_id int not null references customers(id) on delete cascade,
  subject_key text not null,
  hit_key text not null,
  decision text not null,
  reason text not null,
  user_id int references users(id),
  created_at timestamptz not null default now(),
  unique (screening_id, subject_key, hit_key)
);
create index if not exists dispositions_customer_idx on dispositions(customer_id, subject_key, hit_key);
create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id int,
  user_email text,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb,
  ip text
);
create index if not exists audit_at_idx on audit_log(at desc);
create table if not exists lists (
  key text primary key,
  name text not null,
  status text not null default 'empty',
  error text,
  version text,
  record_count int not null default 0,
  source_url text,
  published text,
  hash text,
  fetched_at timestamptz,
  changed_at timestamptz,
  diagnostics jsonb
);
create table if not exists list_cache (
  key text primary key,
  hash text not null,
  data bytea not null,
  updated_at timestamptz not null default now()
);
create table if not exists list_entries (
  id bigserial primary key,
  list_key text not null,
  entry jsonb not null
);
create index if not exists list_entries_key_idx on list_entries(list_key);
create table if not exists country_lists (
  key text primary key,
  name text not null,
  as_of text,
  source text,
  verified_by text,
  verified_at timestamptz
);
create table if not exists country_risk (
  list_key text not null,
  iso2 text not null,
  note text,
  primary key (list_key, iso2)
);
create table if not exists settings (
  key text primary key,
  value jsonb not null
);
`;

function init(url, ssl) {
  if (!url) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false, max: 10 });
  pool.on('error', (e) => console.error('Database pool error:', e.message));
  return pool;
}

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(SCHEMA);
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

async function getSetting(key, fallback) {
  const r = await query('select value from settings where key=$1', [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}

async function setSetting(key, value) {
  await query('insert into settings(key,value) values($1,$2) on conflict (key) do update set value=excluded.value', [key, JSON.stringify(value)]);
}

module.exports = { init, query, tx, migrate, close, getSetting, setSetting };
