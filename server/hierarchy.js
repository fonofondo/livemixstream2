'use strict';

const plugins = require('./plugins');

/**
 * Hierarchy is scoped to a session.
 * Track Control members are independent switches: unducked (full) or ducked
 * (to the gain set on that plugin). The Streaming plugin is registered but
 * is not a switch.
 */
const groups = new Map();

function keyOf(sessionId, groupId = 'default') {
  return `${String(sessionId || '').toUpperCase()}::${groupId || 'default'}`;
}

function ensureGroup(sessionId, groupId = 'default') {
  const sid = String(sessionId || '').toUpperCase();
  const gid = groupId || 'default';
  const key = keyOf(sid, gid);
  if (!groups.has(key)) {
    groups.set(key, {
      sessionId: sid,
      groupId: gid,
      unducked: new Map(),
      members: new Set()
    });
  }
  return groups.get(key);
}

function isStreaming(instanceId) {
  const inst = plugins.get(instanceId);
  return inst && (inst.mode === 'Streaming' || inst.mode === 'streaming');
}

function register(instanceId, trackName, sessionId, groupId = 'default', meta = {}) {
  const sid = String(sessionId || '').toUpperCase();
  if (!sid) return { success: false, error: 'sessionId required' };

  for (const [k, g] of groups.entries()) {
    if (g.members.has(instanceId) && (g.sessionId !== sid || g.groupId !== (groupId || 'default'))) {
      g.members.delete(instanceId);
      g.unducked.delete(instanceId);
      if (g.members.size === 0) groups.delete(k);
    }
  }

  const group = ensureGroup(sid, groupId);
  group.members.add(instanceId);
  if (!group.unducked.has(instanceId)) {
    group.unducked.set(instanceId, true);
  }

  const duckGain = typeof meta.duckGain === 'number' ? meta.duckGain : undefined;
  const fadeDurationMs = typeof meta.fadeDurationMs === 'number' ? meta.fadeDurationMs : undefined;

  plugins.upsert(instanceId, {
    trackName: trackName || 'Track',
    groupId: group.groupId,
    sessionId: sid,
    status: 'Connected',
    mode: meta.mode || 'TrackControl',
    role: roleFor(instanceId, group),
    ...(duckGain != null ? { duckGain } : {}),
    ...(fadeDurationMs != null ? { fadeDurationMs } : {})
  });

  return snapshot(sid, group.groupId);
}

function unregister(instanceId) {
  for (const [k, g] of groups.entries()) {
    if (g.members.has(instanceId)) {
      g.members.delete(instanceId);
      g.unducked.delete(instanceId);
      if (g.members.size === 0) groups.delete(k);
    }
  }
  plugins.remove(instanceId);
}

function isUnducked(group, instanceId) {
  if (!group.unducked.has(instanceId)) return true;
  return group.unducked.get(instanceId) !== false;
}

function roleFor(instanceId, group) {
  if (isStreaming(instanceId)) return 'idle';
  return isUnducked(group, instanceId) ? 'unducked' : 'ducked';
}

function toggle(sessionId, instanceId, groupId = 'default') {
  const sid = String(sessionId || '').toUpperCase();
  if (!sid) return { success: false, error: 'sessionId required' };
  if (!instanceId) return { success: false, error: 'instanceId required' };
  const group = ensureGroup(sid, groupId);
  if (!group.members.has(instanceId)) {
    return { success: false, error: 'Instance not in this session' };
  }
  if (isStreaming(instanceId)) {
    return { success: false, error: 'Streaming plugin is not a track switch' };
  }
  group.unducked.set(instanceId, !isUnducked(group, instanceId));
  refreshRoles(group);
  return { success: true, state: snapshot(sid, group.groupId) };
}

