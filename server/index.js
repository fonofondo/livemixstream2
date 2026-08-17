'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');

const auth = require('./auth');
const audit = require('./audit');
const plugins = require('./plugins');
const hierarchy = require('./hierarchy');
const sessions = require('./sessions');
const sfu = require('./sfu');
const { openDatabase, seedIfEmpty } = require('./db');
const { createRouter } = require('./control/api');
const { EventHub } = require('./control/events');
const leases = require('./control/leases');
const schedule = require('./control/schedule');
const { id: newId, now: nowMs } = require('./control/util');

sessions.setHierarchyHasMembers((id) => hierarchy.hasMembers(id));

const DATA_PATH = process.env.ASAPHIX_DB || path.join(__dirname, '../data/asaphix.sqlite');
const db = openDatabase(DATA_PATH);
const seedResult = seedIfEmpty(db);
const hub = new EventHub();

function ensureDemoAssignments() {
  const orgRow = db.prepare("SELECT value FROM meta WHERE key = 'org_id'").get();
  if (!orgRow) return;
  const orgId = orgRow.value;
  schedule.materialize(db, orgId);
  const users = {
    engineerPrimary: db.prepare("SELECT id FROM users WHERE email = 'engineer1@demo.asaphix'").get(),
    engineerBackup: db.prepare("SELECT id FROM users WHERE email = 'engineer2@demo.asaphix'").get(),
    volunteer: db.prepare("SELECT id FROM users WHERE email = 'volunteer@demo.asaphix'").get()
  };
  if (!users.engineerPrimary) return;
  const events = db.prepare(`
    SELECT e.* FROM service_events e
    JOIN locations l ON l.id = e.location_id
    WHERE e.org_id = ? AND e.cancelled = 0 AND e.starts_at > ?
    ORDER BY e.starts_at ASC
  `).all(orgId, Date.now() - 6 * 3600000);
  for (const ev of events) {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(ev.location_id);
    const primary = loc && loc.name.startsWith('South') ? users.engineerBackup : users.engineerPrimary;
    const backup = loc && loc.name.startsWith('South') ? users.engineerPrimary : users.engineerBackup;
    for (const [duty, user] of [['primary', primary], ['backup', backup], ['volunteer', users.volunteer]]) {
      if (!user) continue;
      const exists = db.prepare('SELECT id FROM assignments WHERE event_id = ? AND duty = ?').get(ev.id, duty);
      if (exists) continue;
      db.prepare(`INSERT INTO assignments (id, org_id, event_id, user_id, duty, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', ?)`).run(newId(), orgId, ev.id, user.id, duty, nowMs());
    }
  }
}
ensureDemoAssignments();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = Number(process.env.PORT || 3001);

// Simple in-memory rate limits
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= max;
}

app.use(cors());
app.use(express.json({ limit: '256kb' }));

const { router: v1, actorFromToken, membershipFor } = createRouter({
  db,
  hub,
  runtime: {
    createSession: (opts, hostInfo) => sessions.createSession(opts, hostInfo),
    get: (code) => sessions.get(code),
    publicStatus: (s) => sessions.publicStatus(s),
    endStream: (code) => sessions.endStream(code),
    closeMedia: async (code) => {
      const s = sessions.get(code);
      if (s) await sfu.closeSessionMedia(s);
    },
    hierarchy
  }
});
app.use('/api/v1', v1);

app.get(['/', '/app', '/app/', '/login'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/app/index.html'));
});

app.get(['/admin', '/dashboard'], (req, res) => {
  res.redirect('/#/ops');
});

app.get('/hierarchy', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/hierarchy.html'));
});

app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ---------- Auth ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!auth.checkAdminPassword(password)) {
    audit.record('anonymous', 'login_failed', 'admin', 'denied');
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  const token = auth.createAdminSession();
  audit.record('admin', 'login', 'admin', 'ok');
  res.json({ success: true, token });
});

