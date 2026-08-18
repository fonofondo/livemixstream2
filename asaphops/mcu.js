'use strict';

const STRIP_COUNT = 8;
const SURFACE_COUNT = 4;
const CHANNEL_COUNT = STRIP_COUNT * SURFACE_COUNT;
const SURFACE_NAMES = ['MCU', 'XT1', 'XT2', 'XT3'];
const MASTER_STRIP = 8;
const MUTE_NOTE = 16;
const SOLO_NOTE = 8;
const SELECT_NOTE = 24;
const REC_NOTE = 0;
const SHIFT_NOTE = 70;
const FADER_TOUCH_NOTE = 104;
const BANK_LEFT_NOTE = 46;
const BANK_RIGHT_NOTE = 47;
const RAMP_HZ = 50;
const WAIT_TICKS = 30;
const PAGE_WAIT_TICKS = 55;
const LCD_HOLD_TICKS = 30;
const FADER_HOLD_TICKS = 45;
const SERIAL = Buffer.from('ASAPH01', 'ascii');

const FADER_KNOTS = [
  { midi: 0, db: -144 },
  { midi: 1311, db: -60 },
  { midi: 1966, db: -55 },
  { midi: 2621, db: -50 },
  { midi: 3277, db: -45 },
  { midi: 4096, db: -40 },
  { midi: 5079, db: -35 },
  { midi: 6062, db: -30 },
  { midi: 7209, db: -25 },
  { midi: 8519, db: -20 },
  { midi: 9830, db: -15 },
  { midi: 11304, db: -10 },
  { midi: 13106, db: -5 },
  { midi: 14880, db: 0 },
  { midi: 15728, db: 5 },
  { midi: 16383, db: 10 }
];

function midiToDb(midi) {
  midi = Math.max(0, Math.min(16383, midi | 0));
  for (let i = 1; i < FADER_KNOTS.length; i++) {
    if (midi <= FADER_KNOTS[i].midi) {
      const span = FADER_KNOTS[i].midi - FADER_KNOTS[i - 1].midi;
      const t = span > 0 ? (midi - FADER_KNOTS[i - 1].midi) / span : 0;
      return FADER_KNOTS[i - 1].db + t * (FADER_KNOTS[i].db - FADER_KNOTS[i - 1].db);
    }
  }
  return 10;
}

function dbToMidi(db) {
  if (db <= -144) return 0;
  if (db >= 10) return 16383;
  for (let i = 1; i < FADER_KNOTS.length; i++) {
    if (db <= FADER_KNOTS[i].db) {
      const span = FADER_KNOTS[i].db - FADER_KNOTS[i - 1].db;
      const t = span > 0 ? (db - FADER_KNOTS[i - 1].db) / span : 0;
      return Math.max(0, Math.min(16383, Math.round(FADER_KNOTS[i - 1].midi + t * (FADER_KNOTS[i].midi - FADER_KNOTS[i - 1].midi))));
    }
  }
  return 16383;
}

function mcuResponse(c) {
  return [
    0x7F & (c[0] + (c[1] ^ 0x0A) - c[3]),
    0x7F & ((c[2] >> 4) ^ (c[0] + c[3])),
    0x7F & ((c[3] - (c[2] << 2)) ^ (c[0] | c[1])),
    0x7F & (c[1] - c[2] + (0xF0 ^ (c[3] << 4)))
  ];
}

function charsToString(chars) {
  return String(chars || '').replace(/\0/g, '').slice(0, 7).trim();
}

function lcdTopLine(lcd) {
  return Array.isArray(lcd) ? lcd.slice(0, 56).join('') : '';
}

function lcdHasSplash(line) {
  const s = String(line || '').toLowerCase();
  return /initializ/.test(s) || /please\s*wait/.test(s) || (/lizing/.test(s) && /wait/.test(s));
}

function lcdBannerSpan(line) {
  const s = String(line || '');
  const re = /(?:initializ|lizing)[\s\S]{0,48}?wait\.+|\.{0,3}\s*please\s*wait\.+|initializ[a-z.]*/ig;
  let start = Infinity;
  let end = -1;
  let m;
  while ((m = re.exec(s))) {
    start = Math.min(start, m.index);
    end = Math.max(end, m.index + m[0].length);
  }
  if (!isFinite(start) || end < 0) return null;
  return { start, end };
}

function isSplashTrackName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (/^[.\-…]+$/.test(n)) return true;
  return /^(lizing\.?|\.{0,3}\s*plea.*|se\s*wait.*|please.*|initial.*)$/i.test(n);
}

