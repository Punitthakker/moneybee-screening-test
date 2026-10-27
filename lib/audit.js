'use strict';

const db = require('./db');

// Records who did what. Never throws, an audit failure must not break the action itself.
async function audit(user, action, entity, entityId, detail, ip) {
  try {
    await db.query(
      'insert into audit_log(user_id,user_email,action,entity,entity_id,detail,ip) values($1,$2,$3,$4,$5,$6,$7)',
      [user ? user.id : null, user ? user.email : null, action, entity || null, entityId == null ? null : String(entityId), detail ? JSON.stringify(detail) : null, ip || null]
    );
  } catch (e) {
    console.error('Audit write failed:', e.message);
  }
}

function reqIp(req) {
  return req && (req.ip || (req.socket && req.socket.remoteAddress)) ? String(req.ip || req.socket.remoteAddress) : null;
}

module.exports = { audit, reqIp };