app.post('/api/admin/logout', auth.requireAdmin, (req, res) => {
  auth.revokeAdminSession(req.adminToken);
  res.json({ success: true });
});

// ---------- Sessions ----------
app.post('/api/session', (req, res) => {
  const ip = req.ip || 'local';
  if (!rateLimit(`session:${ip}`, 30, 60000)) {
    return res.status(429).json({ success: false, error: 'Rate limited' });
  }
  if (req.headers['x-plugin-token'] && !auth.checkPluginToken(req.headers['x-plugin-token'])) {
    return res.status(401).json({ success: false, error: 'Invalid plugin token' });
  }

  const host = req.get('host');
  const protocol = req.protocol;
  const { session, response } = sessions.createSession(req.body || {}, { host, protocol });
  if (!response.success) return res.status(404).json(response);
  res.status(response.joined ? 200 : 201).json(response);
});

app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  res.json({
    success: true,
    sessionId: session.id,
    title: session.title,
    status: sessions.publicStatus(session),
    createdAt: session.createdAt,
    activeListeners: session.listeners.size,
    mediaMode: session.mediaMode || (sfu.isReady() ? 'webrtc' : 'websocket'),
    sfuReady: sfu.isReady(),
    hierarchy: hierarchy.listForSession(session.id),
    audioSpec: {
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitrate: session.bitrate,
      quality: session.quality
    }
  });
});

// ---------- Hierarchy REST (session-scoped) ----------
app.get('/api/hierarchy', (req, res) => {
  const sessionId = (req.query.session || '').toString().toUpperCase();
  if (sessionId) {
    if (!sessions.get(sessionId)) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    return res.json({ success: true, sessionId, groups: hierarchy.listForSession(sessionId) });
  }
  res.json({ success: true, groups: hierarchy.listAll() });
});

function toggleTrack(sessionId, instanceId, groupId = 'default') {
  return hierarchy.toggle(sessionId, instanceId, groupId);
}

app.post('/api/hierarchy/toggle', (req, res) => {
  const ip = req.ip || 'local';
  if (!rateLimit(`hier:${ip}`, 60, 60000)) {
    return res.status(429).json({ success: false, error: 'Rate limited' });
  }
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  const actor = actorFromToken(raw);
  if (!actor && !auth.checkPluginToken(req.headers['x-plugin-token'])) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const { sessionId, groupId = 'default', instanceId } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });
  const result = toggleTrack(sessionId, instanceId, groupId);
  if (!result.success) return res.status(400).json(result);
  broadcastHierarchy(sessionId, groupId);
  res.json(result);
});

app.post('/api/hierarchy/lead', (req, res) => {
  const ip = req.ip || 'local';
  if (!rateLimit(`hier:${ip}`, 60, 60000)) {
    return res.status(429).json({ success: false, error: 'Rate limited' });
  }
  const { sessionId, groupId = 'default', instanceId } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });
  const result = toggleTrack(sessionId, instanceId, groupId);
  if (!result.success) return res.status(400).json(result);
  broadcastHierarchy(sessionId, groupId);
  res.json(result);
});

// ---------- Metrics ----------
app.get('/api/metrics', (req, res) => {
  let activeListeners = 0;
  let activeSessions = 0;
  sessions.list().forEach((s) => {
    if (s.status === 'Live' || s.status === 'Connecting') {
      activeSessions++;
      activeListeners += s.listeners.size;
    }
  });
  const mem = process.memoryUsage();
  res.json({
    success: true,
    server: {
      uptimeSeconds: Math.floor((Date.now() - sessions.systemMetrics.startTime) / 1000),
      platform: process.platform,
      arch: process.arch,
      cpuLoad: os.loadavg(),
      freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
      sfuReady: sfu.isReady(),
      version: '1.0.0'
    },
    metrics: {
      activeSessions,
      activeListeners,
      connectedInstances: plugins.list().length,
      hierarchyGroups: hierarchy.listAll().length,
      totalSessionsCreated: sessions.systemMetrics.sessionsCreatedTotal,
      totalOutboundMB: (sessions.systemMetrics.totalOutboundBytes / (1024 * 1024)).toFixed(2),
      totalInboundMB: (sessions.systemMetrics.totalInboundBytes / (1024 * 1024)).toFixed(2)
    }
  });
});

