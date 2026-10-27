'use strict';
// Alert notifications by Slack-compatible webhook and, when SMTP is configured, email.
// Messages carry the customer reference and counts only. They never include ID numbers.

const dns = require('dns').promises;
const net = require('net');
const db = require('./db');

const DEFAULTS = { enabled: false, webhookUrl: '', emailTo: '', events: { alert: true, confirmed: true, listChange: true, reviewDue: true } };

async function getConfig() {
  const s = (await db.getSetting('notifications', null)) || {};
  return { ...DEFAULTS, ...s, events: { ...DEFAULTS.events, ...(s.events || {}) } };
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

// Only public https addresses are allowed, so a webhook cannot be pointed at internal services.
async function checkWebhook(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new Error('That is not a valid web address.');
  }
  if (process.env.ALLOW_INSECURE_WEBHOOK === 'true' && u.protocol === 'http:') return u;
  if (u.protocol !== 'https:') throw new Error('The webhook address must start with https://');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error('The webhook address must be a public internet address.');
  return u;
}

async function sendWebhook(url, text) {
  const u = await checkWebhook(url);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!res.ok) throw new Error('The webhook answered with status ' + res.status);
}

async function sendEmail(to, subject, text) {
  if (!process.env.SMTP_URL) throw new Error('Email is not set up on the server (SMTP_URL is missing).');
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport(process.env.SMTP_URL);
  await t.sendMail({ from: process.env.MAIL_FROM || 'MoneyBee Screening <no-reply@moneybee.local>', to, subject, text });
}

const sent = [];
async function notify(event, subject, text) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.events[event]) return { skipped: true };
    const out = {};
    if (cfg.webhookUrl) {
      try {
        await sendWebhook(cfg.webhookUrl, `${subject}\n${text}`);
        out.webhook = 'sent';
      } catch (e) {
        out.webhook = 'failed: ' + e.message;
        console.error('[notify] webhook failed:', e.message);
      }
    }
    if (cfg.emailTo && process.env.SMTP_URL) {
      try {
        await sendEmail(cfg.emailTo, subject, text);
        out.email = 'sent';
      } catch (e) {
        out.email = 'failed: ' + e.message;
        console.error('[notify] email failed:', e.message);
      }
    }
    sent.push({ at: new Date().toISOString(), event, subject, out });
    if (sent.length > 20) sent.shift();
    return out;
  } catch (e) {
    console.error('[notify] failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { getConfig, notify, sendWebhook, sendEmail, checkWebhook, recent: () => sent.slice().reverse(), emailReady: () => !!process.env.SMTP_URL };