function usableLcdStripName(lcd, strip, rawTop) {
  const name = charsToString(rawTop);
  if (!name || isSplashTrackName(name)) return '';
  const line = lcdTopLine(lcd);
  if (!lcdHasSplash(line)) return name;
  const span = lcdBannerSpan(line);
  if (!span) return name;
  const a = strip * 7;
  const b = a + 7;
  if (a < span.end && b > span.start) return '';
  return name;
}

const SYSEX_CMDS = {
  0x00: 'host query',
  0x01: 'connection query',
  0x02: 'connection reply',
  0x03: 'connection confirm',
  0x0F: 'offline',
  0x12: 'LCD',
  0x13: 'version request',
  0x14: 'version reply'
};

const NOTE_NAMES = {
  46: 'Bank Left',
  47: 'Bank Right',
  48: 'Channel Left',
  49: 'Channel Right',
  70: 'Shift',
  71: 'Option',
  72: 'Control',
  73: 'Alt'
};

function noteName(note) {
  if (NOTE_NAMES[note]) return NOTE_NAMES[note];
  if (note < STRIP_COUNT) return `Rec ${note + 1}`;
  if (note >= SOLO_NOTE && note < SOLO_NOTE + STRIP_COUNT) return `Solo ${note - SOLO_NOTE + 1}`;
  if (note >= MUTE_NOTE && note < MUTE_NOTE + STRIP_COUNT) return `Mute ${note - MUTE_NOTE + 1}`;
  if (note >= SELECT_NOTE && note < SELECT_NOTE + STRIP_COUNT) return `Select ${note - SELECT_NOTE + 1}`;
  if (note >= 32 && note < 40) return `VPot ${note - 31}`;
  if (note >= 104 && note <= 112) return `Touch ${note - 104}`;
  return `note ${note}`;
}

