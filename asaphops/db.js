'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  role TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id),
  password_hash TEXT,
  password_salt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recurring',
  weekdays TEXT NOT NULL DEFAULT '[0]',
  times TEXT NOT NULL DEFAULT '[{"start":"10:00","end":"11:15"}]',
  once_date TEXT,
  weekday INTEGER,
  start_local TEXT,
  duration_min INTEGER NOT NULL DEFAULT 75,
  setup_min INTEGER NOT NULL DEFAULT 30,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(event_id, starts_at)
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  duty TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(occurrence_id, duty)
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  person_id TEXT REFERENCES people(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'companion',
  status TEXT NOT NULL DEFAULT 'unassigned',
  code TEXT UNIQUE,
  notes TEXT,
  machine_id TEXT UNIQUE,
  hostname TEXT,
  os TEXT,
  app_version TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  expires_at INTEGER NOT NULL
);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function migrateEndpoints(db) {
  const cols = tableColumns(db, 'endpoints');
  if (!cols.length) return;
  const names = cols.map((c) => c.name);
  const clientCol = cols.find((c) => c.name === 'client_id');
  const needsRebuild = Boolean(clientCol && clientCol.notnull === 1);

  if (needsRebuild) {
    db.exec(`
      CREATE TABLE endpoints_new (
        id TEXT PRIMARY KEY,
        client_id TEXT REFERENCES clients(id),
        person_id TEXT REFERENCES people(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'companion',
        status TEXT NOT NULL DEFAULT 'unassigned',
        code TEXT UNIQUE,
        notes TEXT,
        machine_id TEXT UNIQUE,
        hostname TEXT,
        os TEXT,
        app_version TEXT,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    const selectCols = [
      'id',
      'client_id',
      names.includes('person_id') ? 'person_id' : 'NULL AS person_id',
      'name',
      'kind',
      'status',
      'code',
      'notes',
      names.includes('machine_id') ? 'machine_id' : 'NULL AS machine_id',
      names.includes('hostname') ? 'hostname' : 'NULL AS hostname',
      names.includes('os') ? 'os' : 'NULL AS os',
      names.includes('app_version') ? 'app_version' : 'NULL AS app_version',
      names.includes('last_seen_at') ? 'last_seen_at' : 'NULL AS last_seen_at',
      'created_at'
    ];
    db.exec(`INSERT INTO endpoints_new (id, client_id, person_id, name, kind, status, code, notes, machine_id, hostname, os, app_version, last_seen_at, created_at)
      SELECT ${selectCols.join(', ')} FROM endpoints`);
    db.exec('DROP TABLE endpoints');
    db.exec('ALTER TABLE endpoints_new RENAME TO endpoints');
  } else {
    const add = (name, sql) => {
      if (!names.includes(name)) db.exec(sql);
    };
    add('person_id', 'ALTER TABLE endpoints ADD COLUMN person_id TEXT REFERENCES people(id)');
    add('machine_id', 'ALTER TABLE endpoints ADD COLUMN machine_id TEXT');
    add('hostname', 'ALTER TABLE endpoints ADD COLUMN hostname TEXT');
    add('os', 'ALTER TABLE endpoints ADD COLUMN os TEXT');
    add('app_version', 'ALTER TABLE endpoints ADD COLUMN app_version TEXT');
    add('last_seen_at', 'ALTER TABLE endpoints ADD COLUMN last_seen_at INTEGER');
  }

  db.prepare(`UPDATE endpoints SET status = 'offline' WHERE status IN ('ready', 'revoked') AND client_id IS NOT NULL AND client_id != ''`).run();
  db.prepare(`UPDATE endpoints SET status = 'unassigned' WHERE (client_id IS NULL OR client_id = '') AND status != 'online'`).run();
}

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  const add = (name, sql) => {
    if (!cols.includes(name)) db.exec(sql);
  };
  add('kind', `ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'recurring'`);
  add('weekdays', `ALTER TABLE events ADD COLUMN weekdays TEXT`);
  add('times', `ALTER TABLE events ADD COLUMN times TEXT`);
  add('once_date', `ALTER TABLE events ADD COLUMN once_date TEXT`);
  db.prepare(`UPDATE events SET weekdays = '[' || COALESCE(weekday, 0) || ']' WHERE weekdays IS NULL OR weekdays = ''`).run();
  db.prepare(`UPDATE events SET times = '["' || COALESCE(start_local, '10:00') || '"]' WHERE times IS NULL OR times = ''`).run();
  for (const row of db.prepare('SELECT id, times, duration_min, start_local FROM events').all()) {
    let parsed;
    try { parsed = JSON.parse(row.times); } catch (_) { parsed = [row.start_local || '10:00']; }
    if (!Array.isArray(parsed)) continue;
    if (parsed.length && typeof parsed[0] === 'object' && parsed[0] && parsed[0].start) continue;
    const duration = row.duration_min || 75;
    const slots = parsed.map((start) => {
      const [h, m] = String(start).split(':').map(Number);
      const endMin = h * 60 + m + duration;
      const eh = String(Math.floor(endMin / 60) % 24).padStart(2, '0');
      const em = String(endMin % 60).padStart(2, '0');
      return { start: String(start).slice(0, 5), end: `${eh}:${em}` };
    });
    db.prepare('UPDATE events SET times = ? WHERE id = ?').run(JSON.stringify(slots), row.id);
  }
  migrateEndpoints(db);
}

function open(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM clients').get().n > 0) return false;
  const now = Date.now();
  const today = new Date();

  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const nextDow = (dow) => {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
    while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
    return d;
  };

  const north = crypto.randomUUID();
  const south = crypto.randomUUID();
  db.prepare('INSERT INTO clients (id, name, city, timezone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(north, 'North Campus', 'Austin', 'America/Chicago', 'Main sanctuary, 900 seats', now);
  db.prepare('INSERT INTO clients (id, name, city, timezone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(south, 'South Campus', 'Austin', 'America/Chicago', 'Gym / overflow sanctuary', now);

  // Login: ops@asaphops.local / asaphops
  const ops = hashPassword('asaphops');
  const people = [
    [crypto.randomUUID(), 'Maya Chen', 'ops@asaphops.local', 'operator', null, ops],
    [crypto.randomUUID(), 'Alex Rivera', 'alex@asaphops.local', 'engineer', north, null],
    [crypto.randomUUID(), 'Sam Okonkwo', 'sam@asaphops.local', 'engineer', south, null],
    [crypto.randomUUID(), 'Riley Nguyen', 'riley@asaphops.local', 'volunteer', north, null],
    [crypto.randomUUID(), 'Jordan Patel', 'jpatel@asaphops.local', 'volunteer', south, null]
  ];
  for (const [id, name, email, role, clientId, pw] of people) {
    db.prepare(`INSERT INTO people (id, name, email, phone, role, client_id, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(id, name, String(email).toLowerCase(), role, clientId, pw ? pw.hash : null, pw ? pw.salt : null, now);
  }

  const TZ = 'America/Chicago';
  const timeSlot = (start, end) => JSON.stringify([{ start, end }]);

  // Recurring: ALL Sundays (weekday 0); non-overlapping per client.
  // North
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'recurring', '[0]', ?, 0, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), north, 'Sunday Soundcheck', timeSlot('09:00', '09:45'), '09:00', 45, TZ, now);
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'recurring', '[0]', ?, 0, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), north, 'Sunday Worship Service', timeSlot('10:00', '11:15'), '10:00', 75, TZ, now);
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'recurring', '[0]', ?, 0, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), north, 'Sunday Community Session', timeSlot('11:30', '12:30'), '11:30', 60, TZ, now);

  // South
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'recurring', '[0]', ?, 0, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), south, 'Sunday Soundcheck', timeSlot('09:15', '10:00'), '09:15', 45, TZ, now);
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'recurring', '[0]', ?, 0, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), south, 'Sunday Worship Service', timeSlot('10:30', '11:45'), '10:30', 75, TZ, now);

  // One-time: just a couple non-recurring events during the week.
  const onceWed = ymd(nextDow(3)); // Wednesday
  const onceFri = ymd(nextDow(5)); // Friday
  // North one-time
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, once_date, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'once', '[0]', ?, 0, ?, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), north, 'Midweek Tech Practice', timeSlot('18:00', '19:00'), onceWed, '18:00', 60, TZ, now);
  // South one-time
  db.prepare(`INSERT INTO events (id, client_id, name, kind, weekdays, times, weekday, once_date, start_local, duration_min, setup_min, timezone, enabled, created_at)
    VALUES (?, ?, ?, 'once', '[0]', ?, 0, ?, ?, ?, 30, ?, 1, ?)`)
    .run(crypto.randomUUID(), south, 'Volunteer Training', timeSlot('17:30', '18:45'), onceFri, '17:30', 75, TZ, now);

  return true;
}

module.exports = { open, seed, hashPassword, verifyPassword };
