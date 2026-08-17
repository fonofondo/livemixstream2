'use strict';

const { id, now, withImmediate } = require('./util');

const HEARTBEAT_MS = 20_000;
const LEASE_TTL_MS = 90_000;
const RECONNECT_GRACE_MS = 60_000;
const ACTIVE_STATES = ['requested', 'active', 'renewing', 'reconnecting'];

function expireStale(db, orgId, at = now()) {
  const rows = db.prepare(`
    SELECT id, session_id FROM stream_leases
    WHERE org_id = ? AND state IN ('requested','active','renewing','reconnecting') AND expires_at < ?
  `).all(orgId, at);
  for (const row of rows) {
    db.prepare(`UPDATE stream_leases SET state = 'expired', released_at = ?, end_reason = 'expired' WHERE id = ?`)
      .run(at, row.id);
    if (row.session_id) {
      db.prepare(`UPDATE live_sessions SET state = 'failed', ended_at = ? WHERE id = ? AND state NOT IN ('ended','failed','cancelled')`)
        .run(at, row.session_id);
    }
  }
  return rows.length;
}

function currentLimit(db, orgId, at = now()) {
  const ent = db.prepare('SELECT * FROM entitlements WHERE org_id = ?').get(orgId);
  if (!ent) return 0;
  if (ent.override_expires_at && ent.override_expires_at < at && ent.source === 'override') {
    return ent.concurrent_streams;
  }
  return ent.concurrent_streams;
}

function countActive(db, orgId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM stream_leases
    WHERE org_id = ? AND state IN ('requested','active','renewing','reconnecting')
  `).get(orgId);
  return row.n;
}

function acquire(db, {
  orgId,
  eventId = null,
  endpointId = null,
  actorUserId = null,
  sessionId = null,
  idempotencyKey,
  ttlMs = LEASE_TTL_MS
}) {
  if (!idempotencyKey) throw new Error('idempotencyKey required');
  const at = now();

  return withImmediate(db, () => {
    expireStale(db, orgId, at);

    const existing = db.prepare('SELECT * FROM stream_leases WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing && ACTIVE_STATES.includes(existing.state)) {
      db.prepare(`UPDATE stream_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?`)
        .run(at, at + ttlMs, existing.id);
      return { ok: true, duplicate: true, lease: db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(existing.id) };
    }
    if (existing && !ACTIVE_STATES.includes(existing.state)) {
      // Previous attempt finished; a new start needs a new key. Treat as fresh if released.
    }

    const sub = db.prepare(`SELECT status FROM subscriptions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId);
    if (sub && sub.status === 'cancelled') {
      return { ok: false, error: 'Subscription cancelled', code: 'subscription_inactive' };
    }

    const limit = currentLimit(db, orgId, at);
    const used = countActive(db, orgId);
    if (used >= limit) {
      return {
        ok: false,
        error: 'No stream channels available',
        code: 'capacity_exhausted',
        used,
        limit
      };
    }

    const leaseId = id();
    db.prepare(`INSERT INTO stream_leases
      (id, org_id, event_id, session_id, endpoint_id, actor_user_id, state, idempotency_key, acquired_at, expires_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(leaseId, orgId, eventId, sessionId, endpointId, actorUserId, idempotencyKey, at, at + ttlMs, at);

    return { ok: true, duplicate: false, lease: db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId), used: used + 1, limit };
  });
}

function heartbeat(db, leaseId, ttlMs = LEASE_TTL_MS) {
  const at = now();
  const lease = db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId);
  if (!lease || !ACTIVE_STATES.includes(lease.state)) return { ok: false, error: 'Lease not active' };
  db.prepare(`UPDATE stream_leases SET heartbeat_at = ?, expires_at = ?, state = 'active' WHERE id = ?`)
    .run(at, at + ttlMs, leaseId);
  return { ok: true, lease: db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId) };
}

function markReconnecting(db, leaseId, graceMs = RECONNECT_GRACE_MS) {
  const at = now();
  const lease = db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId);
  if (!lease || !ACTIVE_STATES.includes(lease.state)) return { ok: false, error: 'Lease not active' };
  db.prepare(`UPDATE stream_leases SET state = 'reconnecting', expires_at = ? WHERE id = ?`)
    .run(at + graceMs, leaseId);
  return { ok: true };
}

function release(db, leaseId, reason = 'stopped') {
  const at = now();
  return withImmediate(db, () => {
    const lease = db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId);
    if (!lease) return { ok: false, error: 'Not found' };
    if (!ACTIVE_STATES.includes(lease.state) && lease.state !== 'releasing') {
      return { ok: true, already: true, lease };
    }
    db.prepare(`UPDATE stream_leases SET state = 'released', released_at = ?, end_reason = ? WHERE id = ?`)
      .run(at, reason, leaseId);
    return { ok: true, lease: db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId) };
  });
}

function revoke(db, leaseId, reason = 'revoked') {
  const at = now();
  return withImmediate(db, () => {
    const lease = db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId);
    if (!lease) return { ok: false, error: 'Not found' };
    db.prepare(`UPDATE stream_leases SET state = 'revoked', released_at = ?, end_reason = ? WHERE id = ?`)
      .run(at, reason, leaseId);
    return { ok: true, lease: db.prepare('SELECT * FROM stream_leases WHERE id = ?').get(leaseId) };
  });
}

function snapshot(db, orgId) {
  expireStale(db, orgId);
  const limit = currentLimit(db, orgId);
  const used = countActive(db, orgId);
  const leases = db.prepare(`
    SELECT * FROM stream_leases WHERE org_id = ? AND state IN ('requested','active','renewing','reconnecting')
    ORDER BY acquired_at ASC
  `).all(orgId);
  return { limit, used, available: Math.max(0, limit - used), leases };
}

module.exports = {
  HEARTBEAT_MS,
  LEASE_TTL_MS,
  RECONNECT_GRACE_MS,
  ACTIVE_STATES,
  expireStale,
  currentLimit,
  countActive,
  acquire,
  heartbeat,
  markReconnecting,
  release,
  revoke,
  snapshot
};