// ---------- Admin APIs ----------
app.get('/api/admin/sessions', auth.requireAdmin, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const list = sessions.list().map((session) => ({
    sessionId: session.id,
    title: session.title,
    status: sessions.publicStatus(session),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    activeListeners: session.listeners.size,
    effectiveLatencyMs: session.effectiveLatencyMs || 0,
    transmitterInstanceId: session.transmitterInstanceId,
    mediaMode: session.mediaMode || null,
    hierarchy: hierarchy.listForSession(session.id),
    listenerUrl: `${protocol}://${host}/s/${session.id}`,
    audioSpec: {
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitrate: session.bitrate,
      quality: session.quality
    },
    stats: session.stats
  }));
  res.json({ success: true, count: list.length, sessions: list });
});

app.get('/api/admin/instances', auth.requireAdmin, (req, res) => {
  let list = plugins.list();
  const q = (req.query.q || '').toString().toLowerCase();
  if (q) {
    list = list.filter((i) =>
      i.instanceId.toLowerCase().includes(q) ||
      (i.trackName || '').toLowerCase().includes(q) ||
      (i.groupId || '').toLowerCase().includes(q) ||
      (i.mode || '').toLowerCase().includes(q) ||
      (i.os || '').toLowerCase().includes(q) ||
      (i.status || '').toLowerCase().includes(q)
    );
  }
  res.json({ success: true, count: list.length, instances: list });
});

app.get('/api/admin/audit', auth.requireAdmin, (req, res) => {
  res.json({ success: true, entries: audit.list(200) });
});

app.post('/api/admin/sessions/:id/end', auth.requireAdmin, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: 'Not found' });
  await sfu.closeSessionMedia(session);
  sessions.endStream(req.params.id);
  audit.record('admin', 'end_stream', req.params.id.toUpperCase());
  res.json({ success: true });
});

app.post('/api/admin/instances/:id/disconnect', auth.requireAdmin, (req, res) => {
  const ok = plugins.forceDisconnect(req.params.id, 8000);
  if (!ok) return res.status(404).json({ success: false, error: 'Not found' });
  hierarchy.unregister(req.params.id);
  audit.record('admin', 'force_disconnect', req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/hierarchy/toggle', auth.requireAdmin, (req, res) => {
  const { sessionId, groupId = 'default', instanceId } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });
  const result = toggleTrack(sessionId, instanceId, groupId);
  if (result.success) {
    broadcastHierarchy(sessionId, groupId);
    audit.record('admin', 'toggle_track', `${sessionId}:${instanceId}`);
  }
  res.json(result);
});

app.post('/api/admin/hierarchy/lead', auth.requireAdmin, (req, res) => {
  const { sessionId, groupId = 'default', instanceId } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });
  const result = toggleTrack(sessionId, instanceId, groupId);
  if (result.success) {
    broadcastHierarchy(sessionId, groupId);
    audit.record('admin', 'toggle_track', `${sessionId}:${instanceId}`);
  }
  res.json(result);
});

app.get('/api/webrtc/capabilities', (req, res) => {
  if (!sfu.isReady()) return res.status(503).json({ success: false, error: 'SFU unavailable' });
  res.json({ success: true, rtpCapabilities: sfu.getRtpCapabilities() });
});

// ---------- WebSocket ----------
const hierarchyUiClients = new Set();
const adminWsClients = new Set();
const lastHierarchyJson = new Map(); // `${sessionId}::${groupId}` -> last broadcast JSON

