'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { open, seed, hashPassword, verifyPassword } = require('./db');

const PORT = Number(process.env.PORT || 3100);
const DB_PATH = process.env.ASAPHOPS_DB || path.join(__dirname, 'data/asaphops.sqlite');
const db = open(DB_PATH);
const seeded = seed(db);
db.prepare(`UPDATE endpoints SET status = CASE
  WHEN client_id IS NULL OR client_id = '' THEN 'unassigned'
  ELSE 'offline' END`).run();

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UPCOMING_LIMIT = 8;

function id() { return crypto.randomUUID(); }
function now() { return Date.now(); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function tokenHash(v) { return crypto.createHash('sha256').update(v).digest('hex'); }

function partsInZone(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[map.weekday],
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour) % 24, minute: Number(map.minute), second: Number(map.second)
  };
}

function zonedUtc(timeZone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const local = partsInZone(guess, timeZone);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  const got = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return guess + (wanted - got);
}

function parseList(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    if (value.includes(',')) return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return fallback;
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function formatSlot(slot) {
  return `${slot.start}–${slot.end}`;
}

function eventSlots(ev) {
  const raw = parseList(ev.times, ev.start_local ? [ev.start_local] : [{ start: '10:00', end: '11:15' }]);
  return raw.map((item) => {
    if (item && typeof item === 'object' && item.start) {
      return { start: String(item.start).slice(0, 5), end: String(item.end || item.start).slice(0, 5) };
    }
    const start = String(item).slice(0, 5);
    const extra = ev.duration_min || 75;
    const endMin = minutesOf(start) + extra;
    const end = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    return { start, end };
  }).filter((s) => s.start && s.end);
}

function eventTimes(ev) {
  return eventSlots(ev);
}

function eventWeekdays(ev) {
  const days = parseList(ev.weekdays, ev.weekday != null ? [Number(ev.weekday)] : [0]);
  return days.map(Number).filter((d) => d >= 0 && d <= 6);
}

function normalizeSlots(times) {
  const list = Array.isArray(times) ? times : parseList(times, []);
  return list.map((item) => {
    if (item && typeof item === 'object') {
      return { start: String(item.start || '').slice(0, 5), end: String(item.end || '').slice(0, 5) };
    }
    return null;
  }).filter((s) => s && s.start && s.end);
}

function summarizeEvent(ev) {
  const slots = eventSlots(ev).map(formatSlot);
  if (ev.kind === 'once') return `${ev.once_date || 'one date'} · ${slots.join(', ')}`;
  const days = eventWeekdays(ev).map((d) => WEEKDAYS[d].slice(0, 3)).join(', ');
  return `${days} · ${slots.join(', ')}`;
}

function slotWindowsInRange(ev, tz, fromTs, untilTs) {
  const slots = eventSlots(ev);
  const windows = [];
  if (ev.kind === 'once') {
    if (!ev.once_date) return windows;
    const [y, mo, d] = ev.once_date.split('-').map(Number);
    for (const slot of slots) {
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      const start = zonedUtc(tz, y, mo, d, sh, sm);
      const end = zonedUtc(tz, y, mo, d, eh, em);
      if (start >= fromTs && start < untilTs) windows.push({ start, end, slot });
    }
    return windows;
  }
  const days = new Set(eventWeekdays(ev));
  let cursor = fromTs - 2 * 86400000;
  while (cursor <= untilTs) {
    const p = partsInZone(cursor, tz);
    if (days.has(p.weekday)) {
      for (const slot of slots) {
        const [sh, sm] = slot.start.split(':').map(Number);
        const [eh, em] = slot.end.split(':').map(Number);
        const start = zonedUtc(tz, p.year, p.month, p.day, sh, sm);
        const end = zonedUtc(tz, p.year, p.month, p.day, eh, em);
        if (start >= fromTs && start < untilTs) windows.push({ start, end, slot });
      }
    }
    cursor += 86400000;
  }
  return windows;
}

function slotWindows(ev, tz) {
  const fromTs = now() - 12 * 3600000;
  const untilTs = now() + 120 * 86400000;
  const windows = slotWindowsInRange(ev, tz, fromTs, untilTs);
  return windows.slice(0, UPCOMING_LIMIT);
}

function validateSlots(slots) {
  for (const slot of slots) {
    if (minutesOf(slot.end) <= minutesOf(slot.start)) {
      return `End time must be after start time (${formatSlot(slot)})`;
    }
  }
  const ordered = [...slots].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  for (let i = 1; i < ordered.length; i++) {
    if (minutesOf(ordered[i].start) < minutesOf(ordered[i - 1].end)) {
      return `Times overlap: ${formatSlot(ordered[i - 1])} and ${formatSlot(ordered[i])}`;
    }
  }
  return null;
}

function findLocationConflicts(clientId, windows, excludeEventId) {
  if (!windows.length) return [];
  const rows = db.prepare(`
    SELECT o.starts_at, o.ends_at, e.name
    FROM occurrences o
    JOIN events e ON e.id = o.event_id
    WHERE e.client_id = ? AND o.cancelled = 0 ${excludeEventId ? 'AND e.id != ?' : ''}
  `).all(...(excludeEventId ? [clientId, excludeEventId] : [clientId]));
  const hits = [];
  for (const win of windows) {
    for (const row of rows) {
      if (win.start < row.ends_at && row.starts_at < win.end) {
        hits.push({
          eventName: row.name,
          startsAt: row.starts_at,
          endsAt: row.ends_at
        });
      }
    }
  }
  return hits;
}

function insertOccurrence(eventId, start, end) {
  if (end <= start) return { ok: false, error: 'End must be after start' };
  const exists = db.prepare('SELECT id FROM occurrences WHERE event_id = ? AND starts_at = ?').get(eventId, start);
  if (exists) return { ok: true, skipped: true };
  db.prepare(`INSERT INTO occurrences (id, event_id, starts_at, ends_at, status, cancelled, created_at)
    VALUES (?, ?, ?, ?, 'planned', 0, ?)`)
    .run(id(), eventId, start, end, now());
  return { ok: true };
}

function materialize(eventId) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev || !ev.enabled) return;
  for (const win of slotWindows(ev, ev.timezone)) {
    const conflict = findLocationConflicts(ev.client_id, [win], ev.id);
    if (conflict.length) continue;
    insertOccurrence(ev.id, win.start, win.end);
  }
}