function setUnducked(sessionId, instanceId, unducked, groupId = 'default') {
  const sid = String(sessionId || '').toUpperCase();
  if (!sid) return { success: false, error: 'sessionId required' };
  if (!instanceId) return { success: false, error: 'instanceId required' };
  const group = ensureGroup(sid, groupId);
  if (!group.members.has(instanceId)) {
    const inst = plugins.get(instanceId);
    if (!inst || isStreaming(instanceId)) {
      return { success: false, error: 'Instance not in this session' };
    }
    group.members.add(instanceId);
    if (!group.unducked.has(instanceId)) {
      group.unducked.set(instanceId, true);
    }
  }
  if (isStreaming(instanceId)) {
    return { success: false, error: 'Streaming plugin is not a track switch' };
  }
  group.unducked.set(instanceId, !!unducked);
  refreshRoles(group);
  return { success: true, state: snapshot(sid, group.groupId) };
}

function refreshRoles(group) {
  for (const id of group.members) {
    plugins.upsert(id, {
      role: roleFor(id, group),
      groupId: group.groupId,
      sessionId: group.sessionId
    });
  }
}

function snapshot(sessionId, groupId = 'default') {
  const sid = String(sessionId || '').toUpperCase();
  const group = ensureGroup(sid, groupId);
  const tracks = [];
  const seen = new Set();
  for (const id of group.members) {
    if (seen.has(id)) continue;
    seen.add(id);
    const inst = plugins.get(id);
    if (!inst) continue;
    const mode = inst.mode || 'TrackControl';
    tracks.push({
      instanceId: id,
      trackName: inst.trackName || 'Track',
      mode,
      role: roleFor(id, group),
      unducked: isStreaming(id) ? true : isUnducked(group, id),
      duckGain: typeof inst.duckGain === 'number' ? inst.duckGain : 0.3,
      fadeDurationMs: typeof inst.fadeDurationMs === 'number' ? inst.fadeDurationMs : 200
    });
  }
  return {
    type: 'HIERARCHY_STATE',
    sessionId: sid,
    groupId: group.groupId,
    tracks
  };
}

function sync(sessionId, groupId, tracks = [], masterId = null) {
  const sid = String(sessionId || '').toUpperCase();
  if (!sid) return { success: false, error: 'sessionId required' };
  const gid = groupId || 'default';
  const group = ensureGroup(sid, gid);
  const keep = new Set();
  if (masterId) keep.add(masterId);

  for (const t of tracks) {
    if (!t || !t.instanceId) continue;
    keep.add(t.instanceId);
    register(t.instanceId, t.trackName, sid, gid, {
      mode: t.mode || 'TrackControl',
      duckGain: typeof t.duckGain === 'number' ? t.duckGain : undefined,
      fadeDurationMs: typeof t.fadeDurationMs === 'number' ? t.fadeDurationMs : undefined
    });
    if (typeof t.unducked === 'boolean' && !isStreaming(t.instanceId)) {
      group.unducked.set(t.instanceId, t.unducked);
    }
  }

  for (const id of [...group.members]) {
    if (keep.has(id)) continue;
    const inst = plugins.get(id);
    if (inst && (inst.mode === 'Streaming' || inst.mode === 'streaming')) continue;
    group.members.delete(id);
    group.unducked.delete(id);
    plugins.remove(id);
  }

  refreshRoles(group);
  return snapshot(sid, gid);
}

function listForSession(sessionId) {
  const sid = String(sessionId || '').toUpperCase();
  const out = [];
  for (const g of groups.values()) {
    if (g.sessionId === sid) out.push(snapshot(sid, g.groupId));
  }
  return out;
}

function listAll() {
  return Array.from(groups.values()).map((g) => snapshot(g.sessionId, g.groupId));
}

function hasMembers(sessionId) {
  const sid = String(sessionId || '').toUpperCase();
  for (const g of groups.values()) {
    if (g.sessionId === sid && g.members.size > 0) return true;
  }
  return false;
}

module.exports = {
  register,
  unregister,
  toggle,
  setUnducked,
  snapshot,
  sync,
  listAll,
  listForSession,
  ensureGroup,
  hasMembers
};
