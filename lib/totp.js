'use strict';
// Time-based one-time passwords (RFC 6238), compatible with Google Authenticator, Microsoft
// Authenticator, 1Password and similar apps.

const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function newSecret() {
  const b = crypto.randomBytes(20);
  let bits = '';
  for (const x of b) bits += x.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function code(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Accepts the current 30 second window and one either side to allow for clock drift.
function verify(secret, token, now = Date.now()) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const c = Math.floor(now / 30000);
  let ok = false;
  for (const d of [-1, 0, 1]) {
    const exp = Buffer.from(code(secret, c + d));
    if (crypto.timingSafeEqual(exp, Buffer.from(t))) ok = true;
  }
  return ok;
}

const uri = (secret, email) => `otpauth://totp/MoneyBee%20Screening:${encodeURIComponent(email)}?secret=${secret}&issuer=MoneyBee%20Screening&digits=6&period=30`;

module.exports = { newSecret, verify, uri, code };