function describeMidi(bytes) {
  if (!bytes || !bytes.length) return 'empty';
  const b0 = bytes[0];
  if (b0 === 0xF0 && bytes.length >= 6 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x66) {
    const cmd = bytes[5];
    const name = SYSEX_CMDS[cmd] || `cmd 0x${cmd.toString(16)}`;
    if (cmd === 0x12 && bytes.length > 7) {
      const off = bytes[6];
      const chars = [...bytes.slice(7, bytes[bytes.length - 1] === 0xF7 ? -1 : undefined)]
        .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.'))
        .join('');
      return `sysex LCD @${off} "${chars}"`;
    }
    return `sysex ${name} (device 0x${bytes[4].toString(16)})`;
  }
  if (b0 === 0xF0) return `sysex ${bytes.length} bytes`;
  if ((b0 & 0xF0) === 0xE0) {
    const ch = (b0 & 0x0f) + 1;
    const v = (bytes[1] || 0) | ((bytes[2] || 0) << 7);
    const who = ch === 9 ? 'master' : `strip ${ch}`;
    return `pitch ${who} ${v}`;
  }
  if ((b0 & 0xF0) === 0xD0) {
    const v = bytes[1] || 0;
    return `meter strip ${(v >> 4) + 1} nibble=0x${(v & 0xf).toString(16)}`;
  }
  if ((b0 & 0xF0) === 0xB0) {
    const cc = bytes[1] || 0;
    const val = bytes[2] || 0;
    if (cc >= 0x30 && cc <= 0x37) return `vpot ring ${cc - 0x2f} val=${val}`;
    if (cc >= 0x40 && cc <= 0x4b) {
      const ch = val >= 32 && val < 127 ? String.fromCharCode(val) : '.';
      return `7-seg #${cc - 0x40} '${ch}' val=${val}`;
    }
    return `CC ch${(b0 & 0x0f) + 1} #${cc} val=${val}`;
  }
  if ((b0 & 0xF0) === 0x90 || (b0 & 0xF0) === 0x80) {
    const note = bytes[1] || 0;
    const vel = bytes[2] || 0;
    const on = (b0 & 0xF0) === 0x90 && vel > 0;
    const led = vel === 1 ? 'blink' : vel >= 64 ? 'on' : 'off';
    const name = noteName(note);
    if (note < STRIP_COUNT) return `${on ? 'LED' : 'off'} ${name} vel=${vel} (${led})`;
    return `${on ? 'on' : 'off'} ${name} vel=${vel}`;
  }
  return `status 0x${b0.toString(16)} ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
}

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

function pageNamesMatch(a, b) {
  let compared = 0;
  let hits = 0;
  for (let i = 0; i < STRIP_COUNT; i++) {
    const x = String((a && a[i] && a[i].name) || '').toLowerCase();
    const y = String((b && b[i] && b[i].name) || '').toLowerCase();
    if (!x && !y) continue;
    compared += 1;
    if (x === y || (x && y && (x.startsWith(y) || y.startsWith(x)))) hits += 1;
  }
  if (compared === 0) return true;
  return hits >= Math.max(5, compared - 1);
}

function emptySlot() {
  return { name: '', midi: -1, rec: false, listen: false };
}

function emptyStrip() {
  return {
    top: '       ',
    bottom: '       ',
    midi: -1,
    rec: false,
    listen: false,
    solo: false,
    mute: false,
    selected: false
  };
}

function emptyUnit(index) {
  return {
    index,
    name: SURFACE_NAMES[index] || `XT${index}`,
    deviceId: index === 0 ? 0x14 : 0x15,
    lcd: Array(112).fill(' '),
    strips: Array.from({ length: STRIP_COUNT }, emptyStrip),
    challenge: [0, 0, 0, 0],
    lastQueryAt: 0,
    hostLinked: false
  };
}

class MackieControl {
  constructor(sendMidi) {
    this.sendMidi = sendMidi;
    this.onChange = null;
    this.deviceId = 0x14;
    this.challenge = [0, 0, 0, 0];
    this.units = Array.from({ length: SURFACE_COUNT }, (_, i) => emptyUnit(i));
    this.lcd = this.units[0].lcd;
    this.strips = this.units[0].strips;
    this.pages = [];
    this.pageIndex = 0;
    this.pageTarget = null;
    this.scan = 'idle';
    this.homeTries = 0;
    this.preHomeSig = '';
    this.lcdHoldSig = '';
    this.lcdHoldTicks = 0;
    this.faderHoldTicks = 0;
    this.masterMidi = -1;
    this.waitTicks = 0;
    this.touchingIndex = -1;
    this.lastLocalIndex = null;
    this.faderEcho = new Map();
    this.bankEchoUntil = 0;
    this.bankSettlingUntil = 0;
    this.pendingIndex = -1;
    this.pendingSurface = 0;
    this.pendingMidi = -1;
    this.pendingTouch = false;
    this.pendingIsMaster = false;
    this.sentTouch = false;
    this.pendingStrip = null;
    this.shiftHeld = false;
    this.listenMode = 'none';
    this.status = 'stopped';
    this.hostLinked = false;
    this.lastHostAt = 0;
    this.lastQueryAt = 0;
    this.timer = null;
    this.messages = [];
    this.inCount = 0;
    this.outCount = 0;
  }

  start() {
    this.stop();
    this.messages = [];
    this.inCount = 0;
    this.outCount = 0;
    this.status = 'waiting for DAW Mackie Control';
    this.units = Array.from({ length: SURFACE_COUNT }, (_, i) => emptyUnit(i));
    this.lcd = this.units[0].lcd;
    this.strips = this.units[0].strips;
    this.sendHostConnectionQuery();
    this.timer = setInterval(() => this.tick(), Math.round(1000 / RAMP_HZ));
    this.emitChange();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hostLinked = false;
    this.scan = 'idle';
    this.pageTarget = null;
    this.status = 'stopped';
    if (this.shiftHeld) {
      this.sendShift(false);
      this.shiftHeld = false;
    }
    this.pendingStrip = null;
  }

  requestScan() {
    this.sendHostConnectionQuery();
    this.requestSurfaceRefresh();
  }

  bankPage(dir) {
    if (this.scan !== 'idle') return;
    this.sendNoteBang(dir === 'right' ? BANK_RIGHT_NOTE : BANK_LEFT_NOTE, 0);
    this.emitChange();
  }

  focusPage() {}

  setTrackDb(index, db, touching) {
    this.setTrackMidi(index, dbToMidi(db), touching);
  }

  setMasterDb(db, touching) {
    this.setMasterMidi(dbToMidi(db), touching);
  }

  setTrackMidi(index, midi, touching) {
    const mapped = this.mapTrackIndex(index);
    if (!mapped) return;
    const unit = this.units[mapped.page];
    this.pendingIsMaster = false;
    this.pendingSurface = mapped.page;
    this.pendingIndex = mapped.strip;
    this.pendingMidi = Math.max(0, Math.min(16383, midi | 0));
    this.pendingTouch = Boolean(touching);
    unit.strips[mapped.strip].midi = this.pendingMidi;
    this.noteLocalFader(index, this.pendingMidi);
  }

  setMasterMidi(midi, touching) {
    this.pendingIsMaster = true;
    this.pendingIndex = -1;
    this.pendingMidi = Math.max(0, Math.min(16383, midi | 0));
    this.pendingTouch = Boolean(touching);
    this.masterMidi = this.pendingMidi;
    this.noteLocalFader(-2, this.pendingMidi);
  }

  noteLocalFader(index, midi) {
    this.lastLocalIndex = index;
    this.faderEcho.set(index, { midi, until: Date.now() + 400 });
    this.bankEchoUntil = Date.now() + 220;
  }

  shouldApplyRemoteFader(index, midi) {
    const now = Date.now();
    if (this.touchingIndex === index) return false;
    const held = this.faderEcho.get(index);
    if (held && now < held.until) {
      if (Math.abs(midi - held.midi) > 96) return false;
      this.faderEcho.delete(index);
    }
    if (now < this.bankEchoUntil && this.lastLocalIndex != null && index !== this.lastLocalIndex)
      return false;
    return true;
  }

  setTrackRec(index, armed) {
    const mapped = this.mapTrackIndex(index);
    if (!mapped) return;
    const strip = this.units[mapped.page].strips[mapped.strip];
    if (armed == null) armed = !strip.rec;
    strip.rec = Boolean(armed);
    this.pendingSurface = mapped.page;
    this.pendingStrip = { index: mapped.strip, listen: false, surface: mapped.page };
    this.emitChange();
  }

  setListenMode(mode) {
    this.listenMode = mode === 'shift-rec' ? 'shift-rec' : 'none';
    this.emitChange();
  }

  setTrackListen(index, on) {
    const mapped = this.mapTrackIndex(index);
    if (!mapped) return;
    const strip = this.units[mapped.page].strips[mapped.strip];
    if (on == null) on = !strip.listen;
    strip.listen = Boolean(on);
    this.pendingSurface = mapped.page;
    if (this.listenMode === 'shift-rec')
      this.pendingStrip = { index: mapped.strip, listen: true, surface: mapped.page };
    this.emitChange();
  }

  snapshot() {
    const tracks = [];
    const pages = this.units.map((unit, p) => {
      const pageTracks = [];
      for (let i = 0; i < STRIP_COUNT; i++) {
        const s = unit.strips[i];
        const name = this.stripTrackName(p, i) || `Ch ${p * STRIP_COUNT + i + 1}`;
        const row = {
          index: p * STRIP_COUNT + i,
          page: p,
          strip: i,
          live: true,
          name,
          known: s.midi >= 0,
          midi: s.midi,
          db: s.midi >= 0 ? midiToDb(s.midi) : -144,
          rec: Boolean(s.rec),
          listen: Boolean(s.listen),
          master: false
        };
        pageTracks.push(row);
        tracks.push(row);
      }
      return { index: p, name: unit.name, live: true, tracks: pageTracks };
    });
    tracks.push({
      index: -1,
      name: 'Master',
      master: true,
      page: -1,
      strip: -1,
      live: true,
      rec: false,
      listen: false,
      known: this.masterMidi >= 0,
      midi: this.masterMidi,
      db: this.masterMidi >= 0 ? midiToDb(this.masterMidi) : -144
    });
    const linked = this.units.some((u) => u.hostLinked);
    return {
      linked,
      status: this.status,
      scanning: false,
      scanLabel: '',
      pageIndex: 0,
      pageCount: SURFACE_COUNT,
      pages,
      tracks,
      debug: {
        scan: 'xt32',
        linked,
        deviceId: this.units[0].deviceId,
        bankOffset: 0,
        waitTicks: this.waitTicks,
        lcd: this.units.map((u) => u.strips.map((s) => charsToString(s.top) || '·').join('|')).join(' / '),
        inCount: this.inCount,
        outCount: this.outCount,
        lastHostMs: this.lastHostAt ? Date.now() - this.lastHostAt : null,
        listenMode: this.listenMode,
        messages: this.messages.slice(-80)
      }
    };
  }

  pushLog(dir, bytes) {
    const buf = Buffer.from(bytes || []);
    if (dir === 'in') this.inCount += 1;
    else this.outCount += 1;
    this.messages.push({
      t: Date.now(),
      dir,
      hex: buf.toString('hex').slice(0, 48),
      text: describeMidi(buf)
    });
    if (this.messages.length > 120) this.messages.splice(0, this.messages.length - 80);
    this.emitChange();
  }

  handle(surface, bytes) {
    if (surface == null || typeof surface !== 'number') {
      bytes = surface;
      surface = 0;
    }
    if (!bytes || !bytes.length) return;
    surface = Math.max(0, Math.min(SURFACE_COUNT - 1, surface | 0));
    this.lastHostAt = Date.now();
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    let i = 0;
    let running = 0;
    while (i < data.length) {
      let status = data[i];
      if (status < 0x80) {
        if (!running) {
          i += 1;
          continue;
        }
        status = running;
      } else {
        i += 1;
        if (status < 0xF0) running = status;
        else if (status !== 0xF7) running = 0;
      }
      if (status === 0xF0) {
        const start = i - 1;
        while (i < data.length && data[i] !== 0xF7) i += 1;
        if (i < data.length) i += 1;
        this.dispatchMidi(surface, data.subarray(start, i));
        continue;
      }
      if (status >= 0xF8) continue;
      const type = status & 0xF0;
      const need = type === 0xC0 || type === 0xD0 ? 1 : 2;
      const msg = [status];
      while (msg.length < need + 1 && i < data.length && data[i] < 0x80) {
        msg.push(data[i]);
        i += 1;
      }
      this.dispatchMidi(surface, msg);
    }
  }

  dispatchMidi(surface, bytes) {
    if (!bytes || !bytes.length) return;
    this.pushLog('in', bytes);
    const b0 = bytes[0];
    if (b0 === 0xF0) this.handleSysex(surface, bytes);
    else if ((b0 & 0xF0) === 0xE0) this.handlePitchBend(surface, bytes);
    else if ((b0 & 0xF0) === 0x90 || (b0 & 0xF0) === 0x80) this.handleNote(surface, bytes);
  }

  tick() {
    const now = Date.now();
    for (const unit of this.units) {
      if (!unit.hostLinked && now - unit.lastQueryAt > 2000)
        this.sendHostConnectionQuery(unit.index);
    }
    if (!this.hostLinked && now - this.lastQueryAt > 2000)
      this.sendHostConnectionQuery(0);
    if (this.waitTicks > 0) this.waitTicks -= 1;
    this.flushPendingFader();
    this.flushPendingStrip();
  }

  send(surface, bytes) {
    if (bytes == null) {
      bytes = surface;
      surface = 0;
    }
    const buf = Buffer.from(bytes);
    this.pushLog('out', buf);
    if (typeof this.sendMidi === 'function') this.sendMidi(surface | 0, buf);
  }

  sendSysex(surface, cmd, payload) {
    if (typeof surface !== 'number') {
      payload = cmd;
      cmd = surface;
      surface = 0;
    }
    const unit = this.units[surface] || this.units[0];
    const body = Buffer.concat([
      Buffer.from([0xF0, 0x00, 0x00, 0x66, unit.deviceId, cmd]),
      payload || Buffer.alloc(0),
      Buffer.from([0xF7])
    ]);
    this.send(surface, body);
  }

  sendHostConnectionQuery(surface) {
    surface = surface == null ? 0 : surface;
    const unit = this.units[surface];
    if (!unit) return;
    unit.lastQueryAt = Date.now();
    this.lastQueryAt = unit.lastQueryAt;
    unit.challenge = [0, 1, 2, 3].map(() => Math.floor(Math.random() * 128));
    this.challenge = unit.challenge;
    this.sendSysex(surface, 0x01, Buffer.concat([SERIAL, Buffer.from(unit.challenge)]));
  }

  sendHostConnectionConfirm(surface) {
    this.sendSysex(surface || 0, 0x03, SERIAL);
  }

  sendVersionReply(surface) {
    this.sendSysex(surface || 0, 0x14, Buffer.from('V1.0 ', 'ascii'));
  }

  sendFader(strip, midi14, surface) {
    surface = surface || 0;
    midi14 = Math.max(0, Math.min(16383, midi14 | 0));
    const channel = strip === MASTER_STRIP ? 9 : strip + 1;
    this.send(surface, [0xE0 | (channel - 1), midi14 & 0x7f, (midi14 >> 7) & 0x7f]);
  }

  sendTouch(strip, down, surface) {
    this.send(surface || 0, [0x90, FADER_TOUCH_NOTE + strip, down ? 127 : 0]);
  }

  sendNoteBang(note, surface) {
    surface = surface || 0;
    this.send(surface, [0x90, note, 127]);
    this.send(surface, [0x90, note, 0]);
  }

  sendShift(down) {
    this.send(0, [0x90, SHIFT_NOTE, down ? 127 : 0]);
  }

  handleSysex(surface, bytes) {
    if (bytes.length < 7) return;
    const unit = this.units[surface] || this.units[0];
    const d = bytes.slice(1, bytes[bytes.length - 1] === 0xF7 ? -1 : undefined);
    if (d.length < 5 || d[0] !== 0x00 || d[1] !== 0x00 || d[2] !== 0x66) return;
    const id = d[3];
    if (id !== 0x14 && id !== 0x10 && id !== 0x15) return;
    unit.deviceId = surface === 0 ? (id === 0x15 ? 0x14 : id) : 0x15;
    const cmd = d[4];
    switch (cmd) {
      case 0x00:
        this.sendHostConnectionQuery(surface);
        break;
      case 0x02:
        if (d.length < 16) break;
        mcuResponse(unit.challenge);
        this.sendHostConnectionConfirm(surface);
        unit.hostLinked = true;
        this.hostLinked = true;
        this.status = 'Mackie Control + extenders linked';
        this.requestSurfaceRefresh();
        this.emitChange();
        break;
      case 0x0F:
        unit.hostLinked = false;
        this.hostLinked = this.units.some((u) => u.hostLinked);
        this.status = this.hostLinked ? 'Mackie Control + extenders linked' : 'DAW went offline';
        this.emitChange();
        break;
      case 0x12:
        if (d.length >= 6) this.writeLcd(surface, d[5], d.slice(6));
        return;
      case 0x13:
        this.sendVersionReply(surface);
        break;
      default:
        break;
    }
  }

  handlePitchBend(surface, bytes) {
    if (bytes.length < 3) return;
    const unit = this.units[surface] || this.units[0];
    const ch = (bytes[0] & 0x0f) + 1;
    const midi = bytes[1] | (bytes[2] << 7);
    if (ch < 1 || ch > 9) return;
    unit.hostLinked = true;
    this.hostLinked = true;
    if (/waiting|timed out/i.test(this.status)) this.status = 'Mackie Control + extenders linked';
    if (ch === 9) {
      if (surface === 0 && this.shouldApplyRemoteFader(-2, midi)) this.masterMidi = midi;
      this.emitChange();
      return;
    }
    const strip = ch - 1;
    const global = surface * STRIP_COUNT + strip;
    if (this.shouldApplyRemoteFader(global, midi)) unit.strips[strip].midi = midi;
    this.emitChange();
  }

  handleNote(surface, bytes) {
    if (bytes.length < 3) return;
    const unit = this.units[surface] || this.units[0];
    const note = bytes[1];
    const on = (bytes[0] & 0xF0) === 0x90 && bytes[2] > 0;
    if (note >= REC_NOTE && note < REC_NOTE + STRIP_COUNT) {
      if ((bytes[0] & 0xF0) === 0x80) return;
      unit.strips[note - REC_NOTE].rec = on;
      this.emitChange();
    } else if (note >= SOLO_NOTE && note < SOLO_NOTE + STRIP_COUNT)
      unit.strips[note - SOLO_NOTE].solo = on;
    else if (note >= MUTE_NOTE && note < MUTE_NOTE + STRIP_COUNT)
      unit.strips[note - MUTE_NOTE].mute = on;
    else if (note >= SELECT_NOTE && note < SELECT_NOTE + STRIP_COUNT)
      unit.strips[note - SELECT_NOTE].selected = on;
  }

  writeLcd(surface, offset, chars) {
    const unit = this.units[surface] || this.units[0];
    if (offset < 0 || !chars || !chars.length) return;
    for (let i = 0; i < chars.length; i++) {
      const pos = offset + i;
      if (pos < 0 || pos >= unit.lcd.length) break;
      const c = chars[i];
      unit.lcd[pos] = c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    this.refreshStripNames(surface);
    unit.hostLinked = true;
    this.hostLinked = true;
    if (/waiting|timed out/i.test(this.status)) this.status = 'Mackie Control + extenders linked';
    this.emitChange();
  }

  refreshStripNames(surface) {
    const unit = this.units[surface] || this.units[0];
    for (let i = 0; i < STRIP_COUNT; i++) {
      unit.strips[i].top = unit.lcd.slice(i * 7, i * 7 + 7).join('');
      unit.strips[i].bottom = unit.lcd.slice(56 + i * 7, 56 + i * 7 + 7).join('');
    }
  }

  requestSurfaceRefresh() {
    for (const unit of this.units)
      this.send(unit.index, [0xF0, 0x00, 0x00, 0x66, unit.deviceId, 0x01, 0x58, 0x59, 0x5A, 0xF7]);
  }

  stripTrackName(surface, strip) {
    if (strip == null) {
      strip = surface;
      surface = 0;
    }
    const unit = this.units[surface] || this.units[0];
    return usableLcdStripName(unit.lcd, strip, unit.strips[strip] && unit.strips[strip].top);
  }

  flushPendingFader() {
    if (this.pendingMidi < 0 && !this.pendingTouch && this.touchingIndex < 0) return;
    if (this.waitTicks > 0) return;
    const surface = this.pendingSurface || 0;

    if (this.pendingIsMaster) {
      if (this.pendingTouch && this.touchingIndex !== -2) {
        if (this.sentTouch && this.touchingIndex >= 0)
          this.sendTouch(this.touchingIndex % STRIP_COUNT, false, surface);
        this.sendTouch(MASTER_STRIP, true, 0);
        this.sentTouch = true;
        this.touchingIndex = -2;
      }
      if (this.pendingMidi >= 0) {
        this.sendFader(MASTER_STRIP, this.pendingMidi, 0);
        this.masterMidi = this.pendingMidi;
      }
      if (!this.pendingTouch && this.touchingIndex === -2) {
        this.sendTouch(MASTER_STRIP, false, 0);
        this.sentTouch = false;
        this.touchingIndex = -1;
      }
      this.pendingMidi = this.pendingTouch ? this.pendingMidi : -1;
      return;
    }

    if (this.pendingIndex < 0 || this.pendingIndex >= STRIP_COUNT) return;
    const strip = this.pendingIndex;
    if (this.pendingTouch && this.touchingIndex !== this.pendingIndex) {
      if (this.sentTouch && this.touchingIndex >= 0)
        this.sendTouch(this.touchingIndex % STRIP_COUNT, false, surface);
      this.sendTouch(strip, true, surface);
      this.sentTouch = true;
      this.touchingIndex = this.pendingIndex;
    }
    if (this.pendingMidi >= 0) this.sendFader(strip, this.pendingMidi, surface);
    if (!this.pendingTouch) {
      if (this.sentTouch) this.sendTouch(strip, false, surface);
      this.sentTouch = false;
      this.touchingIndex = -1;
      this.pendingMidi = -1;
      this.pendingIndex = -1;
    }
  }

  flushPendingStrip() {
    if (!this.pendingStrip || this.waitTicks > 0) return;
    const surface = this.pendingStrip.surface || 0;
    if (this.pendingStrip.listen && !this.shiftHeld) {
      this.sendShift(true);
      this.shiftHeld = true;
    }
    const strip = this.pendingStrip.index % STRIP_COUNT;
    this.sendNoteBang(REC_NOTE + strip, surface);
    if (this.shiftHeld) {
      this.sendShift(false);
      this.shiftHeld = false;
    }
    this.pendingStrip = null;
  }

  mapTrackIndex(index) {
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= CHANNEL_COUNT) return null;
    return { page: Math.floor(index / STRIP_COUNT), strip: index % STRIP_COUNT };
  }

  writePageSlot(page, strip, patch) {
    if (page < 0 || strip < 0 || strip >= STRIP_COUNT) return;
    while (this.pages.length <= page)
      this.pages.push(Array.from({ length: STRIP_COUNT }, emptySlot));
    const slot = this.pages[page][strip];
    if (patch.name != null && patch.name) {
      if (!slot.name || patch.name.length >= slot.name.length) slot.name = patch.name;
    }
    if (patch.midi != null) slot.midi = patch.midi;
    if (patch.rec != null) slot.rec = patch.rec;
    if (patch.listen != null) slot.listen = patch.listen;
  }

  captureCurrentPage() {
    const slots = [];
    for (let i = 0; i < STRIP_COUNT; i++) {
      slots.push({
        name: this.stripTrackName(i),
        midi: this.strips[i].midi,
        rec: Boolean(this.strips[i].rec),
        listen: Boolean(this.strips[i].listen)
      });
    }
    return slots;
  }

  lcdSignature() {
    return this.strips.map((_, i) => `${this.stripTrackName(i)}|`).join('');
  }

  namedStripsNeedFaders() {
    for (let i = 0; i < STRIP_COUNT; i++) {
      if (this.stripTrackName(i) && this.strips[i].midi < 0) return true;
    }
    return false;
  }

  scanLabel() {
    if (this.scan === 'idle') return '';
    const n = this.pages.reduce((sum, slots) => sum + slots.filter((s) => s && s.name).length, 0);
    if (this.scan === 'homing') return 'Homing to the first Mackie page…';
    if (this.scan === 'rewind') return `Rewinding to page 1 · ${n} tracks`;
    return `Reading page ${this.pages.length + 1} · ${n} tracks so far`;
  }

  beginScan() {
    this.scan = 'homing';
    this.homeTries = 0;
    this.pages = [];
    this.pageIndex = 0;
    this.pageTarget = null;
    this.lcdHoldSig = '';
    this.lcdHoldTicks = 0;
    this.faderHoldTicks = 0;
    this.preHomeSig = this.lcdSignature();
    this.waitTicks = PAGE_WAIT_TICKS;
    this.status = 'Building mixer from Mackie pages…';
    this.sendNoteBang(BANK_LEFT_NOTE);
    this.emitChange();
  }

  tickPageTarget() {
    if (this.scan !== 'idle' || this.pageTarget == null || this.waitTicks > 0) return;
    if (this.pageTarget === this.pageIndex) {
      this.pageTarget = null;
      this.requestSurfaceRefresh();
      this.waitTicks = PAGE_WAIT_TICKS;
      this.emitChange();
      return;
    }
    if (this.pageTarget > this.pageIndex) {
      this.sendNoteBang(BANK_RIGHT_NOTE);
      this.pageIndex += 1;
    } else {
      this.sendNoteBang(BANK_LEFT_NOTE);
      this.pageIndex = Math.max(0, this.pageIndex - 1);
    }
    this.waitTicks = PAGE_WAIT_TICKS;
    this.emitChange();
  }

  tickScan() {
    if (this.scan === 'idle') return;
    if (this.waitTicks > 0) return;
    if (this.scan === 'homing') {
      const sig = this.lcdSignature();
      const atLeft = this.homeTries >= 2 && sig === this.preHomeSig;
      if (atLeft || this.homeTries >= 24) {
        this.pageIndex = 0;
        this.pages = [];
        this.lcdHoldSig = '';
        this.lcdHoldTicks = 0;
        this.faderHoldTicks = 0;
        this.requestSurfaceRefresh();
        this.scan = 'settle';
        this.waitTicks = PAGE_WAIT_TICKS;
        this.status = 'Building mixer from Mackie pages…';
        this.emitChange();
      } else {
        this.homeTries += 1;
        this.preHomeSig = sig;
        this.sendNoteBang(BANK_LEFT_NOTE);
        this.waitTicks = PAGE_WAIT_TICKS;
        this.emitChange();
      }
      return;
    }
    if (this.scan === 'settle') {
      this.lcdHoldSig = this.lcdSignature();
      this.lcdHoldTicks = 0;
      this.faderHoldTicks = 0;
      this.scan = 'holdLcd';
      this.waitTicks = 8;
      return;
    }
    if (this.scan === 'holdLcd') {
      const sig = this.lcdSignature();
      if (sig !== this.lcdHoldSig) {
        this.lcdHoldSig = sig;
        this.lcdHoldTicks = 0;
        this.waitTicks = 8;
        this.emitChange();
        return;
      }
      this.lcdHoldTicks += 1;
      if (this.lcdHoldTicks < LCD_HOLD_TICKS) {
        this.waitTicks = 4;
        return;
      }
      this.faderHoldTicks = 0;
      this.scan = 'holdFaders';
      this.requestSurfaceRefresh();
      this.waitTicks = 10;
      this.emitChange();
      return;
    }
    if (this.scan === 'holdFaders') {
      if (this.namedStripsNeedFaders() && this.faderHoldTicks < FADER_HOLD_TICKS) {
        this.faderHoldTicks += 1;
        if (this.faderHoldTicks === 1 || this.faderHoldTicks === 20) this.requestSurfaceRefresh();
        this.waitTicks = 6;
        this.emitChange();
        return;
      }
      this.scan = 'capture';
      return;
    }
    if (this.scan === 'capture') {
      const slots = this.captureCurrentPage();
      const named = slots.some((s) => s.name);
      if (this.pages.length && pageNamesMatch(slots, this.pages[this.pages.length - 1])) {
        this.scan = 'rewind';
        this.waitTicks = 0;
        this.emitChange();
        return;
      }
      if (this.pages.length && pageNamesMatch(slots, this.pages[0]) && this.pages.length > 1) {
        this.scan = 'rewind';
        this.waitTicks = 0;
        this.emitChange();
        return;
      }
      if (!named) {
        if (this.pages.length === 0) {
          this.scan = 'idle';
          this.status = 'no track names on the MCU LCD yet — enable Mackie Control, then Scan pages';
          this.emitChange();
          return;
        }
        this.scan = 'rewind';
        this.waitTicks = 0;
        this.emitChange();
        return;
      }
      this.pages.push(slots);
      this.emitChange();
      if (this.pages.length >= 32) {
        this.scan = 'rewind';
        this.waitTicks = 0;
        return;
      }
      this.sendNoteBang(BANK_RIGHT_NOTE);
      this.pageIndex = this.pages.length;
      this.scan = 'settle';
      this.waitTicks = PAGE_WAIT_TICKS;
      this.status = `Building mixer · page ${this.pages.length + 1}`;
      this.emitChange();
      return;
    }
    if (this.scan === 'rewind') {
      if (this.pageIndex <= 0) {
        this.pageIndex = 0;
        this.requestSurfaceRefresh();
        this.scan = 'idle';
        const n = this.pages.reduce((sum, slots) => sum + slots.filter((s) => s && s.name).length, 0);
        this.status = n > 0
          ? `mixer: ${n} tracks · ${this.pages.length} pages`
          : 'linked — no track names yet';
        this.waitTicks = PAGE_WAIT_TICKS;
        this.emitChange();
        return;
      }
      this.sendNoteBang(BANK_LEFT_NOTE);
      this.pageIndex -= 1;
      this.waitTicks = PAGE_WAIT_TICKS;
      this.emitChange();
    }
  }

  emitChange() {
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
  }
}

function fromHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean.length || clean.length % 2) return null;
  return Buffer.from(clean, 'hex');
}

module.exports = { MackieControl, midiToDb, dbToMidi, toHex, fromHex };