function materializeRange(fromTs, untilTs) {
  const events = db.prepare('SELECT * FROM events WHERE enabled = 1').all();
  for (const ev of events) {
    for (const win of slotWindowsInRange(ev, ev.timezone, fromTs, untilTs)) {
      const conflict = findLocationConflicts(ev.client_id, [win], ev.id);
      if (conflict.length) continue;
      insertOccurrence(ev.id, win.start, win.end);
    }
  }
}

function actorFrom(req) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!raw) return null;
  const row = db.prepare(`
    SELECT s.*, p.name, p.email, p.role
    FROM sessions s JOIN people p ON p.id = s.person_id
    WHERE s.token_hash = ?
  `).get(tokenHash(raw));
  if (!row || row.expires_at < now()) return null;
  return row;
}

function requireAuth(req, res, next) {
  const actor = actorFrom(req);
  if (!actor) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  req.actor = actor;
  next();
}

function publicPerson(p) {
  return { id: p.id, name: p.name, email: p.email, phone: p.phone, role: p.role, client_id: p.client_id, created_at: p.created_at };
}

const app = express();
app.use(express.json({ limit: '128kb' }));

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const person = db.prepare('SELECT * FROM people WHERE email = ?').get(String(email || '').toLowerCase());
  if (!person || !person.password_hash || !verifyPassword(password || '', person.password_salt, person.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
  const raw = token();
  db.prepare('INSERT INTO sessions (token_hash, person_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(raw), person.id, now() + 12 * 3600000);
  res.json({ ok: true, token: raw, person: publicPerson(person) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, person: { id: req.actor.person_id, name: req.actor.name, email: req.actor.email, role: req.actor.role } });
});

app.get('/api/clients', requireAuth, (_req, res) => {
  res.json({ ok: true, clients: db.prepare('SELECT * FROM clients ORDER BY name').all() });
});

app.post('/api/clients', requireAuth, (req, res) => {
  const { name, city, timezone, notes } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const rowId = id();
  db.prepare('INSERT INTO clients (id, name, city, timezone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rowId, name, city || null, timezone || 'America/Chicago', notes || null, now());
  res.status(201).json({ ok: true, client: db.prepare('SELECT * FROM clients WHERE id = ?').get(rowId) });
});

app.get('/api/clients/:id', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'Not found' });
  const people = db.prepare('SELECT id, name, email, role, phone FROM people WHERE client_id = ? ORDER BY name').all(client.id);
  const events = db.prepare('SELECT * FROM events WHERE client_id = ? ORDER BY name').all(client.id)
    .map((e) => ({ ...e, summary: summarizeEvent(e) }));
  const endpoints = db.prepare('SELECT * FROM endpoints WHERE client_id = ? ORDER BY name').all(client.id)
    .map(decorateEndpoint);
  res.json({ ok: true, client, people, events, endpoints });
});