function broadcastHierarchy(sessionId, groupId = 'default', { force = false } = {}) {
  const sid = String(sessionId || '').toUpperCase();
  const gid = groupId || 'default';
  const state = hierarchy.snapshot(sid, gid);
  const json = JSON.stringify(state);
  const key = `${sid}::${gid}`;

  if (!force && lastHierarchyJson.get(key) === json)
    return false;
  lastHierarchyJson.set(key, json);

  const sent = new Set();
  for (const id of state.tracks.map((t) => t.instanceId)) {
    const ws = plugins.getWs(id);
    if (ws && ws.readyState === WebSocket.OPEN && !sent.has(ws)) {
      sent.add(ws);
      ws.send(json);
    }
  }

  const session = sessions.get(sid);
  if (session) {
    session.listeners.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    });
  }

  for (const ws of hierarchyUiClients) {
    if (ws.readyState === WebSocket.OPEN && (!ws.sessionId || ws.sessionId === sid))
      ws.send(json);
  }
  for (const ws of adminWsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
  return true;
}

function notifyListeners(session, payload) {
  const json = JSON.stringify(payload);
  session.listeners.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function pushSessionState(session) {
  if (!session) return;
  notifyListeners(session, {
    type: 'SESSION_STATE',
    status: sessions.publicStatus(session),
    hierarchy: hierarchy.listForSession(session.id)
  });
}

function clearSessionHierarchy(sid) {
  const groups = hierarchy.listForSession(sid);
  for (const g of groups) {
    for (const t of (g.tracks || [])) hierarchy.unregister(t.instanceId);
    broadcastHierarchy(sid, g.groupId);
  }
}

server.on('upgrade', (request, socket, head) => {
  const urlParams = new URLSearchParams(request.url.replace(/^[^?]*\?/, ''));
  const role = urlParams.get('role');
  const sessionId = (urlParams.get('session') || '').toUpperCase();
  const token = urlParams.get('token');
  const instanceId = urlParams.get('instanceId') || '';

  if (role === 'hierarchy-ui' || role === 'admin' || role === 'ops') {
    if ((role === 'admin' || role === 'ops') && !auth.isValidAdminToken(token) && !actorFromToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const hierSession = sessionId ? sessions.get(sessionId) : null;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, { role, token, session: hierSession, sessionId });
    });
    return;
  }

  if (role === 'plugin') {
    if (plugins.isBlocked(instanceId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, { role, instanceId });
    });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (role === 'transmitter' && session.token !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, { role, session, token });
  });
});

wss.on('connection', (ws, request, context) => {
  const { role, session, instanceId, sessionId, token } = context;
  ws.role = role;
  ws.session = session;
  ws.sessionId = sessionId || (session && session.id);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'plugin') return handlePluginConnection(ws, instanceId);
  if (role === 'transmitter') return handleTransmitterConnection(ws, session);
  if (role === 'listener') return handleListenerConnection(ws, session);
  if (role === 'hierarchy-ui') {
    hierarchyUiClients.add(ws);
    const sid = ws.sessionId;
    const groups = sid ? hierarchy.listForSession(sid) : [];
    ws.send(JSON.stringify({ type: 'HIERARCHY_SNAPSHOT', sessionId: sid || null, groups }));
    ws.on('close', () => hierarchyUiClients.delete(ws));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const targetSession = msg.sessionId || sid;
        if (!targetSession) return;
        if (msg.type === 'TOGGLE_TRACK' || msg.type === 'SET_LEAD') {
          hierarchy.toggle(targetSession, msg.instanceId, msg.groupId || 'default');
          broadcastHierarchy(targetSession, msg.groupId || 'default');
        }
      } catch (_) {}
    });
    return;
  }
  if (role === 'admin' || role === 'ops') {
    adminWsClients.add(ws);
    const actor = actorFromToken(token);
    if (actor) {
      const mem = membershipFor(actor.user_id);
      hub.add(ws, { orgId: mem && mem.org_id, userId: actor.user_id, role: mem && mem.role });
    }
    ws.on('close', () => {
      adminWsClients.delete(ws);
      hub.remove(ws);
    });
    return;
  }
});

