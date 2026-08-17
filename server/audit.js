'use strict';

const auditLog = [];
const MAX_ENTRIES = 500;

function record(admin, action, target, result = 'ok', details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    admin: admin || 'admin',
    action,
    target,
    result,
    details
  };
  auditLog.unshift(entry);
  if (auditLog.length > MAX_ENTRIES) auditLog.length = MAX_ENTRIES;
  return entry;
}

function list(limit = 100) {
  return auditLog.slice(0, limit);
}

module.exports = { record, list };