app.patch('/api/clients/:id', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'Not found' });
  const { name, city, timezone, notes } = req.body || {};
  db.prepare('UPDATE clients SET name = ?, city = ?, timezone = ?, notes = ? WHERE id = ?')
    .run(name || client.name, city ?? client.city, timezone || client.timezone, notes ?? client.notes, client.id);
  res.json({ ok: true, client: db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id) });
});

app.get('/api/people', requireAuth, (_req, res) => {
  const people = db.prepare(`
    SELECT p.*, c.name AS client_name
    FROM people p LEFT JOIN clients c ON c.id = p.client_id
    ORDER BY p.name
  `).all().map((p) => ({ ...publicPerson(p), client_name: p.client_name }));
  res.json({ ok: true, people });
});

app.post('/api/people', requireAuth, (req, res) => {
  const { name, email, phone, role, clientId, password } = req.body || {};
  if (!name || !email || !role) return res.status(400).json({ ok: false, error: 'name, email, role required' });
  const rowId = id();
  let hash = null;
  let salt = null;
  if (password) {
    const pw = hashPassword(password);
    hash = pw.hash;
    salt = pw.salt;
  }
  try {
    db.prepare(`INSERT INTO people (id, name, email, phone, role, client_id, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rowId, name, String(email).toLowerCase(), phone || null, role, clientId || null, hash, salt, now());
  } catch (err) {
    return res.status(409).json({ ok: false, error: 'Email already in use' });
  }
  res.status(201).json({ ok: true, person: db.prepare(`
    SELECT p.*, c.name AS client_name FROM people p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?
  `).get(rowId) });
});

app.get('/api/people/:id', requireAuth, (req, res) => {
  const person = db.prepare(`
    SELECT p.*, c.name AS client_name FROM people p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?
  `).get(req.params.id);
  if (!person) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, person: { ...publicPerson(person), client_name: person.client_name } });
});

app.patch('/api/people/:id', requireAuth, (req, res) => {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!person) return res.status(404).json({ ok: false, error: 'Not found' });
  const { name, phone, role, clientId } = req.body || {};
  db.prepare('UPDATE people SET name = ?, phone = ?, role = ?, client_id = ? WHERE id = ?')
    .run(name || person.name, phone ?? person.phone, role || person.role, clientId === undefined ? person.client_id : (clientId || null), person.id);
  res.json({ ok: true });
});

app.get('/api/events', requireAuth, (_req, res) => {
  const events = db.prepare(`
    SELECT e.*, c.name AS client_name
    FROM events e JOIN clients c ON c.id = e.client_id
    ORDER BY c.name, e.name
  `).all().map((e) => ({ ...e, summary: summarizeEvent(e), weekdays: eventWeekdays(e), times: eventTimes(e) }));
  res.json({ ok: true, events });
});

function parseEventBody(body) {
  const { clientId, name, kind, weekdays, times, onceDate, setupMin, timezone } = body || {};
  const slots = normalizeSlots(times);
  if (!clientId || !name || !slots.length) {
    return { error: 'clientId, name, and at least one start/end time required' };
  }
  const slotError = validateSlots(slots);
  if (slotError) return { error: slotError };
  const eventKind = kind === 'once' ? 'once' : 'recurring';
  const dayList = eventKind === 'recurring' ? parseList(weekdays, []).map(Number) : [];
  if (eventKind === 'recurring' && !dayList.length) {
    return { error: 'Pick at least one weekday for a recurring event' };
  }
  if (eventKind === 'once' && !onceDate) {
    return { error: 'Date required for a one-time event' };
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return { error: 'Unknown client' };
  const tz = timezone || client.timezone;
  const draft = {
    kind: eventKind,
    weekdays: JSON.stringify(dayList),
    times: JSON.stringify(slots),
    once_date: onceDate || null,
    timezone: tz
  };
  return {
    clientId, name, eventKind, dayList, slots, onceDate: onceDate || null,
    setupMin: Number(setupMin || 30), tz, draft, client
  };
}

app.post('/api/events', requireAuth, (req, res) => {
  const parsed = parseEventBody(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  const conflicts = findLocationConflicts(parsed.clientId, slotWindows(parsed.draft, parsed.tz), null);
  if (conflicts.length) {
    return res.status(409).json({ ok: false, error: `Overlaps "${conflicts[0].eventName}" on this client calendar`, conflicts });
  }
  const duration = minutesOf(parsed.slots[0].end) - minutesOf(parsed.slots[0].start);
  const rowId = id();
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, once_date, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(
      rowId, parsed.clientId, parsed.name, parsed.eventKind,
      JSON.stringify(parsed.dayList), JSON.stringify(parsed.slots), parsed.onceDate,
      parsed.dayList[0] ?? 0, parsed.slots[0].start, duration, parsed.setupMin,
      parsed.tz, now()
    );
  materialize(rowId);
  res.status(201).json({ ok: true, event: db.prepare('SELECT * FROM events WHERE id = ?').get(rowId) });
});

app.patch('/api/events/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  const parsed = parseEventBody(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  const conflicts = findLocationConflicts(parsed.clientId, slotWindows(parsed.draft, parsed.tz), existing.id);
  if (conflicts.length) {
    return res.status(409).json({ ok: false, error: `Overlaps "${conflicts[0].eventName}" on this client calendar`, conflicts });
  }
  const duration = minutesOf(parsed.slots[0].end) - minutesOf(parsed.slots[0].start);
  db.prepare(`UPDATE events SET client_id = ?, name = ?, kind = ?, weekdays = ?, times = ?, once_date = ?,
    weekday = ?, start_local = ?, duration_min = ?, setup_min = ?, timezone = ? WHERE id = ?`)
    .run(
      parsed.clientId, parsed.name, parsed.eventKind,
      JSON.stringify(parsed.dayList), JSON.stringify(parsed.slots), parsed.onceDate,
      parsed.dayList[0] ?? 0, parsed.slots[0].start, duration, parsed.setupMin,
      parsed.tz, existing.id
    );
  const assigned = db.prepare(`
    SELECT DISTINCT a.occurrence_id FROM assignments a
    JOIN occurrences o ON o.id = a.occurrence_id WHERE o.event_id = ?
  `).all(existing.id).map((r) => r.occurrence_id);
  if (assigned.length) {
    db.prepare(`DELETE FROM occurrences WHERE event_id = ? AND cancelled = 0 AND starts_at > ? AND id NOT IN (${assigned.map(() => '?').join(',')})`)
      .run(existing.id, now(), ...assigned);
  } else {
    db.prepare('DELETE FROM occurrences WHERE event_id = ? AND cancelled = 0 AND starts_at > ?').run(existing.id, now());
  }
  materialize(existing.id);
  res.json({ ok: true, event: db.prepare('SELECT * FROM events WHERE id = ?').get(existing.id) });
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const event = db.prepare(`
    SELECT e.*, c.name AS client_name FROM events e JOIN clients c ON c.id = e.client_id WHERE e.id = ?
  `).get(req.params.id);
  if (!event) return res.status(404).json({ ok: false, error: 'Not found' });
  materialize(event.id);
  const occurrences = db.prepare(`
    SELECT * FROM occurrences WHERE event_id = ? AND cancelled = 0 AND starts_at > ?
    ORDER BY starts_at LIMIT ?
  `).all(event.id, now() - 6 * 3600000, UPCOMING_LIMIT);
  const ids = occurrences.map((o) => o.id);
  let assigns = [];
  if (ids.length) {
    assigns = db.prepare(`
      SELECT a.*, p.name, p.email FROM assignments a JOIN people p ON p.id = a.person_id
      WHERE a.occurrence_id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
  }
  const byOcc = {};
  for (const a of assigns) {
    byOcc[a.occurrence_id] = byOcc[a.occurrence_id] || [];
    byOcc[a.occurrence_id].push(a);
  }
  res.json({
    ok: true,
    event: {
      ...event,
      weekdays: eventWeekdays(event),
      times: eventTimes(event),
      summary: summarizeEvent(event)
    },
    occurrences: occurrences.map((o) => ({ ...o, assignments: byOcc[o.id] || [] }))
  });
});

app.get('/api/calendar', requireAuth, (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ ok: false, error: 'year and month required' });
  }
  const fromTs = Date.UTC(year, month - 1, 1) - 2 * 86400000;
  const untilTs = Date.UTC(year, month, 1) + 2 * 86400000;
  materializeRange(fromTs, untilTs);
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const occurrences = db.prepare(`
    SELECT o.id, o.event_id, o.starts_at, o.ends_at, o.status,
           e.name AS event_name, e.client_id, c.name AS client_name
    FROM occurrences o
    JOIN events e ON e.id = o.event_id
    JOIN clients c ON c.id = e.client_id
    WHERE o.cancelled = 0 AND o.starts_at >= ? AND o.starts_at < ?
    ORDER BY o.starts_at
  `).all(monthStart, monthEnd);
  res.json({ ok: true, year, month, occurrences });
});

