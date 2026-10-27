'use strict';
// Ongoing monitoring: when any list changes, re-screen every customer flagged for monitoring.
// A new screening is saved only when the result differs from the previous one, so unchanged
// customers do not fill the history.

const db = require('./db');
const { audit } = require('./audit');
const { rescreenCustomer } = require('./screening');

let running = false;
let pending = false;
let debounce = null;

async function runMonitoring(manager, reason, user) {
  if (running) {
    pending = true;
    return { skipped: true };
  }
  running = true;
  const summary = { checked: 0, newScreenings: 0, newAlerts: 0, errors: 0, reason };
  try {
    const ids = (await db.query('select id from customers where monitor=true order by id')).rows.map((r) => r.id);
    for (const id of ids) {
      try {
        const r = await rescreenCustomer(manager, id, { user: null, trigger: 'monitoring', persist: 'if_changed' });
        summary.checked++;
        if (!r.unchanged) {
          summary.newScreenings++;
          const s = (await db.query('select alert from screenings where id=$1', [r.id])).rows[0];
          if (s && s.alert) summary.newAlerts++;
        }
      } catch (e) {
        summary.errors++;
        console.error('[monitor] customer', id, e.message);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await audit(user || null, 'monitoring.run', 'system', null, summary);
    console.log('[monitor]', JSON.stringify(summary));
  } finally {
    running = false;
    if (pending) {
      pending = false;
      schedule(manager, 'list changed during a run');
    }
  }
  return summary;
}

function schedule(manager, reason) {
  clearTimeout(debounce);
  debounce = setTimeout(() => runMonitoring(manager, reason).catch((e) => console.error('[monitor] failed:', e.message)), 20000);
  debounce.unref();
}

function attach(manager) {
  manager.on('changed', (key) => schedule(manager, `list updated: ${key}`));
}

module.exports = { attach, runMonitoring };
