'use strict';

const crypto = require('crypto');

const SESSION_EXPIRATION_MS = 30 * 60 * 1000;
const sessions = new Map();

const systemMetrics = {
  totalOutboundBytes: 0,
  totalInboundBytes: 0,
  sessionsCreatedTotal: 0,
  startTime: Date.now()
};

function generateSessionId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let id = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) id += chars[bytes[i] % chars.length];
  return id;
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createSession(opts = {}, hostInfo = {}) {
  const {
    title = 'Live Mix Session',
    quality = 'High',
    sampleRate = 48000,
    channels = 2,
    sessionId: requestedId,
    transmitterInstanceId = null
  } = opts;

  const joinOnly = !!(opts.joinOnly);

  let sessionId = (requestedId && String(requestedId).trim())
    ? String(requestedId).trim().toUpperCase()
    : generateSessionId();

  while (sessions.has(sessionId) && !requestedId) {
    sessionId = generateSessionId();
  }

  const existing = sessions.get(sessionId);
  if (!existing && joinOnly) {
    return {
      session: null,
      joined: false,
      response: {
        success: false,
        error: 'Session not found. Start Streaming on the master plugin first, then enter its session code here.'
      }
    };
  }
  if (existing) {
    touch(existing);
    const protocol = hostInfo.protocol || 'http';
    const host = hostInfo.host || 'localhost:3001';
    return {
      session: existing,
      joined: true,
      response: {
        success: true,
        sessionId,
        token: existing.token,
        joined: true,
        listenerUrl: `${protocol}://${host}/s/${sessionId}`,
        wsUrl: `ws${protocol === 'https' ? 's' : ''}://${host}/ws?role=transmitter&session=${sessionId}&token=${existing.token}`,
        expiresInSeconds: SESSION_EXPIRATION_MS / 1000,
        config: {
          quality: existing.quality,
          sampleRate: existing.sampleRate,
          channels: existing.channels,
          bitrate: existing.bitrate
        }
      }
    };
  }

  const token = generateToken();
  const session = {
    id: sessionId,
    token,
    title: String(title).trim().slice(0, 60),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    status: 'Offline',
    pluginOnline: false,
    streaming: false,
    quality,
    sampleRate,
    channels,
    bitrate: quality === 'Efficient' ? 96 : 256,
    listeners: new Set(),
    transmitterWs: null,
    transmitterInstanceId,
    producer: null,
    plainTransport: null,
    stats: { bytesSent: 0, packetsSent: 0, peakListeners: 0 },
    effectiveLatencyMs: 0
  };

  sessions.set(sessionId, session);
  systemMetrics.sessionsCreatedTotal++;

  const protocol = hostInfo.protocol || 'http';
  const host = hostInfo.host || 'localhost:3001';

  return {
    session,
    response: {
      success: true,
      sessionId,
      token,
      listenerUrl: `${protocol}://${host}/s/${sessionId}`,
      wsUrl: `ws${protocol === 'https' ? 's' : ''}://${host}/ws?role=transmitter&session=${sessionId}&token=${token}`,
      expiresInSeconds: SESSION_EXPIRATION_MS / 1000,
      config: {
        quality: session.quality,
        sampleRate: session.sampleRate,
        channels: session.channels,
        bitrate: session.bitrate
      }
    }
  };
}

function publicStatus(session) {
  if (!session) return 'Offline';
  if (session.pluginOnline && session.streaming) return 'Live';
  if (session.pluginOnline) return 'Waiting';
  return 'Offline';
}

function setPresence(session, { pluginOnline, streaming } = {}) {
  if (!session) return 'Offline';
  if (pluginOnline != null) session.pluginOnline = !!pluginOnline;
  if (streaming != null) session.streaming = !!streaming;
  if (!session.pluginOnline) session.streaming = false;
  session.status = publicStatus(session);
  touch(session);
  return session.status;
}

function get(sessionId) {
  return sessions.get(String(sessionId || '').toUpperCase());
}

function remove(sessionId) {
  sessions.delete(String(sessionId || '').toUpperCase());
}

function list() {
  return Array.from(sessions.values());
}

function touch(session) {
  session.lastActiveAt = Date.now();
}

function expireInactive() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    const inactive = (now - session.lastActiveAt) > SESSION_EXPIRATION_MS;
    const hasConnections = session.transmitterWs || session.listeners.size > 0 || session.producer
      || (typeof hierarchyHasMembers === 'function' && hierarchyHasMembers(id));
    if (inactive && !hasConnections) {
      session.status = 'Expired';
      sessions.delete(id);
    }
  }
}

function endStream(sessionId) {
  const session = get(sessionId);
  if (!session) return false;
  session.status = 'Ended';
  if (session.transmitterWs) {
    try { session.transmitterWs.close(); } catch (_) {}
    session.transmitterWs = null;
  }
  for (const ws of session.listeners) {
    try {
      ws.send(JSON.stringify({ type: 'SESSION_STATE', status: 'Ended', message: 'Stream ended' }));
      ws.close();
    } catch (_) {}
  }
  session.listeners.clear();
  return true;
}

let hierarchyHasMembers = null;
function setHierarchyHasMembers(fn) { hierarchyHasMembers = fn; }

module.exports = {
  sessions,
  systemMetrics,
  SESSION_EXPIRATION_MS,
  createSession,
  get,
  publicStatus,
  setPresence,
  remove,
  list,
  touch,
  expireInactive,
  endStream,
  generateSessionId,
  generateToken,
  setHierarchyHasMembers
};
