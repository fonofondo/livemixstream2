'use strict';

const crypto = require('crypto');

const ROLES = ['owner', 'administrator', 'supervisor', 'engineer', 'volunteer', 'viewer'];

const PERMS = {
  org_manage: ['owner'],
  billing: ['owner'],
  users_manage: ['owner', 'administrator'],
  locations_manage: ['owner', 'administrator'],
  schedules_manage: ['owner', 'administrator'],
  endpoints_manage: ['owner', 'administrator'],
  assign: ['owner', 'administrator', 'supervisor'],
  ops: ['owner', 'administrator', 'supervisor'],
  listen: ['owner', 'administrator', 'supervisor', 'engineer', 'viewer'],
  reassign: ['owner', 'administrator', 'supervisor'],
  takeover: ['owner', 'administrator', 'supervisor'],
  end_session: ['owner', 'administrator', 'supervisor'],
  mix_control: ['owner', 'administrator', 'supervisor', 'engineer'],
  preflight: ['owner', 'administrator', 'supervisor', 'engineer', 'volunteer'],
  volunteer_view: ['owner', 'administrator', 'supervisor', 'engineer', 'volunteer'],
  audit: ['owner', 'administrator', 'supervisor']
};

function id() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function now() {
  return Date.now();
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function hasPerm(role, perm) {
  return (PERMS[perm] || []).includes(role);
}

function scopedLocations(membership) {
  return parseJson(membership.location_scope, null);
}

function inScope(membership, locationId) {
  const scope = scopedLocations(membership);
  if (!scope || !scope.length) return true;
  if (!locationId) return true;
  return scope.includes(locationId);
}

function withImmediate(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function audit(db, { orgId, actorId, action, resourceType, resourceId, result = 'ok', details = null }) {
  db.prepare(`INSERT INTO audit_events
    (id, org_id, actor_user_id, action, resource_type, resource_id, result, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id(), orgId || null, actorId || null, action, resourceType || null, resourceId || null, result, details ? JSON.stringify(details) : null, now());
}

module.exports = {
  ROLES,
  PERMS,
  id,
  token,
  tokenHash,
  now,
  parseJson,
  hasPerm,
  inScope,
  scopedLocations,
  withImmediate,
  audit
};
