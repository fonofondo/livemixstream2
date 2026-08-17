'use strict';

const { id, now } = require('./util');

function partsInZone(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[map.weekday],
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function zonedUtc(timeZone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const local = partsInZone(guess, timeZone);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  const got = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return guess + (wanted - got);
}

function addDays(year, month, day, n) {
  const dt = new Date(Date.UTC(year, month - 1, day + n));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function nextOccurrences(template, fromTs, untilTs) {
  const [hh, mm] = template.start_local.split(':').map(Number);
  const out = [];
  let cursor = fromTs - 2 * 86400000;
  const end = untilTs + 2 * 86400000;
  while (cursor <= end) {
    const p = partsInZone(cursor, template.timezone);
    if (p.weekday === template.weekday) {
      const start = zonedUtc(template.timezone, p.year, p.month, p.day, hh, mm);
      if (start >= fromTs && start <= untilTs) out.push(start);
      cursor += 6 * 86400000;
    }
    cursor += 86400000;
  }
  return out;
}

function materialize(db, orgId, horizonDays = 21) {
  const templates = db.prepare('SELECT * FROM service_templates WHERE org_id = ? AND enabled = 1').all(orgId);
  const fromTs = now() - 12 * 3600000;
  const untilTs = now() + horizonDays * 86400000;
  let created = 0;
  for (const tpl of templates) {
    for (const start of nextOccurrences(tpl, fromTs, untilTs)) {
      const exists = db.prepare(`
        SELECT id FROM service_events WHERE template_id = ? AND starts_at = ?
      `).get(tpl.id, start);
      if (exists) continue;
      const ends = start + tpl.duration_min * 60000;
      const setup = start - tpl.setup_min * 60000;
      const teardown = ends + tpl.teardown_min * 60000;
      db.prepare(`INSERT INTO service_events
        (id, org_id, template_id, location_id, room_id, name, starts_at, ends_at, setup_at, teardown_at, status, cancelled, timezone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`)
        .run(id(), orgId, tpl.id, tpl.location_id, tpl.room_id, tpl.name, start, ends, setup, teardown, tpl.timezone, now());
      created++;
    }
  }
  return created;
}

function conflicts(db, orgId, { locationId, roomId, startsAt, endsAt, excludeId = null }) {
  const rows = db.prepare(`
    SELECT * FROM service_events
    WHERE org_id = ? AND cancelled = 0 AND location_id = ?
      AND starts_at < ? AND ends_at > ?
      ${excludeId ? 'AND id != ?' : ''}
  `).all(...(excludeId ? [orgId, locationId, endsAt, startsAt, excludeId] : [orgId, locationId, endsAt, startsAt]));
  return rows.filter((e) => !roomId || !e.room_id || e.room_id === roomId);
}

module.exports = {
  partsInZone,
  zonedUtc,
  addDays,
  nextOccurrences,
  materialize,
  conflicts
};
