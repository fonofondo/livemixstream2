'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1,
  deactivated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  location_scope TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  location_scope TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  address TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  location_id TEXT REFERENCES locations(id),
  room_id TEXT REFERENCES rooms(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'plugin',
  status TEXT NOT NULL DEFAULT 'unregistered',
  public_code TEXT UNIQUE,
  credential_hash TEXT,
  plugin_version TEXT,
  os TEXT,
  capabilities_json TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS activation_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  concurrent_streams INTEGER NOT NULL,
  location_limit INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  concurrent_streams INTEGER NOT NULL,
  source TEXT NOT NULL,
  override_reason TEXT,
  override_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  room_id TEXT REFERENCES rooms(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  setup_min INTEGER NOT NULL DEFAULT 30,
  preflight_min INTEGER NOT NULL DEFAULT 20,
  teardown_min INTEGER NOT NULL DEFAULT 15,
  interval_weeks INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  template_id TEXT REFERENCES service_templates(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  room_id TEXT REFERENCES rooms(id),
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  setup_at INTEGER NOT NULL,
  teardown_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  cancelled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES service_events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  duty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  UNIQUE(event_id, user_id, duty)
);

CREATE TABLE IF NOT EXISTS stream_leases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT,
  session_id TEXT,
  endpoint_id TEXT,
  actor_user_id TEXT,
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  released_at INTEGER,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT,
  lease_id TEXT,
  endpoint_id TEXT,
  runtime_code TEXT NOT NULL,
  state TEXT NOT NULL,
  media_region TEXT DEFAULT 'local',
  audio_json TEXT,
  controlling_user_id TEXT,
  created_at INTEGER NOT NULL,
  live_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS preflight_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT,
  endpoint_id TEXT,
  actor_user_id TEXT,
  status TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  session_id TEXT,
  event_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_by TEXT,
  ack_at INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  session_id TEXT,
  event_id TEXT,
  author_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  result TEXT NOT NULL DEFAULT 'ok',
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT,
  session_id TEXT,
  event_id TEXT,
  location_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  end_reason TEXT,
  peak_listeners INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guest_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_summaries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  loudness_m REAL,
  true_peak REAL,
  silence_ms INTEGER,
  packet_loss REAL,
  jitter_ms REAL,
  rtt_ms REAL,
  listeners INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_events_org_start ON service_events(org_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_leases_org_state ON stream_leases(org_id, state);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON live_sessions(org_id, state);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assignments_event ON assignments(event_id);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function openDatabase(filePath) {
  const dir = path.dirname(filePath);
  if (filePath !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(filePath === ':memory:' ? ':memory:' : filePath);
  db.exec(SCHEMA);
  return db;
}

function seedIfEmpty(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM organizations').get();
  if (row.n > 0) return { seeded: false };

  const now = Date.now();
  const orgId = crypto.randomUUID();
  db.prepare(`INSERT INTO organizations (id, name, slug, timezone, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(orgId, 'Grace Network', 'grace-network', 'America/Chicago', now);

  db.prepare('INSERT INTO plans (id, name, concurrent_streams, location_limit) VALUES (?, ?, ?, ?)')
    .run('plan-starter', 'Starter', 1, 10);
  db.prepare('INSERT INTO plans (id, name, concurrent_streams, location_limit) VALUES (?, ?, ?, ?)')
    .run('plan-campus', 'Campus', 4, 40);

  db.prepare(`INSERT INTO subscriptions (id, org_id, plan_id, status, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), orgId, 'plan-starter', 'active', now);
  db.prepare(`INSERT INTO entitlements (org_id, concurrent_streams, source, updated_at)
    VALUES (?, ?, ?, ?)`).run(orgId, 1, 'subscription', now);

  const people = [
    ['owner', 'owner@demo.asaphix', 'Maya Chen', 'owner', 'demo-owner'],
    ['supervisor', 'supervisor@demo.asaphix', 'Jordan Hale', 'supervisor', 'demo-supervisor'],
    ['engineerPrimary', 'engineer1@demo.asaphix', 'Alex Rivera', 'engineer', 'demo-engineer'],
    ['engineerBackup', 'engineer2@demo.asaphix', 'Sam Okonkwo', 'engineer', 'demo-engineer'],
    ['volunteer', 'volunteer@demo.asaphix', 'Riley Nguyen', 'volunteer', 'demo-volunteer']
  ];
  const ids = {};
  for (const [key, email, name, role, password] of people) {
    const uid = crypto.randomUUID();
    ids[key] = uid;
    const { salt, hash } = hashPassword(password);
    db.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, email_verified, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`).run(uid, email, name, hash, salt, now);
    db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, location_scope, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`).run(crypto.randomUUID(), orgId, uid, role, now);
  }

  const north = crypto.randomUUID();
  const south = crypto.randomUUID();
  db.prepare(`INSERT INTO locations (id, org_id, name, timezone, address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(north, orgId, 'North Campus', 'America/Chicago', '1100 Oak St', now);
  db.prepare(`INSERT INTO locations (id, org_id, name, timezone, address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(south, orgId, 'South Campus', 'America/Chicago', '2400 Pine Ave', now);

  const northRoom = crypto.randomUUID();
  const southRoom = crypto.randomUUID();
  db.prepare(`INSERT INTO rooms (id, org_id, location_id, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(northRoom, orgId, north, 'Sanctuary', now);
  db.prepare(`INSERT INTO rooms (id, org_id, location_id, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(southRoom, orgId, south, 'Sanctuary', now);

  const northEp = crypto.randomUUID();
  const southEp = crypto.randomUUID();
  db.prepare(`INSERT INTO endpoints (id, org_id, location_id, room_id, name, type, status, public_code, created_at)
    VALUES (?, ?, ?, ?, ?, 'plugin', 'activated', ?, ?)`).run(northEp, orgId, north, northRoom, 'North Sanctuary Bridge', 'EP-NORTH', now);
  db.prepare(`INSERT INTO endpoints (id, org_id, location_id, room_id, name, type, status, public_code, created_at)
    VALUES (?, ?, ?, ?, ?, 'plugin', 'activated', ?, ?)`).run(southEp, orgId, south, southRoom, 'South Sanctuary Bridge', 'EP-SOUTH', now);

  const northTpl = crypto.randomUUID();
  const southTpl = crypto.randomUUID();
  db.prepare(`INSERT INTO service_templates
    (id, org_id, location_id, room_id, name, timezone, weekday, start_local, duration_min, setup_min, preflight_min, teardown_min, interval_weeks, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, '10:00', 75, 30, 20, 15, 1, 1, ?)`)
    .run(northTpl, orgId, north, northRoom, 'Sunday Morning', 'America/Chicago', now);
  db.prepare(`INSERT INTO service_templates
    (id, org_id, location_id, room_id, name, timezone, weekday, start_local, duration_min, setup_min, preflight_min, teardown_min, interval_weeks, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, '10:00', 75, 30, 20, 15, 1, 1, ?)`)
    .run(southTpl, orgId, south, southRoom, 'Sunday Morning', 'America/Chicago', now);

  db.prepare(`INSERT INTO meta (key, value) VALUES ('seeded', '1')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('org_id', ?)`).run(orgId);

  return {
    seeded: true,
    orgId,
    locations: { north, south },
    rooms: { northRoom, southRoom },
    templates: { northTpl, southTpl },
    users: ids,
    endpoints: { northEp, southEp }
  };
}

module.exports = {
  SCHEMA,
  openDatabase,
  seedIfEmpty,
  hashPassword,
  verifyPassword(password, salt, hash) {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(check, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
};