function handlePluginConnection(ws, instanceId) {
  const id = instanceId || crypto.randomUUID();
  ws.instanceId = id;
  plugins.upsert(id, { status: 'Connected' });
  plugins.setWs(id, ws);
  console.log(`[Plugin] connected ${id}`);

  ws.on('message', async (message, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      // Opus/PCM fallback relay if plugin sends media on plugin socket
      // Find live session for this instance
      const inst = plugins.get(id) || plugins.get(ws.instanceId);
      const sid = inst && (inst.streamSessionId || inst.sessionId);
      if (sid) {
        const session = sessions.get(sid);
        if (session) fanoutBinary(session, message);
      }
      return;
    }

    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'HIERARCHY_REGISTER') {
        const iid = payload.instanceId || id;
        const sid = (payload.sessionId || '').toUpperCase();
        const isSelf = iid === id || iid === ws.instanceId || payload.mode === 'Streaming';
        if (isSelf)
          ws.instanceId = iid;
        plugins.upsert(iid, {
          trackName: payload.trackName || 'Track',
          groupId: payload.groupId || 'default',
          sessionId: sid || null,
          mode: payload.mode || 'TrackControl',
          pluginVersion: payload.pluginVersion || '1.0.0',
          os: payload.os || 'Unknown',
          status: 'Connected'
        });
        if (isSelf)
          plugins.setWs(iid, ws);
        if (!sid) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'sessionId required for hierarchy' }));
        } else {
          if (!sessions.get(sid)) {
            sessions.createSession({ sessionId: sid, title: payload.trackName || 'Live Mix Session' }, {});
          }
          sessions.touch(sessions.get(sid));
          const state = hierarchy.register(iid, payload.trackName, sid, payload.groupId || 'default', {
            mode: payload.mode || 'TrackControl',
            duckGain: typeof payload.duckGain === 'number' ? payload.duckGain : undefined,
            fadeDurationMs: typeof payload.fadeDurationMs === 'number' ? payload.fadeDurationMs : undefined
          });
          ws.send(JSON.stringify(state));
          broadcastHierarchy(sid, payload.groupId || 'default');
          const sess = sessions.get(sid);
          if (sess && (payload.mode === 'Streaming' || iid === ws.instanceId)) {
            sess.transmitterInstanceId = ws.instanceId;
            sessions.setPresence(sess, { pluginOnline: true });
            pushSessionState(sess);
          }
        }
      } else if (payload.type === 'PRESENCE') {
        const sid = (payload.sessionId || '').toUpperCase();
        if (!sid) return;
        if (!sessions.get(sid)) {
          sessions.createSession({ sessionId: sid }, {});
        }
        const sess = sessions.get(sid);
        sess.transmitterInstanceId = ws.instanceId;
        plugins.upsert(ws.instanceId, { sessionId: sid, mode: 'Streaming', status: payload.streaming ? 'Streaming' : 'Connected' });
        plugins.setWs(ws.instanceId, ws);
        sessions.setPresence(sess, { pluginOnline: true, streaming: !!payload.streaming });
        pushSessionState(sess);
      } else if (payload.type === 'HIERARCHY_SYNC') {
        const sid = (payload.sessionId || '').toUpperCase();
        if (!sid) return;
        if (!sessions.get(sid)) {
          sessions.createSession({ sessionId: sid }, {});
        }
        const state = hierarchy.sync(
          sid,
          payload.groupId || 'default',
          payload.tracks || [],
          ws.instanceId
        );
        broadcastHierarchy(sid, payload.groupId || 'default');
        const sess = sessions.get(sid);
        if (sess) {
          sess.transmitterInstanceId = ws.instanceId;
          sessions.setPresence(sess, { pluginOnline: true });
          pushSessionState(sess);
        }
        ws.send(JSON.stringify(state));
      } else if (payload.type === 'HIERARCHY_UNREGISTER') {
        const iid = payload.instanceId;
        if (iid && iid !== ws.instanceId) {
          const inst = plugins.get(iid);
          const sid = inst && inst.sessionId;
          const gid = (inst && inst.groupId) || 'default';
          hierarchy.unregister(iid);
          if (sid) broadcastHierarchy(sid, gid);
        }
      } else if (payload.type === 'TOGGLE_TRACK' || payload.type === 'SET_LEAD' || payload.type === 'SET_TRACK_UNDUCKED') {
        const inst = plugins.get(ws.instanceId);
        const sid = (payload.sessionId || (inst && inst.sessionId) || '').toUpperCase();
        if (!sid) {
          console.warn('[Hierarchy] toggle/set missing sessionId', payload.type, payload.instanceId);
          return;
        }
        const gid = payload.groupId || 'default';
        let result;
        if (payload.type === 'SET_TRACK_UNDUCKED')
          result = hierarchy.setUnducked(sid, payload.instanceId, !!payload.unducked, gid);
        else
          result = hierarchy.toggle(sid, payload.instanceId, gid);
        if (result && result.success)
          broadcastHierarchy(sid, gid);
        else
          console.warn('[Hierarchy]', payload.type, 'failed', result && result.error, payload.instanceId);
      } else if (payload.type === 'PRODUCE_PLAIN') {
        const session = sessions.get(payload.sessionId);
        if (!session || session.token !== payload.token) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid session' }));
          return;
        }
        session.status = 'Live';
        sessions.setPresence(session, { pluginOnline: true, streaming: true });
        sessions.touch(session);
        plugins.upsert(ws.instanceId, {
          status: 'Streaming',
          streamSessionId: session.id,
          sessionId: session.id,
          mode: 'Streaming'
        });
        session.transmitterInstanceId = ws.instanceId;

        if (sfu.isReady()) {
          try {
            const rtp = await sfu.createPlainProducer(session);
            ws.send(JSON.stringify({
              type: 'PLAIN_TRANSPORT',
              sessionId: session.id,
              ip: rtp.ip,
              port: rtp.port,
              ssrc: rtp.ssrc,
              payloadType: rtp.payloadType,
              rtcpPort: rtp.rtcpPort
            }));
          } catch (err) {
            console.error('[SFU] plain produce failed', err.message);
            session.mediaMode = 'websocket';
            ws.send(JSON.stringify({ type: 'PLAIN_TRANSPORT_FALLBACK', sessionId: session.id }));
          }
        } else {
          session.mediaMode = 'websocket';
          ws.send(JSON.stringify({ type: 'PLAIN_TRANSPORT_FALLBACK', sessionId: session.id }));
        }

        notifyListeners(session, {
          type: 'SESSION_STATE',
          status: sessions.publicStatus(session),
          hierarchy: hierarchy.listForSession(session.id),
          audioSpec: {
            sampleRate: session.sampleRate,
            channels: session.channels,
            bitrate: session.bitrate,
            quality: session.quality
          },
          sfuReady: sfu.isReady()
        });
      } else if (payload.type === 'STOP_PRODUCE') {
        const inst = plugins.get(ws.instanceId);
        if (inst && inst.streamSessionId) {
          const session = sessions.get(inst.streamSessionId);
          if (session) {
            await sfu.closeSessionMedia(session);
            sessions.setPresence(session, { pluginOnline: true, streaming: false });
            pushSessionState(session);
          }
          plugins.upsert(ws.instanceId, { status: 'Connected', streamSessionId: null });
        }
      }
    } catch (e) {
      console.error('[Plugin] parse error', e.message);
    }
  });

  ws.on('close', () => {
    const iid = ws.instanceId;
    console.log(`[Plugin] disconnected ${iid}`);
    const inst = plugins.get(iid);
    const sid = inst && inst.sessionId;
    hierarchy.unregister(iid);
    if (sid) {
      broadcastHierarchy(sid, (inst && inst.groupId) || 'default');
      const session = sessions.get(sid);
      const still = plugins.list().some((p) => p.sessionId === sid && p.instanceId !== iid);
      if (session && !still) {
        sessions.setPresence(session, { pluginOnline: false, streaming: false });
        session.transmitterWs = null;
        pushSessionState(session);
      }
    }
  });
}

