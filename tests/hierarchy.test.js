'use strict';

const assert = require('assert');
const hierarchy = require('../server/hierarchy');

const sid = 'TEST1A';
const a = 'inst-a';
const b = 'inst-b';
const c = 'inst-c';

hierarchy.register(a, 'Guitar', sid, 'default', { mode: 'TrackControl', duckGain: 0.4 });
hierarchy.register(b, 'Vocals', sid, 'default', { mode: 'TrackControl' });
hierarchy.register(c, 'Keys', sid, 'default', { mode: 'TrackControl' });
hierarchy.register('master-1', 'MASTER', sid, 'default', { mode: 'Streaming' });

let snap = hierarchy.snapshot(sid, 'default');
assert.strictEqual(snap.sessionId, sid);
assert.strictEqual(snap.tracks.length, 4);
assert.ok(snap.tracks.filter((t) => t.mode !== 'Streaming').every((t) => t.unducked === true));

const other = 'TEST2B';
hierarchy.register('inst-other', 'Other Mix', other, 'default', { mode: 'TrackControl' });
assert.strictEqual(hierarchy.snapshot(other, 'default').tracks.length, 1);
assert.strictEqual(hierarchy.listForSession(sid).length, 1);

const tog = hierarchy.toggle(sid, b, 'default');
assert.ok(tog.success);
snap = hierarchy.snapshot(sid, 'default');
assert.strictEqual(snap.tracks.find((t) => t.instanceId === b).unducked, false);
assert.strictEqual(snap.tracks.find((t) => t.instanceId === b).role, 'ducked');
assert.strictEqual(snap.tracks.find((t) => t.instanceId === a).unducked, true);
assert.strictEqual(hierarchy.snapshot(other, 'default').tracks.find((t) => t.instanceId === 'inst-other').unducked, true);

const masterTog = hierarchy.toggle(sid, 'master-1', 'default');
assert.strictEqual(masterTog.success, false);

const missing = hierarchy.toggle(sid, 'not-in-session', 'default');
assert.strictEqual(missing.success, false);

hierarchy.toggle(sid, b, 'default');
assert.strictEqual(hierarchy.snapshot(sid, 'default').tracks.find((t) => t.instanceId === b).unducked, true);

hierarchy.sync(sid, 'default', [
  { instanceId: a, trackName: 'Guitar' },
  { instanceId: b, trackName: 'Vocals' }
], 'master-1');
snap = hierarchy.snapshot(sid, 'default');
assert.strictEqual(snap.tracks.filter((t) => t.mode !== 'Streaming').length, 2);
assert.ok(!snap.tracks.find((t) => t.instanceId === c));

hierarchy.unregister(a);
hierarchy.unregister(b);
hierarchy.unregister(c);
hierarchy.unregister('master-1');
hierarchy.unregister('inst-other');

console.log('hierarchy.test.js OK');
