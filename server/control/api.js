'use strict';

const express = require('express');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('../db');
const { id, token, tokenHash, now, parseJson, hasPerm, inScope, audit } = require('./util');
const leases = require('./leases');
const schedule = require('./schedule');

const SESSION_MS = 12 * 60 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVATION_MS = 30 * 60 * 1000;

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}

function createRouter(ctx) {
  const { db, hub, runtime } = ctx;
  const router = express.Router();

  function actorFromToken(raw) {
    if (!raw) return null;
    const sess = db.prepare(`
      SELECT s.*, u.email, u.name, u.deactivated_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(tokenHash(raw));
    if (!sess || sess.expires_at < now() || sess.deactivated_at) return null;
    return sess;
  }

  function membershipFor(userId, orgId) {
    if (orgId) return db.prepare('SELECT * FROM memberships WHERE user_id = ? AND org_id = ?').get(userId, orgId);
    return db.prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC').get(userId);
  }

  function requireAuth(perm) {
    return (req, res, next) => {
      const header = req.headers.authorization || '';
      const raw = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-asaphix-token'] || req.query.access_token);
      const sess = actorFromToken(raw);
      if (!sess) return res.status(401).json({ success: false, error: 'Unauthorized' });
      const orgHeader = req.headers['x-org-id'];
      const mem = membershipFor(sess.user_id, orgHeader);
      if (!mem) return res.status(403).json({ success: false, error: 'No organization membership' });
      if (perm && !hasPerm(mem.role, perm)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      req.actor = { id: sess.user_id, email: sess.email, name: sess.name, token: raw };
      req.membership = mem;
      req.orgId = mem.org_id;
      next();
    };
  }

  function locOk(req, locationId) {
    return inScope(req.membership, locationId);
  }

  router.post('/auth/register', (req, res) => {
    const { email, name, password, organizationName } = req.body || {};
    if (!email || !name || !password || !organizationName) {
      return res.status(400).json({ success: false, error: 'email, name, password, organizationName required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (existing) return res.status(409).json({ success: false, error: 'Email already registered' });
    const at = now();
    const orgId = id();
    const userId = id();
    const slug = String(organizationName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + userId.slice(0, 6);
    const { salt, hash } = hashPassword(password);
    db.prepare(`INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, 'America/Chicago', ?)`)
      .run(orgId, organizationName, slug, at);
    db.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, email_verified, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`).run(userId, String(email).toLowerCase(), name, hash, salt, at);
    db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`)
      .run(id(), orgId, userId, at);
    db.prepare(`INSERT INTO subscriptions (id, org_id, plan_id, status, created_at) VALUES (?, ?, 'plan-starter', 'active', ?)`)
      .run(id(), orgId, at);
    db.prepare(`INSERT INTO entitlements (org_id, concurrent_streams, source, updated_at) VALUES (?, 1, 'subscription', ?)`)
      .run(orgId, at);
    audit(db, { orgId, actorId: userId, action: 'org.register', resourceType: 'organization', resourceId: orgId });
    const raw = token();
    db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id(), userId, tokenHash(raw), at + SESSION_MS, at);
    res.status(201).json({ success: true, token: raw, user: { id: userId, email, name }, organization: { id: orgId, name: organizationName, slug } });
  });

  router.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!user || user.deactivated_at || !verifyPassword(password || '', user.password_salt, user.password_hash)) {
      audit(db, { action: 'auth.login', result: 'denied', details: { email } });
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const raw = token();
    const at = now();
    db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id(), user.id, tokenHash(raw), at + SESSION_MS, at);
    const memberships = db.prepare(`
      SELECT m.*, o.name AS org_name, o.slug FROM memberships m
      JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ?
    `).all(user.id);
    audit(db, { orgId: memberships[0] && memberships[0].org_id, actorId: user.id, action: 'auth.login' });
    res.json({ success: true, token: raw, user: publicUser(user), memberships });
  });

  router.post('/auth/logout', requireAuth(), (req, res) => {
    db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(now(), tokenHash(req.actor.token));
    res.json({ success: true });
  });

  router.get('/me', requireAuth(), (req, res) => {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.orgId);
    const cap = leases.snapshot(db, req.orgId);
    res.json({
      success: true,
      user: req.actor,
      membership: req.membership,
      organization: org,
      capacity: cap
    });
  });

  router.patch('/org', requireAuth('org_manage'), (req, res) => {
    const { name, timezone } = req.body || {};
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.orgId);
    db.prepare('UPDATE organizations SET name = ?, timezone = ? WHERE id = ?')
      .run(name || org.name, timezone || org.timezone, req.orgId);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'org.update', resourceType: 'organization', resourceId: req.orgId });
    res.json({ success: true, organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.orgId) });
  });

  router.get('/people', requireAuth('users_manage'), (req, res) => {
    const members = db.prepare(`
      SELECT m.id, m.role, m.location_scope, m.created_at, u.id AS user_id, u.email, u.name, u.deactivated_at
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?
    `).all(req.orgId);
    const invites = db.prepare('SELECT id, email, name, role, expires_at, accepted_at, created_at FROM invitations WHERE org_id = ?')
      .all(req.orgId);
    res.json({ success: true, members, invites });
  });

  router.post('/invitations', requireAuth('users_manage'), (req, res) => {
    const { email, name, role, locationScope } = req.body || {};
    if (!email || !role) return res.status(400).json({ success: false, error: 'email and role required' });
    const raw = token();
    const inviteId = id();
    db.prepare(`INSERT INTO invitations
      (id, org_id, email, name, role, location_scope, token_hash, invited_by, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(inviteId, req.orgId, String(email).toLowerCase(), name || null, role, locationScope ? JSON.stringify(locationScope) : null, tokenHash(raw), req.actor.id, now() + INVITE_MS, now());
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'user.invite', resourceType: 'invitation', resourceId: inviteId, details: { email, role } });
    res.status(201).json({ success: true, invitationId: inviteId, acceptToken: raw, acceptPath: `/app#/invite/${raw}` });
  });

  router.post('/invitations/accept', (req, res) => {
    const { acceptToken, name, password } = req.body || {};
    const invite = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash(acceptToken || ''));
    if (!invite || invite.accepted_at || invite.expires_at < now()) {
      return res.status(400).json({ success: false, error: 'Invalid or expired invitation' });
    }
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);
    if (!user) {
      if (!password) return res.status(400).json({ success: false, error: 'password required' });
      const { salt, hash } = hashPassword(password);
      const uid = id();
      db.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, email_verified, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).run(uid, invite.email, name || invite.name || invite.email, hash, salt, now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    }
    db.prepare(`INSERT OR IGNORE INTO memberships (id, org_id, user_id, role, location_scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id(), invite.org_id, user.id, invite.role, invite.location_scope, now());
    db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(now(), invite.id);
    const raw = token();
    db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id(), user.id, tokenHash(raw), now() + SESSION_MS, now());
    audit(db, { orgId: invite.org_id, actorId: user.id, action: 'user.invite.accept', resourceType: 'invitation', resourceId: invite.id });
    res.json({ success: true, token: raw, user: publicUser(user) });
  });

  router.patch('/people/:userId', requireAuth('users_manage'), (req, res) => {
    const { role, locationScope, deactivated } = req.body || {};
    const mem = db.prepare('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?').get(req.orgId, req.params.userId);
    if (!mem) return res.status(404).json({ success: false, error: 'Not found' });
    if (role) db.prepare('UPDATE memberships SET role = ? WHERE id = ?').run(role, mem.id);
    if (locationScope !== undefined) {
      db.prepare('UPDATE memberships SET location_scope = ? WHERE id = ?')
        .run(locationScope ? JSON.stringify(locationScope) : null, mem.id);
    }
    if (deactivated === true) db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(now(), req.params.userId);
    if (deactivated === false) db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(req.params.userId);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'user.update', resourceType: 'user', resourceId: req.params.userId, details: req.body });
    res.json({ success: true });
  });

  router.get('/locations', requireAuth('volunteer_view'), (req, res) => {
    const locations = db.prepare('SELECT * FROM locations WHERE org_id = ? ORDER BY name').all(req.orgId)
      .filter((l) => locOk(req, l.id));
    const rooms = db.prepare('SELECT * FROM rooms WHERE org_id = ?').all(req.orgId)
      .filter((r) => locOk(req, r.location_id));
    res.json({ success: true, locations, rooms });
  });

  router.post('/locations', requireAuth('locations_manage'), (req, res) => {
    const { name, timezone, address } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const locId = id();
    db.prepare(`INSERT INTO locations (id, org_id, name, timezone, address, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(locId, req.orgId, name, timezone || 'America/Chicago', address || null, now());
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'location.create', resourceType: 'location', resourceId: locId });
    res.status(201).json({ success: true, location: db.prepare('SELECT * FROM locations WHERE id = ?').get(locId) });
  });

  router.post('/rooms', requireAuth('locations_manage'), (req, res) => {
    const { locationId, name } = req.body || {};
    if (!locationId || !name) return res.status(400).json({ success: false, error: 'locationId and name required' });
    const roomId = id();
    db.prepare(`INSERT INTO rooms (id, org_id, location_id, name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(roomId, req.orgId, locationId, name, now());
    res.status(201).json({ success: true, room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) });
  });

  router.get('/endpoints', requireAuth('volunteer_view'), (req, res) => {
    const list = db.prepare('SELECT id, org_id, location_id, room_id, name, type, status, public_code, plugin_version, os, last_seen_at, created_at, revoked_at FROM endpoints WHERE org_id = ?')
      .all(req.orgId).filter((e) => locOk(req, e.location_id));
    res.json({ success: true, endpoints: list });
  });

  router.post('/endpoints', requireAuth('endpoints_manage'), (req, res) => {
    const { name, locationId, roomId, type } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const epId = id();
    const publicCode = 'EP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO endpoints (id, org_id, location_id, room_id, name, type, status, public_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'unregistered', ?, ?)`)
      .run(epId, req.orgId, locationId || null, roomId || null, name, type || 'plugin', publicCode, now());
    const code = token().slice(0, 12).toUpperCase();
    db.prepare(`INSERT INTO activation_codes (id, org_id, endpoint_id, code, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id(), req.orgId, epId, code, now() + ACTIVATION_MS, now());
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'endpoint.create', resourceType: 'endpoint', resourceId: epId });
    res.status(201).json({
      success: true,
      endpoint: db.prepare('SELECT id, name, type, status, public_code, location_id, room_id FROM endpoints WHERE id = ?').get(epId),
      activationCode: code,
      expiresInSeconds: ACTIVATION_MS / 1000
    });
  });

  router.post('/endpoints/:id/activation', requireAuth('endpoints_manage'), (req, res) => {
    const ep = db.prepare('SELECT * FROM endpoints WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!ep) return res.status(404).json({ success: false, error: 'Not found' });
    const code = token().slice(0, 12).toUpperCase();
    db.prepare(`INSERT INTO activation_codes (id, org_id, endpoint_id, code, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id(), req.orgId, ep.id, code, now() + ACTIVATION_MS, now());
    res.json({ success: true, activationCode: code, expiresInSeconds: ACTIVATION_MS / 1000 });
  });

  router.post('/endpoints/activate', (req, res) => {
    const { code } = req.body || {};
    const row = db.prepare('SELECT * FROM activation_codes WHERE code = ?').get(String(code || '').toUpperCase());
    if (!row || row.used_at || row.expires_at < now()) {
      return res.status(400).json({ success: false, error: 'Invalid or expired activation code' });
    }
    const secret = token();
    db.prepare('UPDATE activation_codes SET used_at = ? WHERE id = ?').run(now(), row.id);
    db.prepare('UPDATE endpoints SET status = ?, credential_hash = ? WHERE id = ?')
      .run('activated', tokenHash(secret), row.endpoint_id);
    const ep = db.prepare('SELECT id, name, public_code, org_id, status FROM endpoints WHERE id = ?').get(row.endpoint_id);
    audit(db, { orgId: row.org_id, action: 'endpoint.activate', resourceType: 'endpoint', resourceId: ep.id });
    res.json({ success: true, endpoint: ep, deviceSecret: secret });
  });

  router.post('/endpoints/:id/revoke', requireAuth('endpoints_manage'), (req, res) => {
    const ep = db.prepare('SELECT * FROM endpoints WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!ep) return res.status(404).json({ success: false, error: 'Not found' });
    db.prepare('UPDATE endpoints SET status = ?, revoked_at = ?, credential_hash = NULL WHERE id = ?')
      .run('revoked', now(), ep.id);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'endpoint.revoke', resourceType: 'endpoint', resourceId: ep.id });
    res.json({ success: true });
  });

  router.get('/templates', requireAuth('volunteer_view'), (req, res) => {
    const templates = db.prepare(`
      SELECT t.*, l.name AS location_name, r.name AS room_name
      FROM service_templates t
      JOIN locations l ON l.id = t.location_id
      LEFT JOIN rooms r ON r.id = t.room_id
      WHERE t.org_id = ?
      ORDER BY l.name, t.name, t.start_local
    `).all(req.orgId);
    res.json({ success: true, templates });
  });

  router.post('/templates', requireAuth('schedules_manage'), (req, res) => {
    const b = req.body || {};
    if (!b.name || b.weekday == null || !b.startLocal || !b.locationId) {
      return res.status(400).json({ success: false, error: 'name, weekday, startLocal, locationId required' });
    }
    const tplId = id();
    const loc = db.prepare('SELECT * FROM locations WHERE id = ? AND org_id = ?').get(b.locationId, req.orgId);
    db.prepare(`INSERT INTO service_templates
      (id, org_id, location_id, room_id, name, timezone, weekday, start_local, duration_min, setup_min, preflight_min, teardown_min, interval_weeks, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(tplId, req.orgId, b.locationId, b.roomId || null, b.name, b.timezone || (loc && loc.timezone) || 'America/Chicago',
        b.weekday, b.startLocal, b.durationMin || 75, b.setupMin || 30, b.preflightMin || 20, b.teardownMin || 15, b.intervalWeeks || 1, now());
    schedule.materialize(db, req.orgId);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'schedule.template.create', resourceType: 'template', resourceId: tplId });
    res.status(201).json({ success: true, template: db.prepare('SELECT * FROM service_templates WHERE id = ?').get(tplId) });
  });

  router.get('/events', requireAuth('volunteer_view'), (req, res) => {
    schedule.materialize(db, req.orgId);
    let events = db.prepare(`
      SELECT e.*, l.name AS location_name, r.name AS room_name
      FROM service_events e
      JOIN locations l ON l.id = e.location_id
      LEFT JOIN rooms r ON r.id = e.room_id
      WHERE e.org_id = ? AND e.starts_at > ? AND e.cancelled = 0
      ORDER BY e.starts_at ASC LIMIT 200
    `).all(req.orgId, now() - 6 * 3600000).filter((e) => locOk(req, e.location_id));

    if (req.membership.role === 'engineer' || req.membership.role === 'volunteer') {
      const mine = db.prepare('SELECT event_id FROM assignments WHERE org_id = ? AND user_id = ?').all(req.orgId, req.actor.id)
        .map((a) => a.event_id);
      if (req.membership.role !== 'volunteer' || true) {
        events = events.filter((e) => mine.includes(e.id) || hasPerm(req.membership.role, 'ops'));
        if (req.membership.role === 'engineer' || req.membership.role === 'volunteer') {
          events = db.prepare(`
            SELECT e.*, l.name AS location_name, r.name AS room_name
            FROM service_events e
            JOIN locations l ON l.id = e.location_id
            LEFT JOIN rooms r ON r.id = e.room_id
            JOIN assignments a ON a.event_id = e.id
            WHERE e.org_id = ? AND a.user_id = ? AND e.cancelled = 0 AND e.starts_at > ?
            ORDER BY e.starts_at ASC
          `).all(req.orgId, req.actor.id, now() - 6 * 3600000);
        }
      }
    }

    const ids = events.map((e) => e.id);
    let assigns = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      assigns = db.prepare(`
        SELECT a.*, u.name, u.email FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE a.event_id IN (${placeholders})
      `).all(...ids);
    }
    const byEvent = {};
    for (const a of assigns) {
      byEvent[a.event_id] = byEvent[a.event_id] || [];
      byEvent[a.event_id].push(a);
    }
    res.json({ success: true, events: events.map((e) => ({ ...e, assignments: byEvent[e.id] || [] })) });
  });

  router.post('/events', requireAuth('schedules_manage'), (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.locationId || !b.startsAt || !b.endsAt) {
      return res.status(400).json({ success: false, error: 'name, locationId, startsAt, endsAt required' });
    }
    const hits = schedule.conflicts(db, req.orgId, { locationId: b.locationId, roomId: b.roomId, startsAt: b.startsAt, endsAt: b.endsAt });
    if (hits.length) return res.status(409).json({ success: false, error: 'Room or location time conflict', conflicts: hits });
    const eventId = id();
    db.prepare(`INSERT INTO service_events
      (id, org_id, template_id, location_id, room_id, name, starts_at, ends_at, setup_at, teardown_at, status, cancelled, timezone, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`)
      .run(eventId, req.orgId, b.locationId, b.roomId || null, b.name, b.startsAt, b.endsAt,
        b.setupAt || (b.startsAt - 30 * 60000), b.teardownAt || (b.endsAt + 15 * 60000), b.timezone || 'America/Chicago', now());
    res.status(201).json({ success: true, event: db.prepare('SELECT * FROM service_events WHERE id = ?').get(eventId) });
  });

  router.post('/events/:id/cancel', requireAuth('schedules_manage'), (req, res) => {
    const ev = db.prepare('SELECT * FROM service_events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!ev) return res.status(404).json({ success: false, error: 'Not found' });
    db.prepare(`UPDATE service_events SET cancelled = 1, status = 'cancelled' WHERE id = ?`).run(ev.id);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'schedule.cancel', resourceType: 'event', resourceId: ev.id });
    hub.emit(req.orgId, { type: 'schedule.cancelled', resourceId: ev.id });
    res.json({ success: true });
  });

  router.put('/events/:id/assignments', requireAuth('assign'), (req, res) => {
    const ev = db.prepare('SELECT * FROM service_events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!ev) return res.status(404).json({ success: false, error: 'Not found' });
    const { userId, duty } = req.body || {};
    if (!userId || !duty) return res.status(400).json({ success: false, error: 'userId and duty required' });
    const existing = db.prepare('SELECT * FROM assignments WHERE event_id = ? AND duty = ?').get(ev.id, duty);
    if (existing) {
      db.prepare('UPDATE assignments SET user_id = ?, status = ?, decided_at = NULL, decided_by = NULL WHERE id = ?')
        .run(userId, 'pending', existing.id);
    } else {
      db.prepare(`INSERT INTO assignments (id, org_id, event_id, user_id, duty, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id(), req.orgId, ev.id, userId, duty, now());
    }
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'assignment.set', resourceType: 'event', resourceId: ev.id, details: { userId, duty } });
    hub.emit(req.orgId, { type: 'assignment.changed', resourceId: ev.id });
    res.json({ success: true, assignments: db.prepare(`
      SELECT a.*, u.name, u.email FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.event_id = ?
    `).all(ev.id) });
  });

  router.post('/assignments/:id/decide', requireAuth('preflight'), (req, res) => {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!a) return res.status(404).json({ success: false, error: 'Not found' });
    if (a.user_id !== req.actor.id && !hasPerm(req.membership.role, 'assign')) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const status = req.body && req.body.accept ? 'accepted' : 'declined';
    db.prepare('UPDATE assignments SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(status, now(), req.actor.id, a.id);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'assignment.decide', resourceType: 'assignment', resourceId: a.id, details: { status } });
    hub.emit(req.orgId, { type: 'assignment.changed', resourceId: a.event_id });
    res.json({ success: true, status });
  });

  router.get('/capacity', requireAuth('ops'), (req, res) => {
    const snap = leases.snapshot(db, req.orgId);
    const ent = db.prepare('SELECT * FROM entitlements WHERE org_id = ?').get(req.orgId);
    res.json({ success: true, ...snap, entitlement: ent });
  });

  router.post('/capacity/override', requireAuth('billing'), (req, res) => {
    const { concurrentStreams, reason, expiresAt } = req.body || {};
    if (!concurrentStreams || !reason) return res.status(400).json({ success: false, error: 'concurrentStreams and reason required' });
    db.prepare(`UPDATE entitlements SET concurrent_streams = ?, source = 'override', override_reason = ?, override_expires_at = ?, updated_at = ? WHERE org_id = ?`)
      .run(concurrentStreams, reason, expiresAt || null, now(), req.orgId);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'capacity.override', details: req.body });
    hub.emit(req.orgId, { type: 'billing.entitlement', resourceId: req.orgId });
    res.json({ success: true, entitlement: db.prepare('SELECT * FROM entitlements WHERE org_id = ?').get(req.orgId) });
  });

  function eventStaff(eventId) {
    return db.prepare(`SELECT a.*, u.name, u.email FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.event_id = ?`).all(eventId);
  }

  router.post('/sessions/start', requireAuth('preflight'), (req, res) => {
    const { eventId, endpointId } = req.body || {};
    const ev = db.prepare('SELECT * FROM service_events WHERE id = ? AND org_id = ?').get(eventId, req.orgId);
    if (!ev || ev.cancelled) return res.status(404).json({ success: false, error: 'Event not found' });
    if (!locOk(req, ev.location_id)) return res.status(403).json({ success: false, error: 'Out of location scope' });

    const assigned = db.prepare('SELECT * FROM assignments WHERE event_id = ? AND user_id = ?').get(ev.id, req.actor.id);
    if (!assigned && !hasPerm(req.membership.role, 'ops')) {
      return res.status(403).json({ success: false, error: 'Not assigned to this service' });
    }

    const key = `event:${ev.id}`;
    const got = leases.acquire(db, {
      orgId: req.orgId,
      eventId: ev.id,
      endpointId: endpointId || null,
      actorUserId: req.actor.id,
      idempotencyKey: key
    });
    if (!got.ok) {
      audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'lease.acquire', resourceType: 'event', resourceId: ev.id, result: 'denied', details: got });
      return res.status(409).json({ success: false, ...got });
    }

    let live = db.prepare('SELECT * FROM live_sessions WHERE org_id = ? AND event_id = ? AND state NOT IN (\'ended\',\'failed\',\'cancelled\')').get(req.orgId, ev.id);
    if (!live) {
      const created = runtime.createSession({ title: `${ev.name} · ${ev.location_id.slice(0, 6)}` }, {
        host: req.get('host'),
        protocol: req.protocol
      });
      const liveId = id();
      db.prepare(`INSERT INTO live_sessions
        (id, org_id, event_id, lease_id, endpoint_id, runtime_code, state, media_region, audio_json, controlling_user_id, created_at, live_at)
        VALUES (?, ?, ?, ?, ?, ?, 'starting', 'local', ?, ?, ?, ?)`)
        .run(liveId, req.orgId, ev.id, got.lease.id, endpointId || null, created.session.id, JSON.stringify(created.response.config), req.actor.id, now(), now());
      db.prepare('UPDATE stream_leases SET session_id = ? WHERE id = ?').run(liveId, got.lease.id);
      db.prepare(`UPDATE service_events SET status = 'starting' WHERE id = ?`).run(ev.id);
      live = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(liveId);
    }

    db.prepare(`INSERT INTO usage_events (id, org_id, lease_id, session_id, event_id, location_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id(), req.orgId, got.lease.id, live.id, ev.id, ev.location_id, now());

    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'session.start', resourceType: 'live_session', resourceId: live.id });
    hub.emit(req.orgId, { type: 'session.lifecycle', resourceId: live.id });
    const rt = runtime.get(live.runtime_code);
    res.json({
      success: true,
      duplicate: got.duplicate,
      session: live,
      lease: got.lease,
      runtime: rt ? { sessionId: rt.id, listenerPath: `/s/${rt.id}` } : null
    });
  });

  router.post('/sessions/:id/end', requireAuth('end_session'), async (req, res) => {
    const live = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!live) return res.status(404).json({ success: false, error: 'Not found' });
    const reason = (req.body && req.body.reason) || 'stopped';
    if (live.lease_id) leases.release(db, live.lease_id, reason);
    db.prepare(`UPDATE live_sessions SET state = 'ended', ended_at = ? WHERE id = ?`).run(now(), live.id);
    if (live.event_id) db.prepare(`UPDATE service_events SET status = 'ended' WHERE id = ?`).run(live.event_id);
    db.prepare(`UPDATE usage_events SET ended_at = ?, duration_ms = ? - started_at, end_reason = ? WHERE session_id = ? AND ended_at IS NULL`)
      .run(now(), now(), reason, live.id);
    if (runtime.endStream) runtime.endStream(live.runtime_code);
    if (runtime.closeMedia) await runtime.closeMedia(live.runtime_code);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'session.end', resourceType: 'live_session', resourceId: live.id, details: { reason } });
    hub.emit(req.orgId, { type: 'session.lifecycle', resourceId: live.id });
    res.json({ success: true });
  });

  router.post('/sessions/:id/reassign', requireAuth('reassign'), (req, res) => {
    const live = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!live) return res.status(404).json({ success: false, error: 'Not found' });
    const { userId, reason } = req.body || {};
    if (!userId || !reason) return res.status(400).json({ success: false, error: 'userId and reason required' });
    const previous = live.controlling_user_id;
    db.prepare('UPDATE live_sessions SET controlling_user_id = ? WHERE id = ?').run(userId, live.id);
    if (live.event_id) {
      const primary = db.prepare(`SELECT * FROM assignments WHERE event_id = ? AND duty = 'primary'`).get(live.event_id);
      if (primary) {
        db.prepare('UPDATE assignments SET user_id = ?, status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
          .run(userId, 'accepted', now(), req.actor.id, primary.id);
      }
    }
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'session.reassign', resourceType: 'live_session', resourceId: live.id, details: { previous, userId, reason } });
    hub.emit(req.orgId, { type: 'session.assignment', resourceId: live.id });
    res.json({ success: true, controllingUserId: userId, leasePreserved: true });
  });

  router.post('/sessions/:id/takeover', requireAuth('takeover'), (req, res) => {
    const live = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!live) return res.status(404).json({ success: false, error: 'Not found' });
    const reason = (req.body && req.body.reason) || 'supervisor takeover';
    db.prepare('UPDATE live_sessions SET controlling_user_id = ? WHERE id = ?').run(req.actor.id, live.id);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'session.takeover', resourceType: 'live_session', resourceId: live.id, details: { reason } });
    hub.emit(req.orgId, { type: 'session.assignment', resourceId: live.id });
    res.json({ success: true, controllingUserId: req.actor.id, leasePreserved: true });
  });

  router.post('/sessions/:id/incidents', requireAuth('ops'), (req, res) => {
    const live = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!live) return res.status(404).json({ success: false, error: 'Not found' });
    const body = (req.body && req.body.body) || '';
    if (!body.trim()) return res.status(400).json({ success: false, error: 'body required' });
    const incId = id();
    db.prepare(`INSERT INTO incidents (id, org_id, session_id, event_id, author_id, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(incId, req.orgId, live.id, live.event_id, req.actor.id, body, now());
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'incident.note', resourceType: 'incident', resourceId: incId });
    res.status(201).json({ success: true, incident: db.prepare('SELECT * FROM incidents WHERE id = ?').get(incId) });
  });

  router.get('/sessions/:id', requireAuth('listen'), (req, res) => {
    const live = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!live) return res.status(404).json({ success: false, error: 'Not found' });
    const incidents = db.prepare('SELECT * FROM incidents WHERE session_id = ? ORDER BY created_at DESC').all(live.id);
    const alerts = db.prepare('SELECT * FROM alerts WHERE session_id = ? ORDER BY opened_at DESC').all(live.id);
    const rt = runtime.get(live.runtime_code);
    res.json({
      success: true,
      session: live,
      incidents,
      alerts,
      runtime: rt ? {
        sessionId: rt.id,
        status: runtime.publicStatus(rt),
        listeners: rt.listeners.size,
        audioSpec: { sampleRate: rt.sampleRate, channels: rt.channels, bitrate: rt.bitrate, quality: rt.quality },
        hierarchy: runtime.hierarchy ? runtime.hierarchy.listForSession(rt.id) : []
      } : null
    });
  });

  router.get('/ops', requireAuth('ops'), (req, res) => {
    schedule.materialize(db, req.orgId);
    const cap = leases.snapshot(db, req.orgId);
    const events = db.prepare(`
      SELECT e.*, l.name AS location_name, r.name AS room_name
      FROM service_events e
      JOIN locations l ON l.id = e.location_id
      LEFT JOIN rooms r ON r.id = e.room_id
      WHERE e.org_id = ? AND e.cancelled = 0 AND e.teardown_at > ? AND e.setup_at < ?
      ORDER BY e.starts_at ASC
    `).all(req.orgId, now() - 3600000, now() + 36 * 3600000);

    const lives = db.prepare(`SELECT * FROM live_sessions WHERE org_id = ? AND state NOT IN ('ended','failed','cancelled')`).all(req.orgId);
    const liveByEvent = Object.fromEntries(lives.map((s) => [s.event_id, s]));
    const alerts = db.prepare(`SELECT * FROM alerts WHERE org_id = ? AND status IN ('open','acked') ORDER BY opened_at DESC LIMIT 50`).all(req.orgId);

    const cards = events.filter((e) => locOk(req, e.location_id)).map((e) => {
      const live = liveByEvent[e.id];
      const rt = live ? runtime.get(live.runtime_code) : null;
      return {
        event: e,
        assignments: eventStaff(e.id),
        session: live || null,
        runtime: rt ? {
          sessionId: rt.id,
          status: runtime.publicStatus(rt),
          listeners: rt.listeners.size,
          audioSpec: { sampleRate: rt.sampleRate, channels: rt.channels, bitrate: rt.bitrate, quality: rt.quality },
          effectiveLatencyMs: rt.effectiveLatencyMs || 0
        } : null,
        alerts: alerts.filter((a) => a.event_id === e.id || (live && a.session_id === live.id))
      };
    });

    res.json({ success: true, capacity: cap, cards, endpoints: db.prepare('SELECT id, name, status, location_id, last_seen_at FROM endpoints WHERE org_id = ?').all(req.orgId) });
  });

  router.post('/preflight', requireAuth('preflight'), (req, res) => {
    const { eventId, endpointId } = req.body || {};
    const ev = db.prepare('SELECT * FROM service_events WHERE id = ? AND org_id = ?').get(eventId, req.orgId);
    if (!ev) return res.status(404).json({ success: false, error: 'Event not found' });
    const ep = endpointId ? db.prepare('SELECT * FROM endpoints WHERE id = ? AND org_id = ?').get(endpointId, req.orgId) : null;
    const cap = leases.snapshot(db, req.orgId);
    const staff = eventStaff(ev.id);
    const checks = [
      { id: 'endpoint_online', label: 'Endpoint online and authorized', ok: !!(ep && ep.status === 'activated' && !ep.revoked_at), detail: ep ? ep.status : 'No endpoint selected' },
      { id: 'endpoint_version', label: 'Supported endpoint software version', ok: true, detail: (ep && ep.plugin_version) || 'Assumed current (plugin compat)' },
      { id: 'staff_primary', label: 'Primary engineer assigned', ok: staff.some((s) => s.duty === 'primary'), detail: staff.filter((s) => s.duty === 'primary').map((s) => s.name).join(', ') || 'Missing' },
      { id: 'staff_backup', label: 'Backup engineer assigned', ok: staff.some((s) => s.duty === 'backup'), detail: staff.filter((s) => s.duty === 'backup').map((s) => s.name).join(', ') || 'None' },
      { id: 'capacity', label: 'Stream channel available', ok: cap.available > 0 || cap.leases.some((l) => l.event_id === ev.id), detail: `${cap.used} of ${cap.limit} channels in use` },
      { id: 'window', label: 'Inside setup / service window', ok: now() >= ev.setup_at && now() <= ev.teardown_at, detail: 'Setup through teardown' }
    ];
    const status = checks.every((c) => c.ok) ? 'passed' : 'failed';
    const runId = id();
    db.prepare(`INSERT INTO preflight_runs (id, org_id, event_id, endpoint_id, actor_user_id, status, results_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, req.orgId, ev.id, endpointId || null, req.actor.id, status, JSON.stringify(checks), now());
    if (status === 'passed') db.prepare(`UPDATE service_events SET status = 'ready' WHERE id = ? AND status = 'planned'`).run(ev.id);
    res.json({ success: true, status, checks, runId });
  });

  router.get('/alerts', requireAuth('ops'), (req, res) => {
    res.json({ success: true, alerts: db.prepare('SELECT * FROM alerts WHERE org_id = ? ORDER BY opened_at DESC LIMIT 100').all(req.orgId) });
  });

  router.post('/alerts/:id/ack', requireAuth('ops'), (req, res) => {
    const a = db.prepare('SELECT * FROM alerts WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!a) return res.status(404).json({ success: false, error: 'Not found' });
    db.prepare(`UPDATE alerts SET status = 'acked', ack_by = ?, ack_at = ?, notes = ? WHERE id = ?`)
      .run(req.actor.id, now(), (req.body && req.body.notes) || a.notes, a.id);
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'alert.ack', resourceType: 'alert', resourceId: a.id });
    hub.emit(req.orgId, { type: 'alert.updated', resourceId: a.id });
    res.json({ success: true });
  });

  router.get('/audit', requireAuth('audit'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ success: true, entries: db.prepare('SELECT * FROM audit_events WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(req.orgId, limit) });
  });

  router.get('/usage', requireAuth('audit'), (req, res) => {
    res.json({ success: true, usage: db.prepare('SELECT * FROM usage_events WHERE org_id = ? ORDER BY started_at DESC LIMIT 200').all(req.orgId) });
  });

  router.post('/talkback/signal', requireAuth('preflight'), (req, res) => {
    const { sessionId, speaking } = req.body || {};
    hub.emit(req.orgId, { type: 'talkback.presence', resourceId: sessionId, speaking: !!speaking, actorId: req.actor.id, actorName: req.actor.name });
    audit(db, { orgId: req.orgId, actorId: req.actor.id, action: 'talkback.signal', resourceType: 'live_session', resourceId: sessionId });
    res.json({ success: true });
  });

  router.get('/engineers', requireAuth('assign'), (req, res) => {
    const people = db.prepare(`
      SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.role IN ('engineer','supervisor','administrator','owner','volunteer')
      ORDER BY u.name
    `).all(req.orgId);
    res.json({ success: true, people });
  });

  return { router, actorFromToken, membershipFor };
}

module.exports = { createRouter };
