'use strict';
// Restore a MoneyBee backup into the database named by DATABASE_URL.
// Usage: DATABASE_URL=postgres://... ID_ENC_KEY=... node scripts/restore.js <backup.json> --confirm
// WARNING: with --confirm this REPLACES all current data. Set the same ID_ENC_KEY as the source,
// or encrypted ID numbers will be unreadable.

const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const db = require('../lib/db');
const idcrypto = require('../lib/crypto');
const { restoreBackup } = require('../lib/backup');

(async () => {
  const file = process.argv[2];
  const confirmed = process.argv.includes('--confirm');
  if (!file) {
    console.error('Usage: node scripts/restore.js <backup.json> --confirm');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const counts = (data.meta && data.meta.counts) || {};
  console.log('Backup from', data.meta && data.meta.created_at, '-', JSON.stringify(counts));
  if (!confirmed) {
    console.error('\nThis will REPLACE all current data. Re-run with --confirm to proceed.');
    process.exit(1);
  }
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  idcrypto.install();
  db.init(cfg.databaseUrl, cfg.databaseSsl);
  await db.migrate();
  const summary = await restoreBackup(data, { wipe: true });
  console.log('Restored:', JSON.stringify(summary));
  await db.close();
  console.log('Done.');
})().catch((e) => {
  console.error('Restore failed:', e.message);
  process.exit(1);
});
