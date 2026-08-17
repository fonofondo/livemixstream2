'use strict';

const assert = require('assert');
const sessions = require('../server/sessions');

const { session, response } = sessions.createSession({
  title: 'Unit Test Session',
  quality: 'High',
  sampleRate: 48000,
  channels: 2
});

assert.ok(response.success);
assert.ok(response.sessionId);
assert.ok(response.token);
assert.ok(response.listenerUrl.includes('/s/'));
assert.strictEqual(session.status, 'Offline');

const got = sessions.get(response.sessionId);
assert.ok(got);
assert.strictEqual(got.token, response.token);

const join = sessions.createSession({ sessionId: response.sessionId, joinOnly: true });
assert.ok(join.response.success);
assert.ok(join.joined);
assert.strictEqual(join.response.sessionId, response.sessionId);

const missing = sessions.createSession({ sessionId: 'ZZZZZZ', joinOnly: true });
assert.strictEqual(missing.response.success, false);

sessions.endStream(response.sessionId);
assert.strictEqual(sessions.get(response.sessionId).status, 'Ended');

console.log('sessions.test.js OK');
