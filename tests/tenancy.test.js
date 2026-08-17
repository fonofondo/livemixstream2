'use strict';

const assert = require('assert');
const { openDatabase, seedIfEmpty, hashPassword } = require('../server/db');
const { id } = require('../server/control/util');

const db = openDatabase(':memory:');
seedIfEmpty(db);

const now = Date.now();
const orgB = id();
db.prepare('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(orgB, 'Other Org', 'other-org', 'UTC', now);
db.prepare('INSERT INTO entitlements (org_id, concurrent_streams, source, updated_at) VALUES (?, 2, ?, ?)')
  .run(orgB, 'subscription', now);

const { salt, hash } = hashPassword('secret');
const userB = id();
db.prepare('INSERT INTO users (id, email, name, password_hash, password_salt, email_verified, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
  .run(userB, 'other@example.com', 'Other', hash, salt, now);
db.prepare('INSERT INTO memberships (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(id(), orgB, userB, 'owner', now);

const graceLoc = db.prepare("SELECT id, org_id FROM locations WHERE name = 'North Campus'").get();
const leaked = db.prepare('SELECT * FROM locations WHERE id = ? AND org_id = ?').get(graceLoc.id, orgB);
assert.strictEqual(leaked, undefined);

const graceEvents = db.prepare('SELECT COUNT(*) AS n FROM service_events WHERE org_id = ?').get(orgB);
assert.strictEqual(graceEvents.n, 0);

console.log('tenancy.test.js OK');