function fanoutBinary(session, message) {
  const dataLength = message.length;
  sessions.systemMetrics.totalInboundBytes += dataLength;
  session.listeners.forEach((listenerWs) => {
    if (listenerWs.readyState === WebSocket.OPEN) {
      listenerWs.send(message, { binary: true });
      sessions.systemMetrics.totalOutboundBytes += dataLength;
      session.stats.bytesSent += dataLength;
    }
  });
  session.stats.packetsSent++;
}

function handleTransmitterConnection(ws, session) {
  if (session.transmitterWs && session.transmitterWs !== ws) {
    try { session.transmitterWs.close(); } catch (_) {}
  }
  session.transmitterWs = ws;
  session.status = 'Live';
  sessions.touch(session);
  console.log(`[SFU] Transmitter connected for session ${session.id}`);

  notifyListeners(session, {
    type: 'SESSION_STATE',
    status: 'Live',
    audioSpec: {
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitrate: session.bitrate,
      quality: session.quality
    }
  });

  ws.on('message', (message, isBinary) => {
    ws.isAlive = true;
    sessions.touch(session);
    if (isBinary) {
      fanoutBinary(session, message);
      if (session.stats.packetsSent % 100 === 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'TELEMETRY',
          listeners: session.listeners.size,
          bytesSent: session.stats.bytesSent,
          status: 'Live'
        }));
      }
      return;
    }
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'CONFIG_UPDATE') {
        if (payload.sampleRate) session.sampleRate = payload.sampleRate;
        if (payload.channels) session.channels = payload.channels;
        if (payload.bitrate) session.bitrate = payload.bitrate;
        if (payload.quality) session.quality = payload.quality;
        notifyListeners(session, {
          type: 'AUDIO_CONFIG',
          audioSpec: {
            sampleRate: session.sampleRate,
            channels: session.channels,
            bitrate: session.bitrate,
            quality: session.quality
          }
        });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    session.transmitterWs = null;
    session.status = 'Disconnected';
    notifyListeners(session, { type: 'SESSION_STATE', status: 'Disconnected' });
  });
}

