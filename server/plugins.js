'use strict';

/** In-memory plugin instance registry */
const instances = new Map();

function upsert(instanceId, patch = {}) {
  const existing = instances.get(instanceId) || {
    instanceId,
    trackName: 'Track',
    groupId: 'default',
    mode: 'TrackControl',
    pluginVersion: '1.0.0',
    os: 'Unknown',
    status: 'Connected',
    role: 'idle',
    sessionId: null,
    streamSessionId: null,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    ws: null,
    forceDisconnectUntil: 0
  };

  Object.assign(existing, patch, { lastSeen: Date.now() });
  instances.set(instanceId, existing);
  return existing;
}

function get(instanceId) {
  return instances.get(instanceId);
}

function remove(instanceId) {
  instances.delete(instanceId);
}

function list() {
  return Array.from(instances.values()).map((i) => ({
    instanceId: i.instanceId,
    trackName: i.trackName,
    groupId: i.groupId,
    sessionId: i.sessionId,
    mode: i.mode,
    pluginVersion: i.pluginVersion,
    os: i.os,
    status: i.status,
    role: i.role,
    streamSessionId: i.streamSessionId,
    connectedAt: i.connectedAt,
    lastSeen: i.lastSeen
  }));
}

function setWs(instanceId, ws) {
  const inst = instances.get(instanceId);
  if (inst) inst.ws = ws;
}

function getWs(instanceId) {
  const inst = instances.get(instanceId);
  return inst ? inst.ws : null;
}

function forceDisconnect(instanceId, backoffMs = 5000) {
  const inst = instances.get(instanceId);
  if (!inst) return false;
  inst.forceDisconnectUntil = Date.now() + backoffMs;
  inst.status = 'Disconnected';
  if (inst.ws) {
    try { inst.ws.close(); } catch (_) {}
    inst.ws = null;
  }
  return true;
}

function isBlocked(instanceId) {
  const inst = instances.get(instanceId);
  return inst && inst.forceDisconnectUntil > Date.now();
}

module.exports = {
  upsert,
  get,
  remove,
  list,
  setWs,
  getWs,
  forceDisconnect,
  isBlocked
};