app.post('/api/occurrences/:id/assign', requireAuth, (req, res) => {
  const occ = db.prepare('SELECT * FROM occurrences WHERE id = ?').get(req.params.id);
  if (!occ) return res.status(404).json({ ok: false, error: 'Not found' });
  const { personId, duty } = req.body || {};
  if (!personId || !duty) return res.status(400).json({ ok: false, error: 'personId and duty required' });
  const existing = db.prepare('SELECT id FROM assignments WHERE occurrence_id = ? AND duty = ?').get(occ.id, duty);
  if (existing) db.prepare('UPDATE assignments SET person_id = ? WHERE id = ?').run(personId, existing.id);
  else db.prepare('INSERT INTO assignments (id, occurrence_id, person_id, duty, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id(), occ.id, personId, duty, now());
  res.json({ ok: true });
});

app.post('/api/occurrences/:id/cancel', requireAuth, (req, res) => {
  const occ = db.prepare('SELECT * FROM occurrences WHERE id = ?').get(req.params.id);
  if (!occ) return res.status(404).json({ ok: false, error: 'Not found' });
  db.prepare(`UPDATE occurrences SET cancelled = 1, status = 'cancelled' WHERE id = ?`).run(occ.id);
  res.json({ ok: true });
});

function endpointRow(id) {
  const row = db.prepare(`
    SELECT e.*, c.name AS client_name, p.name AS person_name, p.email AS person_email
    FROM endpoints e
    LEFT JOIN clients c ON c.id = e.client_id
    LEFT JOIN people p ON p.id = e.person_id
    WHERE e.id = ?
  `).get(id);
  return row ? decorateEndpoint(row) : null;
}

const liveCompanions = new Map();
const sseClients = new Set();

function isConnected(endpoint) {
  return Boolean(endpoint && endpoint.machine_id && liveCompanions.has(endpoint.machine_id));
}

function decorateEndpoint(row) {
  if (!row) return row;
  return { ...row, connected: isConnected(row) };
}

function assignedStatus(endpoint, connected) {
  if (!endpoint.client_id) return 'unassigned';
  return connected ? 'online' : 'offline';
}

function listEndpoints() {
  return db.prepare(`
    SELECT e.*, c.name AS client_name, p.name AS person_name
    FROM endpoints e
    LEFT JOIN clients c ON c.id = e.client_id
    LEFT JOIN people p ON p.id = e.person_id
    ORDER BY CASE WHEN e.status = 'online' THEN 0 ELSE 1 END, e.name
  `).all().map(decorateEndpoint);
}

function persistConnection(endpoint, connected) {
  const status = assignedStatus(endpoint, connected);
  if (connected) {
    db.prepare('UPDATE endpoints SET last_seen_at = ?, status = ? WHERE id = ?')
      .run(now(), status, endpoint.id);
  } else {
    db.prepare('UPDATE endpoints SET status = ? WHERE id = ?').run(status, endpoint.id);
  }
}

function presenceList() {
  return listEndpoints().map((e) => ({
    id: e.id,
    name: e.name,
    code: e.code,
    connected: e.connected,
    last_seen_at: e.last_seen_at,
    client_id: e.client_id,
    client_name: e.client_name
  }));
}

function broadcastEndpoints() {
  const payload = `event: endpoints\ndata: ${JSON.stringify({ type: 'endpoints', endpoints: presenceList() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

function attachLiveCompanion(socket, actor, leftover) {
  let buf = leftover || '';
  let machineId = null;
  let pingTimer = null;
  let awaitingPong = false;
  let helloTimer = setTimeout(() => socket.destroy(), 8000);

  const cleanup = () => {
    clearTimeout(helloTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (machineId) {
      const cur = liveCompanions.get(machineId);
      if (cur && cur.socket === socket) {
        liveCompanions.delete(machineId);
        const endpoint = db.prepare('SELECT * FROM endpoints WHERE machine_id = ?').get(machineId);
        if (endpoint) {
          persistConnection(endpoint, false);
          broadcastEndpoints();
        }
      }
    }
  };

  const startPinging = () => {
    const ping = () => {
      if (socket.destroyed) return;
      if (awaitingPong) {
        socket.destroy();
        return;
      }
      awaitingPong = true;
      try { socket.write('PING\n'); } catch (_) { socket.destroy(); }
    };
    pingTimer = setInterval(ping, 5000);
    ping();
  };

  const onLine = (line) => {
    if (!machineId) {
      if (!line.startsWith('HELLO ')) {
        socket.destroy();
        return;
      }
      machineId = line.slice(6).trim();
      if (!machineId) {
        socket.destroy();
        return;
      }
      const endpoint = db.prepare('SELECT * FROM endpoints WHERE machine_id = ?').get(machineId);
      if (!endpoint) {
        try { socket.write('ERROR unknown endpoint\n'); } catch (_) {}
        socket.destroy();
        return;
      }
      const prev = liveCompanions.get(machineId);
      liveCompanions.set(machineId, { socket, endpointId: endpoint.id, personId: actor.person_id });
      if (prev && prev.socket !== socket) {
        try { prev.socket.destroy(); } catch (_) {}
      }
      db.prepare('UPDATE endpoints SET person_id = ? WHERE id = ?').run(actor.person_id, endpoint.id);
      persistConnection(endpoint, true);
      broadcastEndpoints();
      clearTimeout(helloTimer);
      startPinging();
      return;
    }
    if (line === 'PONG') awaitingPong = false;
  };

  const drain = () => {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };

  socket.setKeepAlive(true, 5000);
  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    drain();
  });
  socket.on('close', cleanup);
  socket.on('error', () => socket.destroy());
  drain();
}

app.get('/api/endpoints/stream', requireAuth, (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const keep = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(keep);
    sseClients.delete(res);
  });
});

app.get('/api/endpoints', requireAuth, (_req, res) => {
  res.json({ ok: true, endpoints: listEndpoints() });
});

app.post('/api/endpoints', requireAuth, (_req, res) => {
  res.status(403).json({ ok: false, error: 'Endpoints are created automatically when a companion app signs in' });
});

app.get('/api/endpoints/:id', requireAuth, (req, res) => {
  const endpoint = endpointRow(req.params.id);
  if (!endpoint) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, endpoint });
});

app.patch('/api/endpoints/:id', requireAuth, (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!endpoint) return res.status(404).json({ ok: false, error: 'Not found' });
  const { clientId, notes } = req.body || {};
  let nextClient = endpoint.client_id;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'clientId')) {
    nextClient = clientId || null;
    if (nextClient) {
      const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(nextClient);
      if (!client) return res.status(400).json({ ok: false, error: 'Unknown client' });
    }
  }
  const nextNotes = notes === undefined ? endpoint.notes : (notes || null);
  const connected = isConnected(endpoint);
  const status = assignedStatus({ ...endpoint, client_id: nextClient }, connected);
  db.prepare('UPDATE endpoints SET client_id = ?, notes = ?, status = ? WHERE id = ?')
    .run(nextClient, nextNotes, status, endpoint.id);
  broadcastEndpoints();
  res.json({ ok: true, endpoint: endpointRow(endpoint.id) });
});

app.delete('/api/endpoints/:id', requireAuth, (req, res) => {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(req.params.id);
  if (!endpoint) return res.status(404).json({ ok: false, error: 'Not found' });
  if (isConnected(endpoint)) {
    return res.status(409).json({ ok: false, error: 'Disconnect the companion before removing this endpoint' });
  }
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(endpoint.id);
  broadcastEndpoints();
  res.json({ ok: true });
});

app.post('/api/companion/register', requireAuth, (req, res) => {
  const { machineId, hostname, os, appVersion, name } = req.body || {};
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
  const existing = db.prepare('SELECT * FROM endpoints WHERE machine_id = ?').get(machineId);
  const displayName = name || hostname || 'Companion';
  const ts = now();
  if (!existing) {
    const rowId = id();
    const code = 'EP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO endpoints
      (id, client_id, person_id, name, kind, status, code, notes, machine_id, hostname, os, app_version, last_seen_at, created_at)
      VALUES (?, NULL, ?, ?, 'companion', 'unassigned', ?, NULL, ?, ?, ?, ?, NULL, ?)`)
      .run(rowId, req.actor.person_id, displayName, code, machineId, hostname || null, os || null, appVersion || null, ts);
    broadcastEndpoints();
    const created = endpointRow(rowId);
    return res.status(201).json({
      ok: true,
      endpointId: created.id,
      code: created.code,
      status: created.status,
      clientId: created.client_id,
      endpoint: created
    });
  }
  const status = assignedStatus(existing, isConnected(existing));
  db.prepare(`UPDATE endpoints SET person_id = ?, name = ?, hostname = ?, os = ?, app_version = ?, status = ?
    WHERE id = ?`)
    .run(req.actor.person_id, displayName, hostname || existing.hostname, os || existing.os,
      appVersion || existing.app_version, status, existing.id);
  broadcastEndpoints();
  const updated = endpointRow(existing.id);
  res.json({
    ok: true,
    endpointId: updated.id,
    code: updated.code,
    status: updated.status,
    clientId: updated.client_id,
    endpoint: updated
  });
});

app.post('/api/companion/offline', requireAuth, (req, res) => {
  const { machineId } = req.body || {};
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
  const existing = db.prepare('SELECT * FROM endpoints WHERE machine_id = ?').get(machineId);
  if (!existing) return res.status(404).json({ ok: false, error: 'Unknown endpoint' });
  const live = liveCompanions.get(machineId);
  if (live) {
    try { live.socket.destroy(); } catch (_) {}
  } else {
    persistConnection(existing, false);
    broadcastEndpoints();
  }
  res.json({ ok: true, endpoint: endpointRow(existing.id) });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get(['/', '/app', '/app/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Asaphops http://localhost:${PORT}`);
  console.log(`SQLite   ${DB_PATH}`);
  if (seeded) console.log('Demo     ops@asaphops.local / asaphops');
});

httpServer.on('upgrade', (req, socket, head) => {
  const pathName = String(req.url || '').split('?')[0];
  if (pathName !== '/api/companion/live') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const actor = actorFrom(req);
  if (!actor) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: asaphops-live\r\nConnection: Upgrade\r\n\r\n');
  attachLiveCompanion(socket, actor, head && head.length ? head.toString('utf8') : '');
});