function handleListenerConnection(ws, session) {
  const listenerId = crypto.randomBytes(8).toString('hex');
  ws.listenerId = listenerId;
  ws.webrtcTransport = null;
  ws.consumer = null;

  session.listeners.add(ws);
  sessions.touch(session);
  if (session.listeners.size > session.stats.peakListeners) {
    session.stats.peakListeners = session.listeners.size;
  }

  console.log(`[SFU] Listener ${listenerId} joined ${session.id}. Total: ${session.listeners.size}`);

  ws.send(JSON.stringify({
    type: 'INIT',
    listenerId,
    sessionId: session.id,
    title: session.title,
    status: sessions.publicStatus(session),
    sfuReady: sfu.isReady(),
    mediaMode: session.mediaMode || (sfu.isReady() && session.producer ? 'webrtc' : 'websocket'),
    hierarchy: hierarchy.listForSession(session.id),
    audioSpec: {
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitrate: session.bitrate,
      quality: session.quality
    }
  }));

  if (session.transmitterWs && session.transmitterWs.readyState === WebSocket.OPEN) {
    session.transmitterWs.send(JSON.stringify({
      type: 'LISTENER_COUNT',
      count: session.listeners.size,
      event: 'joined'
    }));
  }

  ws.on('message', async (message) => {
    ws.isAlive = true;
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'PING') {
        ws.send(JSON.stringify({
          type: 'PONG',
          clientTimestamp: payload.timestamp,
          serverTimestamp: Date.now()
        }));
      } else if (payload.type === 'CLIENT_TELEMETRY') {
        session.effectiveLatencyMs = payload.effectiveLatencyMs;
        if (session.transmitterWs && session.transmitterWs.readyState === WebSocket.OPEN) {
          session.transmitterWs.send(JSON.stringify({
            type: 'TELEMETRY',
            listeners: session.listeners.size,
            effectiveLatencyMs: session.effectiveLatencyMs
          }));
        }
      } else if (payload.type === 'TOGGLE_TRACK' || payload.type === 'SET_LEAD') {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Mix control is not available to listeners' }));
      } else if (payload.type === 'WEBRTC_GET_CAPABILITIES') {
        ws.send(JSON.stringify({
          type: 'WEBRTC_CAPABILITIES',
          rtpCapabilities: sfu.getRtpCapabilities()
        }));
      } else if (payload.type === 'WEBRTC_CREATE_TRANSPORT') {
        if (!sfu.isReady()) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'SFU unavailable' }));
          return;
        }
        const { transport, params } = await sfu.createWebRtcTransport();
        ws.webrtcTransport = transport;
        ws.send(JSON.stringify({ type: 'WEBRTC_TRANSPORT', params }));
      } else if (payload.type === 'WEBRTC_CONNECT_TRANSPORT') {
        if (!ws.webrtcTransport) return;
        await sfu.connectWebRtcTransport(ws.webrtcTransport, payload.dtlsParameters);
        ws.send(JSON.stringify({ type: 'WEBRTC_CONNECTED' }));
      } else if (payload.type === 'WEBRTC_CONSUME') {
        if (!ws.webrtcTransport || !session.producer) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'No producer yet' }));
          return;
        }
        const { consumer, params } = await sfu.consume(session, ws.webrtcTransport, payload.rtpCapabilities);
        ws.consumer = consumer;
        ws.send(JSON.stringify({ type: 'WEBRTC_CONSUMER', params }));
      }
    } catch (e) {
      console.error('[Listener] error', e.message);
      ws.send(JSON.stringify({ type: 'ERROR', error: e.message }));
    }
  });

  ws.on('close', () => {
    session.listeners.delete(ws);
    try { if (ws.consumer) ws.consumer.close(); } catch (_) {}
    try { if (ws.webrtcTransport) ws.webrtcTransport.close(); } catch (_) {}
    if (session.transmitterWs && session.transmitterWs.readyState === WebSocket.OPEN) {
      session.transmitterWs.send(JSON.stringify({
        type: 'LISTENER_COUNT',
        count: session.listeners.size,
        event: 'left'
      }));
    }
  });
}

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  sessions.expireInactive();
  const orgs = db.prepare('SELECT id FROM organizations').all();
  for (const org of orgs) leases.expireStale(db, org.id);
}, 15000);

wss.on('close', () => clearInterval(pingInterval));

async function boot() {
  try {
    await sfu.init();
  } catch (err) {
    console.warn('[SFU] init failed, websocket fallback only:', err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================================');
    console.log(` Asaphix  http://0.0.0.0:${PORT}`);
    console.log(` App:       http://localhost:${PORT}/`);
    console.log(` Monitor:   http://localhost:${PORT}/s/SESSION_ID`);
    console.log(` SQLite:    ${DATA_PATH}`);
    if (seedResult.seeded) {
      console.log(' Demo owner: owner@demo.asaphix / demo-owner');
    }
    console.log(` SFU:       ${sfu.isReady() ? 'mediasoup ready' : 'websocket fallback'}`);
    console.log('====================================================');
  });
}

boot();
