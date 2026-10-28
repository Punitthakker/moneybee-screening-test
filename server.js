'use strict';

const path = require('path');
const express = require('express');
const cfg = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { ListManager } = require('./lib/lists');
const monitor = require('./lib/monitor');
const buildRouter = require('./lib/routes');
const idcrypto = require('./lib/crypto');
const maintenance = require('./lib/maintenance');

idcrypto.install();

async function createApp(manager) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (cfg.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await db.query('select 1');
      const lists = manager.listStatus().filter((l) => l.kind === 'sanctions');
      res.json({ ok: true, lists: lists.map((l) => ({ key: l.key, status: l.status, records: l.records })) });
    } catch (e) {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api', express.json({ limit: '14mb' }));
  app.use('/api', buildRouter(manager));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[error]', req.method, req.path, err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });
  return app;
}

async function main() {
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 24) {
    if (cfg.production) throw new Error('SESSION_SECRET must be set to a random value of at least 24 characters.');
    cfg.sessionSecret = 'dev-only-secret-' + 'x'.repeat(16);
    console.warn('SESSION_SECRET not set, using an insecure development secret.');
  }
  db.init(cfg.databaseUrl, cfg.databaseSsl);
  await db.migrate();
  await auth.seedAdmin();
  await auth.applyAdminReset();
  await maintenance.sealExisting();
  const manager = new ListManager();
  await manager.init();
  await maintenance.seedUae(manager).catch((e) => console.error('[maintenance] seed failed:', e.message));
  monitor.attach(manager);
  const app = await createApp(manager);
  const server = app.listen(cfg.port, '0.0.0.0', () => console.log(`MoneyBee Screening listening on ${cfg.port}`));
  manager.startScheduler();
  maintenance.start();
  const stop = () => server.close(() => db.close().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { app, manager, server };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

module.exports = { createApp, main };
