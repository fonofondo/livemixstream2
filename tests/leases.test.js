'use strict';

const assert = require('assert');
const { openDatabase, seedIfEmpty } = require('../server/db');
const leases = require('../server/control/leases');

const db = openDatabase(':memory:');
const seed = seedIfEmpty(db);
assert.ok(seed.seeded);
const orgId = seed.orgId;

const first = leases.acquire(db, { orgId, eventId: 'evt-a', idempotencyKey: 'event:evt-a' });
assert.ok(first.ok, first.error);
assert.strictEqual(first.duplicate, false);

const retry = leases.acquire(db, { orgId, eventId: 'evt-a', idempotencyKey: 'event:evt-a' });
assert.ok(retry.ok);
assert.strictEqual(retry.duplicate, true);
assert.strictEqual(retry.lease.id, first.lease.id);

const second = leases.acquire(db, { orgId, eventId: 'evt-b', idempotencyKey: 'event:evt-b' });
assert.strictEqual(second.ok, false);
assert.strictEqual(second.code, 'capacity_exhausted');

leases.release(db, first.lease.id, 'stopped');
const after = leases.acquire(db, { orgId, eventId: 'evt-b', idempotencyKey: 'event:evt-b' });
assert.ok(after.ok, after.error);
assert.strictEqual(after.duplicate, false);

const snap = leases.snapshot(db, orgId);
assert.strictEqual(snap.limit, 1);
assert.strictEqual(snap.used, 1);

console.log('leases.test.js OK');
