const TOKEN_KEY = 'asaphops_token';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  view: 'clients',
  param: '',
  sub: '',
  liveStream: null,
  liveStreamGen: 0,
  mixerMonitor: sessionStorage.getItem('asaphops_mixer_monitor') === '1',
  mixerInOnly: sessionStorage.getItem('asaphops_mixer_in') === '1',
  mixerHideMeters: sessionStorage.getItem('asaphops_mixer_hidemeters') !== '0',
  sniffUntil: 0,
  sniffHits: [],
  sniffResult: ''
};

function $(sel, el = document) { return el.querySelector(sel); }

async function api(path, opts = {}) {
  const headers = {
    Authorization: state.token ? `Bearer ${state.token}` : '',
    ...(opts.headers || {})
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Invalid response (${res.status})` }));
  if (res.status === 401) {
    stopEndpointStream();
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    location.hash = '#/login';
  }
  if (!data.ok && !data.error) data.error = `Request failed (${res.status})`;
  return data;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function badge(status) {
  const s = String(status || '').toLowerCase();
  let cls = '';
  if (['ready', 'active', 'planned', 'operator', 'online', 'connected'].includes(s)) cls = 'live';
  else if (['engineer', 'volunteer', 'unassigned', 'offline', 'disconnected'].includes(s)) cls = 'warn';
  else if (['cancelled'].includes(s)) cls = 'bad';
  return `<span class="badge ${cls}">${status}</span>`;
}

function connectionBadge(connected, endpointId) {
  const label = connected ? 'connected' : 'disconnected';
  const cls = connected ? 'live' : 'warn';
  const idAttr = endpointId ? ` data-endpoint-connected="${endpointId}"` : '';
  return `<span class="badge ${cls}"${idAttr}>${label}</span>`;
}

function endpointRailMeta(e) {
  return `${e.client_name || 'Unassigned'} · ${e.code || ''} · ${e.connected ? 'connected' : 'disconnected'}`;
}

function endpointRailItem(e, selected) {
  return `<a class="rail-item${selected === e.id ? ' active' : ''}" data-endpoint-id="${e.id}" href="#/endpoints/${e.id}">
          <span class="title">${e.name}</span>
          <span class="meta">${endpointRailMeta(e)}</span>
        </a>`;
}

function applyEndpointPresence(endpoints) {
  if (!Array.isArray(endpoints)) return;
  const byId = new Map(endpoints.map((e) => [e.id, e]));

  for (const el of document.querySelectorAll('[data-endpoint-connected]')) {
    const e = byId.get(el.getAttribute('data-endpoint-connected'));
    if (!e) continue;
    const label = e.connected ? 'connected' : 'disconnected';
    const cls = e.connected ? 'live' : 'warn';
    if (el.textContent !== label) el.textContent = label;
    if (el.className !== `badge ${cls}`) el.className = `badge ${cls}`;
  }

  for (const el of document.querySelectorAll('[data-endpoint-last-seen]')) {
    const e = byId.get(el.getAttribute('data-endpoint-last-seen'));
    if (e) el.textContent = fmtTime(e.last_seen_at);
  }

  for (const el of document.querySelectorAll('[data-endpoint-remove]')) {
    const e = byId.get(el.getAttribute('data-endpoint-remove'));
    if (!e) continue;
    const html = e.connected
      ? '<p class="sub">Sign out or close the companion before removing this endpoint.</p>'
      : `<button class="btn danger" type="button" data-action="remove-endpoint" data-id="${e.id}">Remove</button>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  if (state.view !== 'endpoints') return;
  const listEl = document.querySelector('.rail-list');
  if (!listEl) return;

  for (const item of [...listEl.querySelectorAll('[data-endpoint-id]')]) {
    const e = byId.get(item.getAttribute('data-endpoint-id'));
    if (!e) {
      item.remove();
      continue;
    }
    const meta = item.querySelector('.meta');
    const nextMeta = endpointRailMeta(e);
    if (meta && meta.textContent !== nextMeta) meta.textContent = nextMeta;
    const title = item.querySelector('.title');
    if (title && e.name && title.textContent !== e.name) title.textContent = e.name;
  }

  const empty = listEl.querySelector('.rail-empty');
  if (endpoints.length && empty) empty.remove();
  if (!endpoints.length && !listEl.querySelector('.rail-empty')) {
    listEl.innerHTML = '<p class="rail-empty">No endpoints yet.</p>';
    return;
  }

  for (const e of endpoints) {
    if (!listEl.querySelector(`[data-endpoint-id="${e.id}"]`))
      listEl.insertAdjacentHTML('beforeend', endpointRailItem(e, state.param));
  }
}

function stopEndpointStream() {
  state.liveStreamGen += 1;
  if (state.liveStream) {
    state.liveStream.abort();
    state.liveStream = null;
  }
}

function startEndpointStream() {
  if (!state.token || state.liveStream) return;
  const ac = new AbortController();
  const gen = state.liveStreamGen;
  state.liveStream = ac;
  (async () => {
    try {
      const res = await fetch('/api/endpoints/stream', {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: ac.signal
      });
      if (!res.ok || !res.body) throw new Error('stream closed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (gen === state.liveStreamGen) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            if (payload.type === 'endpoints' && Array.isArray(payload.endpoints))
              applyEndpointPresence(payload.endpoints);
            if (payload.type === 'mixer')
              applyMixerPayload(payload);
          } catch (_) {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (gen === state.liveStreamGen)
        state.liveStream = null;
    }
    if (state.token && gen === state.liveStreamGen)
      setTimeout(startEndpointStream, 2000);
  })();
}

function route() {
  const hash = (location.hash.replace(/^#\/?/, '') || (state.token ? 'clients' : 'login'));
  const parts = hash.split('/').filter(Boolean);
  const view = parts[0];
  const param = parts[1] || '';
  const sub = parts[2] || '';
  if (view === 'locations') {
    location.hash = `#/endpoints${parts.slice(1).length ? `/${parts.slice(1).join('/')}` : ''}`;
    return;
  }
  if (view === 'people') {
    location.hash = `#/staff${param ? `/${param}` : ''}`;
    return;
  }
  if (view === 'calendar' && !param) {
    const now = new Date();
    location.hash = `#/calendar/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return;
  }
  state.view = view;
  state.param = param;
  state.sub = sub;
  render();
}

function shell(rail, main, wide = false) {
  const nav = [
    ['clients', 'Clients'],
    ['events', 'Events'],
    ['calendar', 'Calendar'],
    ['staff', 'Staff'],
    ['endpoints', 'Endpoints']
  ]
    .map(([id, label]) => `<a href="#/${id}" class="${state.view === id ? 'active' : ''}">${label}</a>`)
    .join('');
  return `<div class="app${wide ? ' wide' : ''}">
    <aside class="sidebar">
      <div class="brand"><strong>Asaphops</strong><span>Live audio operations</span></div>
      <nav>${nav}</nav>
      <div class="userbox">
        <div>${state.me.name}</div>
        <div class="muted">${state.me.role}</div>
        <button class="btn" style="margin-top:10px" id="logoutBtn">Sign out</button>
      </div>
    </aside>
    ${rail}
    <main class="main">${main}</main>
  </div>`;
}

function rail(title, items, selected, empty, opts = {}) {
  const create = opts.create !== false;
  return `<aside class="rail">
    <div class="rail-head">
      <h2>${title}</h2>
      ${create ? `<a class="btn primary block" href="#/${state.view}/new">Create new</a>` : ''}
    </div>
    <div class="rail-list">
      ${items.map((it) => `
        <a class="rail-item${selected === it.id ? ' active' : ''}" href="#/${state.view}/${it.id}">
          <span class="title">${it.title}</span>
          <span class="meta">${it.meta || ''}</span>
        </a>`).join('') || `<p class="rail-empty">${empty}</p>`}
    </div>
  </aside>`;
}

function loginView() {
  return `<div class="auth"><form class="auth-card" id="loginForm">
    <h1>Asaphops</h1>
    <p class="sub">Sign in to manage clients, events, staff, and endpoints.</p>
    <label style="margin-top:16px">Email</label>
    <input name="email" type="email" value="ops@asaphops.local" required />
    <label style="margin-top:12px">Password</label>
    <input name="password" type="password" value="asaphops" required />
    <div class="err" id="authErr"></div>
    <button class="btn primary block" style="margin-top:16px">Sign in</button>
  </form></div>`;
}

async function render() {
  const root = document.getElementById('root');
  if (!state.token || state.view === 'login') {
    root.innerHTML = loginView();
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = await api('/auth/login', { method: 'POST', body: Object.fromEntries(fd) });
      if (!data.ok) { $('#authErr').textContent = data.error; return; }
      state.token = data.token;
      state.me = data.person;
      localStorage.setItem(TOKEN_KEY, data.token);
      startEndpointStream();
      location.hash = '#/clients';
    });
    return;
  }
  if (!state.me) {
    const me = await api('/me');
    if (!me.ok) { root.innerHTML = loginView(); return; }
    state.me = me.person;
  }
  startEndpointStream();

  root.innerHTML = shell('', '<p class="sub">Loading…</p>');
  try {
    const views = { clients, events, calendar, staff, endpoints };
    const page = await (views[state.view] || clients)();
    root.innerHTML = shell(page.rail, page.main, page.wide);
    bind();
  } catch (err) {
    root.innerHTML = shell('', `<p class="err">${err.message}</p>`);
    bind();
  }
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return h * 60 + m;
}

function collectSlots(form) {
  return [...form.querySelectorAll('.time-row')].map((row) => ({
    start: row.querySelector('[name="timeStart"]')?.value,
    end: row.querySelector('[name="timeEnd"]')?.value,
    row
  })).filter((s) => s.start && s.end);
}

function localSlotError(slots) {
  for (const slot of slots) {
    if (minutesOf(slot.end) <= minutesOf(slot.start)) {
      return `End time must be after start (${slot.start}–${slot.end}).`;
    }
  }
  const ordered = [...slots].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  for (let i = 1; i < ordered.length; i++) {
    if (minutesOf(ordered[i].start) < minutesOf(ordered[i - 1].end)) {
      return `These times overlap: ${ordered[i - 1].start}–${ordered[i - 1].end} and ${ordered[i].start}–${ordered[i].end}.`;
    }
  }
  return null;
}

function markSlotConflicts(slots) {
  slots.forEach((s) => s.row?.classList.remove('conflict'));
  const ordered = [...slots].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  for (let i = 1; i < ordered.length; i++) {
    if (minutesOf(ordered[i].start) < minutesOf(ordered[i - 1].end)) {
      ordered[i].row?.classList.add('conflict');
      ordered[i - 1].row?.classList.add('conflict');
    }
  }
  for (const slot of slots) {
    if (minutesOf(slot.end) <= minutesOf(slot.start)) slot.row?.classList.add('conflict');
  }
}

function showFormError(msg) {
  const el = $('#formErr');
  if (el) {
    el.textContent = msg || '';
    el.hidden = !msg;
  } else if (msg) {
    window.alert(msg);
  }
}

function bind() {
  const out = $('#logoutBtn');
  if (out) out.addEventListener('click', () => {
    stopEndpointStream();
    state.token = '';
    state.me = null;
    localStorage.removeItem(TOKEN_KEY);
    location.hash = '#/login';
  });
  document.querySelectorAll('form[data-form]').forEach((form) => {
    form.addEventListener('submit', onForm);
  });
  bindEventForm();
  bindMixerFaders();
}

function bindEventForm() {
  const form = $('#eventForm');
  if (!form) return;
  const weekdayBlock = $('#weekdayBlock');
  const onceBlock = $('#onceBlock');
  form.querySelectorAll('[name="kind"]').forEach((el) => {
    el.addEventListener('change', () => {
      const once = form.querySelector('[name="kind"]:checked')?.value === 'once';
      weekdayBlock.hidden = once;
      onceBlock.hidden = !once;
    });
  });
  $('#addTime')?.addEventListener('click', () => {
    const rows = $('#timeRows');
    const row = document.createElement('div');
    row.className = 'time-row';
    row.innerHTML = `<div><label>Start</label><input name="timeStart" type="time" value="18:00" required /></div>
      <div><label>End</label><input name="timeEnd" type="time" value="19:30" required /></div>
      <button type="button" class="btn" data-remove-time>Remove</button>`;
    rows.appendChild(row);
    refreshTimeRemoves();
    previewSlotErrors();
  });
  $('#timeRows')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-remove-time]');
    if (!btn) return;
    btn.closest('.time-row')?.remove();
    refreshTimeRemoves();
    previewSlotErrors();
  });
  $('#timeRows')?.addEventListener('input', previewSlotErrors);
  previewSlotErrors();
}

function previewSlotErrors() {
  const form = $('#eventForm');
  if (!form) return;
  const slots = collectSlots(form);
  markSlotConflicts(slots);
  const msg = localSlotError(slots);
  showFormError(msg);
}

function refreshTimeRemoves() {
  const rows = [...document.querySelectorAll('#timeRows .time-row')];
  rows.forEach((row) => {
    const btn = row.querySelector('[data-remove-time]');
    if (btn) btn.hidden = rows.length < 2;
  });
}

async function onForm(e) {
  e.preventDefault();
  const kind = e.currentTarget.dataset.form;
  const body = Object.fromEntries(new FormData(e.currentTarget).entries());
  if (kind === 'client') {
    const data = await api('/clients', { method: 'POST', body });
    if (!data.ok) return showFormError(data.error);
    location.hash = `#/clients/${data.client.id}`;
    return;
  }
  if (kind === 'staff') {
    const data = await api('/people', { method: 'POST', body });
    if (!data.ok) return showFormError(data.error);
    location.hash = `#/staff/${data.person.id}`;
    return;
  }
  if (kind === 'event') {
    const form = e.currentTarget;
    body.kind = form.querySelector('[name="kind"]:checked')?.value || 'recurring';
    body.weekdays = [...form.querySelectorAll('[name="weekdays"]:checked')].map((el) => Number(el.value));
    const slots = collectSlots(form);
    body.times = slots.map(({ start, end }) => ({ start, end }));
    const localErr = localSlotError(slots);
    markSlotConflicts(slots);
    if (localErr) {
      showFormError(localErr);
      return;
    }
    const editing = state.view === 'events' && state.param && state.param !== 'new';
    const data = editing
      ? await api(`/events/${state.param}`, { method: 'PATCH', body })
      : await api('/events', { method: 'POST', body });
    if (!data.ok) {
      showFormError(data.error || 'Could not save this event.');
      return;
    }
    location.hash = `#/events/${data.event.id}`;
    return;
  }
  if (kind === 'assign-endpoint') {
    const data = await api(`/endpoints/${state.param}`, { method: 'PATCH', body: { clientId: body.clientId || null } });
    if (!data.ok) return showFormError(data.error);
    route();
    return;
  }
  if (kind === 'assign') {
    const form = e.currentTarget;
    if (!body.occurrenceId || !body.personId || !body.duty) {
      showFormError('Choose an occurrence, duty, and staff member.');
      return;
    }
    const data = await api(`/occurrences/${body.occurrenceId}/assign`, { method: 'POST', body: { personId: body.personId, duty: body.duty } });
    if (!data.ok) {
      showFormError(data.error || 'Could not assign.');
      return;
    }
    form.reset();
    route();
  }
}

async function onAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  e.preventDefault();
  const { action, id, year, month } = btn.dataset;
  if (action === 'cal-prev' || action === 'cal-next') {
    const y = Number(year);
    const m = Number(month);
    const next = action === 'cal-prev' ? new Date(y, m - 2, 1) : new Date(y, m, 1);
    location.hash = `#/calendar/${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    return;
  }
  if (action === 'cancel') {
    if (!confirm('Cancel this occurrence?')) return;
    await api(`/occurrences/${id}/cancel`, { method: 'POST' });
  }
  if (action === 'mixer-scan') {
    const data = await api(`/endpoints/${id}/mixer/scan`, { method: 'POST', body: {} });
    if (!data.ok) window.alert(data.error || 'Could not refresh the Mackie surfaces.');
    return;
  }
  if (action === 'mixer-focus') {
    const page = Number(btn.dataset.page);
    const data = await api(`/endpoints/${state.param}/mixer/focus`, { method: 'POST', body: { page } });
    if (!data.ok) window.alert(data.error || 'Could not focus that page.');
    return;
  }
  if (action === 'mixer-bank') {
    const dir = btn.dataset.dir === 'right' ? 'right' : 'left';
    const data = await api(`/endpoints/${state.param}/mixer/bank`, { method: 'POST', body: { dir } });
    if (!data.ok) window.alert(data.error || 'Could not bank the MCU.');
    return;
  }
  if (action === 'mixer-monitor') {
    state.mixerMonitor = !state.mixerMonitor;
    sessionStorage.setItem('asaphops_mixer_monitor', state.mixerMonitor ? '1' : '0');
    const panel = $('#mixerDebug');
    const btn = document.querySelector('[data-action="mixer-monitor"]');
    if (panel) panel.hidden = !state.mixerMonitor;
    if (btn) btn.textContent = state.mixerMonitor ? 'Hide MIDI monitor' : 'MIDI monitor';
    if (state.mixerMonitor && state.param) {
      api(`/endpoints/${state.param}/mixer`).then((data) => {
        if (data.ok && data.mixer) patchMixer(data.mixer);
      });
    }
    return;
  }
  if (action === 'mixer-in-only') {
    state.mixerInOnly = !state.mixerInOnly;
    sessionStorage.setItem('asaphops_mixer_in', state.mixerInOnly ? '1' : '0');
    const b = document.querySelector('[data-action="mixer-in-only"]');
    if (b) b.classList.toggle('on', state.mixerInOnly);
    if (state.param) {
      api(`/endpoints/${state.param}/mixer`).then((data) => {
        if (data.ok && data.mixer) patchMixer(data.mixer);
      });
    }
    return;
  }
  if (action === 'mixer-hide-meters') {
    state.mixerHideMeters = !state.mixerHideMeters;
    sessionStorage.setItem('asaphops_mixer_hidemeters', state.mixerHideMeters ? '1' : '0');
    const b = document.querySelector('[data-action="mixer-hide-meters"]');
    if (b) b.classList.toggle('on', state.mixerHideMeters);
    if (state.param) {
      api(`/endpoints/${state.param}/mixer`).then((data) => {
        if (data.ok && data.mixer) patchMixer(data.mixer);
      });
    }
    return;
  }
  if (action === 'mixer-sniff') {
    state.mixerMonitor = true;
    state.mixerInOnly = true;
    state.mixerHideMeters = true;
    sessionStorage.setItem('asaphops_mixer_monitor', '1');
    sessionStorage.setItem('asaphops_mixer_in', '1');
    sessionStorage.setItem('asaphops_mixer_hidemeters', '1');
    state.sniffHits = [];
    state.sniffResult = '';
    state.sniffStart = Date.now();
    state.sniffUntil = Date.now() + 6000;
    const panel = $('#mixerDebug');
    if (panel) panel.hidden = false;
    const hint = $('#mixerSniffHint');
    if (hint) hint.textContent = 'Sniffing 6s — toggle the speaker (input monitor) in the DAW mixer, not the web IN button.';
    window.setTimeout(() => {
      if (Date.now() < state.sniffUntil - 50) return;
      const unique = [];
      for (const line of state.sniffHits) {
        if (!unique.includes(line)) unique.push(line);
      }
      state.sniffResult = unique.length
        ? `DAW sent ${unique.length} distinct IN message(s) while you toggled listen:\n${unique.join('\n')}`
        : 'DAW sent no MCU notes/CC for listen (meters hidden). Reaper’s stock Mackie Control does not report or accept input monitor on this port.';
      state.sniffUntil = 0;
      const h = $('#mixerSniffHint');
      if (h) h.textContent = state.sniffResult;
    }, 6200);
    return;
  }
  if (action === 'mixer-listen-map') {
    const mode = btn.dataset.mode || 'none';
    const data = await api(`/endpoints/${state.param}/mixer/listen-map`, {
      method: 'POST',
      body: { mode }
    });
    if (!data.ok) window.alert(data.error || 'Could not set listen mapping.');
    else {
      const hint = $('#mixerSniffHint');
      if (hint) {
        hint.textContent = data.listenMode === 'shift-rec'
          ? 'IN now sends MCU Shift + Rec/Rdy (Logic / Cubase). Reaper will still treat that as rec-arm.'
          : 'IN sends no MIDI. Use Sniff DAW listen, or enable Shift+Rec if this DAW maps it.';
      }
    }
    return;
  }
  if (action === 'mixer-rec') {
    const index = Number(btn.dataset.index);
    const armed = !btn.classList.contains('armed');
    btn.classList.toggle('armed', armed);
    const data = await api(`/endpoints/${state.param}/mixer/rec`, {
      method: 'POST',
      body: { index, armed }
    });
    if (!data.ok) {
      btn.classList.toggle('armed', !armed);
      window.alert(data.error || 'Could not arm this track.');
    }
    return;
  }
  if (action === 'mixer-listen') {
    const index = Number(btn.dataset.index);
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    const data = await api(`/endpoints/${state.param}/mixer/listen`, {
      method: 'POST',
      body: { index, on }
    });
    if (!data.ok) {
      btn.classList.toggle('on', !on);
      window.alert(data.error || 'Could not toggle input monitoring.');
    } else if (data.listenMode === 'none') {
      btn.classList.toggle('on', !on);
      window.alert('Listen is not mapped on MCU. Open MIDI monitor, click “Sniff DAW listen”, and toggle the speaker in Reaper. For Logic/Cubase, enable Shift+Rec in that panel.');
    }
    return;
  }
  if (action === 'remove-endpoint') {
    if (!confirm('Remove this endpoint from the system? This cannot be undone.')) return;
    const data = await api(`/endpoints/${id}`, { method: 'DELETE' });
    if (!data.ok) {
      window.alert(data.error || 'Could not remove this endpoint.');
      return;
    }
    location.hash = '#/endpoints';
    return;
  }
  route();
}

function hint(title, text) {
  return `<div class="top"><div><h1>${title}</h1><p class="sub">${text}</p></div></div>
    <article class="card"><p class="sub">Select an item in the list, or create a new one.</p></article>`;
}

async function clients() {
  const data = await api('/clients');
  const list = (data.clients || []).map((c) => ({ id: c.id, title: c.name, meta: [c.city, c.timezone].filter(Boolean).join(' · ') }));
  const r = rail('Clients', list, state.param === 'new' ? '' : state.param, 'No clients yet.');
  if (state.param === 'new') {
    return { rail: r, main: `<div class="top"><div><h1>New client</h1><p class="sub">A church, campus, or venue you support.</p></div></div>
      <article class="card"><form class="form-grid" data-form="client">
        <div class="span2"><label>Name</label><input name="name" required /></div>
        <div><label>City</label><input name="city" /></div>
        <div><label>Timezone</label><input name="timezone" value="America/Chicago" /></div>
        <div class="span2"><label>Notes</label><textarea name="notes"></textarea></div>
        <div class="span2 err banner" id="formErr" hidden></div>
        <div class="span2"><button class="btn primary" type="submit">Save client</button></div>
      </form></article>` };
  }
  if (!state.param) return { rail: r, main: hint('Clients', 'Sites you support. Events belong to a client. Endpoints can be assigned after a companion signs in.') };
  const d = await api(`/clients/${state.param}`);
  if (!d.ok) return { rail: r, main: `<p class="err">${d.error}</p>` };
  const c = d.client;
  return { rail: r, main: `<div class="top"><div><h1>${c.name}</h1><p class="sub">${[c.city, c.timezone].filter(Boolean).join(' · ')}</p></div></div>
    <article class="card"><h2>Notes</h2><p class="sub">${c.notes || 'No notes.'}</p></article>
    <article class="card"><h2>Staff</h2>${d.people.length ? `<table><tbody>${d.people.map((p) => `<tr><td>${p.name}</td><td>${p.role}</td><td>${p.email}</td></tr>`).join('')}</tbody></table>` : '<p class="sub">None assigned.</p>'}</article>
    <article class="card"><h2>Events</h2>${d.events.length ? d.events.map((e) => `<p><a href="#/events/${e.id}">${e.name}</a> · ${e.summary}</p>`).join('') : '<p class="sub">None yet.</p>'}</article>
    <article class="card"><h2>Endpoints</h2>${d.endpoints.length ? d.endpoints.map((e) => `<p><a href="#/endpoints/${e.id}">${e.name}</a> ${connectionBadge(e.connected, e.id)}</p>`).join('') : '<p class="sub">None assigned.</p>'}</article>` };
}

function eventEditor(cl, e) {
  const kind = e ? e.kind : 'recurring';
  const days = new Set((e && e.weekdays && e.weekdays.length ? e.weekdays : [0]).map(Number));
  const slots = e && e.times && e.times.length ? e.times : [{ start: '10:00', end: '11:15' }];
  const once = kind === 'once';
  const timeRows = slots.map((slot, i) => `
    <div class="time-row">
      <div><label>Start</label><input name="timeStart" type="time" value="${slot.start}" required /></div>
      <div><label>End</label><input name="timeEnd" type="time" value="${slot.end}" required /></div>
      <button type="button" class="btn" data-remove-time ${slots.length < 2 && i === 0 ? 'hidden' : ''}>Remove</button>
    </div>`).join('');
  return `<article class="card"><form class="form-grid" data-form="event" id="eventForm">
    <div class="span2"><label>Name</label><input name="name" placeholder="Sunday Morning" value="${e ? e.name : ''}" required /></div>
    <div class="span2"><label>Client</label><select name="clientId">${(cl.clients || []).map((c) => `<option value="${c.id}" ${e && e.client_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
    <div class="span2"><label>Type</label>
      <div class="checks">
        <label><input type="radio" name="kind" value="recurring" ${once ? '' : 'checked'} /> Recurring</label>
        <label><input type="radio" name="kind" value="once" ${once ? 'checked' : ''} /> One-time</label>
      </div>
    </div>
    <div class="span2" id="weekdayBlock" ${once ? 'hidden' : ''}><label>Days of week</label>
      <div class="checks">${WEEKDAYS.map((d, i) => `<label><input type="checkbox" name="weekdays" value="${i}" ${days.has(i) ? 'checked' : ''} /> ${d}</label>`).join('')}</div>
    </div>
    <div class="span2" id="onceBlock" ${once ? '' : 'hidden'}><label>Date</label><input name="onceDate" type="date" value="${e && e.once_date ? e.once_date : ''}" /></div>
    <div class="span2"><label>Times</label>
      <div class="time-rows" id="timeRows">${timeRows}</div>
      <button type="button" class="btn" id="addTime" style="margin-top:8px">Add time</button>
    </div>
    <div class="span2 err banner" id="formErr" hidden></div>
    <div class="span2"><button class="btn primary" type="submit">${e ? 'Save changes' : 'Save event'}</button></div>
  </form></article>`;
}

async function events() {
  const [ev, cl] = await Promise.all([api('/events'), api('/clients')]);
  const list = (ev.events || []).map((e) => ({
    id: e.id,
    title: e.name,
    meta: `${e.client_name} · ${e.kind === 'once' ? 'one-time' : 'recurring'} · ${e.summary}`
  }));
  const r = rail('Events', list, state.param === 'new' ? '' : state.param, 'No registered events yet.');
  if (state.param === 'new') {
    return { rail: r, main: `<div class="top"><div><h1>Register event</h1><p class="sub">One date or a repeating pattern. Times use start and end, and cannot overlap on the same client calendar.</p></div></div>${eventEditor(cl, null)}` };
  }
  if (!state.param) return { rail: r, main: hint('Events', 'Registered events are unique. Select one to view or edit its definition.') };
  const d = await api(`/events/${state.param}`);
  if (!d.ok) return { rail: r, main: `<p class="err">${d.error}</p>` };
  const e = d.event;
  return { rail: r, main: `<div class="top"><div><h1>${e.name}</h1><p class="sub"><a href="#/clients/${e.client_id}">${e.client_name}</a> · ${e.kind === 'once' ? 'One-time' : 'Recurring'} · ${e.summary} · ${e.timezone}</p></div>${badge(e.kind)}</div>${eventEditor(cl, e)}` };
}

function parseCalParam() {
  const m = String(state.param || '').match(/^(\d{4})-(\d{2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderCalendarGrid(year, month, occurrences) {
  const first = new Date(year, month - 1, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;

  const byDay = {};
  for (const occ of occurrences) {
    const d = new Date(occ.starts_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    byDay[key] = byDay[key] || [];
    byDay[key].push(occ);
  }

  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  for (let i = startPad - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, other: true, events: [] });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${month - 1}-${day}`;
    cells.push({
      day,
      other: false,
      today: key === todayKey,
      events: byDay[key] || []
    });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: nextDay++, other: true, events: [] });
  }

  const dows = WEEKDAYS.map((d) => `<div class="cal-dow">${d.slice(0, 3)}</div>`).join('');
  const days = cells.map((cell) => {
    const evs = cell.events.map((o) =>
      `<a class="cal-ev" href="#/events/${o.event_id}" title="${o.client_name}">${fmtClock(o.starts_at)} ${o.event_name}</a>`
    ).join('');
    return `<div class="cal-day${cell.other ? ' other' : ''}${cell.today ? ' today' : ''}">
      <span class="cal-num">${cell.day}</span>
      <div class="cal-evs">${evs}</div>
    </div>`;
  }).join('');

  return `<div class="cal-grid">${dows}${days}</div>`;
}

async function calendar() {
  const { year, month } = parseCalParam();
  if (state.param && !String(state.param).match(/^\d{4}-\d{2}$/)) {
    return { rail: '', wide: true, main: `<p class="err">Invalid month.</p>` };
  }
  const data = await api(`/calendar?year=${year}&month=${month}`);
  if (!data.ok) return { rail: '', wide: true, main: `<p class="err">${data.error}</p>` };
  const label = new Date(year, month - 1, 1).toLocaleString([], { month: 'long', year: 'numeric' });
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  return {
    rail: '',
    wide: true,
    main: `<div class="top calendar-top">
      <div><h1>Calendar</h1><p class="sub">All scheduled events</p></div>
      <div class="calendar-nav">
        <button class="btn" data-action="cal-prev" data-year="${year}" data-month="${month}">← Prev</button>
        <span class="calendar-title">${label}</span>
        <button class="btn" data-action="cal-next" data-year="${year}" data-month="${month}">Next →</button>
      </div>
    </div>
    <article class="card calendar-card">${renderCalendarGrid(year, month, data.occurrences || [])}</article>`
  };
}

async function staff() {
  const [pe, cl] = await Promise.all([api('/people'), api('/clients')]);
  const list = (pe.people || []).map((p) => ({ id: p.id, title: p.name, meta: `${p.role}${p.client_name ? ' · ' + p.client_name : ''}` }));
  const r = rail('Staff', list, state.param === 'new' ? '' : state.param, 'No staff yet.');
  if (state.param === 'new') {
    return { rail: r, main: `<div class="top"><div><h1>New staff member</h1><p class="sub">Engineers, volunteers, and operators.</p></div></div>
      <article class="card"><form class="form-grid" data-form="staff">
        <div><label>Name</label><input name="name" required /></div>
        <div><label>Email</label><input name="email" type="email" required /></div>
        <div><label>Role</label><select name="role"><option value="engineer">Engineer</option><option value="volunteer">Volunteer</option><option value="operator">Operator</option><option value="contact">Contact</option></select></div>
        <div><label>Client</label><select name="clientId"><option value="">None (ops-wide)</option>${(cl.clients || []).map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
        <div class="span2"><label>Phone</label><input name="phone" /></div>
        <div class="span2"><button class="btn primary" type="submit">Save staff member</button></div>
      </form></article>` };
  }
  if (!state.param) return { rail: r, main: hint('Staff', 'Everyone who can be assigned to a service.') };
  const d = await api(`/people/${state.param}`);
  if (!d.ok) return { rail: r, main: `<p class="err">${d.error}</p>` };
  const p = d.person;
  return { rail: r, main: `<div class="top"><div><h1>${p.name}</h1><p class="sub">${p.email}</p></div>${badge(p.role)}</div>
    <article class="card"><h2>Details</h2>
      <p>Role: ${p.role}</p>
      <p>Client: ${p.client_name ? `<a href="#/clients/${p.client_id}">${p.client_name}</a>` : 'Ops-wide'}</p>
      <p>Phone: ${p.phone || '—'}</p>
    </article>` };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function formatDb(db) {
  if (db == null || db <= -100) return '−∞';
  const n = Number(db);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`;
}

const MCU_FADER_KNOTS = [
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
  midi = Math.max(0, Math.min(16383, Number(midi) || 0));
  for (let i = 1; i < MCU_FADER_KNOTS.length; i++) {
    if (midi <= MCU_FADER_KNOTS[i].midi) {
      const span = MCU_FADER_KNOTS[i].midi - MCU_FADER_KNOTS[i - 1].midi;
      const t = span > 0 ? (midi - MCU_FADER_KNOTS[i - 1].midi) / span : 0;
      return MCU_FADER_KNOTS[i - 1].db + t * (MCU_FADER_KNOTS[i].db - MCU_FADER_KNOTS[i - 1].db);
    }
  }
  return 10;
}

function sliderFromTrack(t) {
  if (!t || t.midi == null || t.midi < 0) return 0;
  return Math.max(0, Math.min(16383, t.midi));
}

const faderMotion = new Map();
let faderMotionRaf = 0;
const FADER_TAU_MS = 70;

function stopFaderMotion(el) {
  if (el) faderMotion.delete(el);
  if (!faderMotion.size && faderMotionRaf) {
    cancelAnimationFrame(faderMotionRaf);
    faderMotionRaf = 0;
  }
}

function tickFaderMotion(now) {
  faderMotionRaf = 0;
  for (const [el, job] of faderMotion) {
    if (!el.isConnected || el.dataset.dragging === '1') {
      faderMotion.delete(el);
      continue;
    }
    const dt = Math.min(48, Math.max(0, now - job.last));
    job.last = now;
    job.display += (job.target - job.display) * (1 - Math.exp(-dt / FADER_TAU_MS));
    if (Math.abs(job.target - job.display) < 1.5) {
      el.value = String(Math.round(job.target));
      faderMotion.delete(el);
      continue;
    }
    el.value = String(Math.round(job.display));
  }
  if (faderMotion.size) faderMotionRaf = requestAnimationFrame(tickFaderMotion);
}

function easeFaderTo(el, target) {
  const to = Math.max(0, Math.min(16383, target));
  const job = faderMotion.get(el);
  if (job) {
    job.target = to;
  } else {
    const display = Number(el.value) || 0;
    if (Math.abs(display - to) < 1.5) {
      el.value = String(to);
      return;
    }
    faderMotion.set(el, { display, target: to, last: performance.now() - 16 });
  }
  if (!faderMotionRaf) faderMotionRaf = requestAnimationFrame(tickFaderMotion);
}

function mixerStripKey(mixer) {
  const tracks = (mixer && mixer.tracks) || [];
  return `${(mixer && mixer.pages || []).length}:${mixer && mixer.pageIndex || 0}:${mixer && mixer.scanning ? 1 : 0}:${tracks.map((t) => t.name || '').join('|')}`;
}

function mixerStripHtml(t) {
  const live = t.master || t.live;
  const rec = t.master
    ? ''
    : `<div class="mixer-btns">
      <button type="button" class="mixer-rec${t.rec ? ' armed' : ''}" data-action="mixer-rec" data-index="${t.index}" ${live ? '' : 'disabled'} title="Arm for recording">R</button>
      <button type="button" class="mixer-listen${t.listen ? ' on' : ''}" data-action="mixer-listen" data-index="${t.index}" ${live ? '' : 'disabled'} title="Input monitoring (MCU Shift + Rec/Rdy)">IN</button>
    </div>`;
  return `<div class="mixer-strip${live ? ' is-live' : ' is-view'}" data-page="${t.page}" data-live="${live ? '1' : '0'}">
    <div class="mixer-name">${escapeHtml(t.name || '—')}</div>
    ${rec}
    <div class="mixer-fader-well">
      <input type="range" class="mixer-fader" min="0" max="16383" step="1"
        value="${sliderFromTrack(t)}" data-fader data-index="${t.index}"
        data-master="${t.master ? '1' : '0'}" data-live="${live ? '1' : '0'}"
        ${t.master || live ? '' : 'tabindex="-1"'} />
    </div>
    <div class="mixer-db">${t.known ? formatDb(t.db) : '—'}</div>
    ${t.master || live ? '' : '<div class="mixer-view-tag">view</div>'}
  </div>`;
}

function mixerBoardHtml(mixer) {
  const pages = mixer.pages || [];
  if (!pages.length && !(mixer.tracks || []).length)
    return '<p class="sub">Waiting for Mackie Control…</p>';
  const groups = pages.map((page) => {
    const strips = (page.tracks || []).map(mixerStripHtml).join('');
    return `<section class="mixer-page${page.live ? ' is-live' : ''}" data-page="${page.index}">
      <button type="button" class="mixer-page-label" data-action="mixer-focus" data-page="${page.index}">
        ${escapeHtml(page.name || `MCU ${page.index + 1}`)}
      </button>
      <div class="mixer-page-strips">${strips}</div>
    </section>`;
  }).join('');
  const master = (mixer.tracks || []).find((t) => t.master);
  return `${groups}${master ? mixerStripHtml(master) : ''}`;
}

function mixerStatusText(mixer) {
  if (!mixer) return 'No mixer data yet.';
  if (!mixer.connected) return 'Companion offline. Sign in on the machine, then open the mixer.';
  if (mixer.scanning) return mixer.scanLabel || mixer.status || 'Building mixer…';
  const bits = [];
  if (mixer.linked) bits.push('Linked to DAW');
  else bits.push(mixer.status || 'Waiting for Mackie Control');
  if (mixer.pageCount) bits.push(`${mixer.pageCount} live surfaces (32 channels)`);
  if (mixer.hint) bits.push(mixer.hint);
  return bits.join(' · ');
}

function mixerNoiseMidi(m) {
  const t = m.text || '';
  if (t.startsWith('pitch ') || t.startsWith('meter ')) return true;
  if (t.startsWith('7-seg') || t.startsWith('vpot ring')) return true;
  if (t.includes('connection query') || t.includes('host query')) return true;
  const hex = String(m.hex || '').toLowerCase().replace(/\s/g, '');
  if (hex.startsWith('b0') && hex.length >= 4) {
    const cc = parseInt(hex.slice(2, 4), 16);
    if (cc >= 0x30 && cc <= 0x37) return true;
    if (cc >= 0x40 && cc <= 0x4b) return true;
  }
  return false;
}

function collapseMixerLog(rows) {
  const out = [];
  let lastKey = '';
  let count = 0;
  for (const row of rows) {
    const key = row.replace(/^\d{2}:\d{2}:\d{2}\s+/, '');
    if (key === lastKey) {
      count += 1;
      continue;
    }
    if (count > 1) out[out.length - 1] += `  ×${count}`;
    out.push(row);
    lastKey = key;
    count = 1;
  }
  if (count > 1) out[out.length - 1] += `  ×${count}`;
  return out;
}

function mixerDebugHtml(mixer) {
  const d = mixer.debug || {};
  const ago = d.lastHostMs == null ? 'never' : `${Math.round(d.lastHostMs / 100) / 10}s ago`;
  const meta = [
    `scan=${d.scan || '—'}`,
    `linked=${d.linked ? 'yes' : 'no'}`,
    `device=0x${(d.deviceId != null ? d.deviceId : 0).toString(16)}`,
    `bank=${d.bankOffset ?? '—'}`,
    `in=${d.inCount ?? 0}`,
    `out=${d.outCount ?? 0}`,
    `listen=${d.listenMode || 'none'}`,
    `last DAW MIDI=${ago}`,
    `LCD [${d.lcd || 'empty'}]`
  ].join('  ·  ');
  let msgs = d.messages || [];
  if (state.mixerInOnly) msgs = msgs.filter((m) => m.dir === 'in');
  if (state.mixerHideMeters) msgs = msgs.filter((m) => !mixerNoiseMidi(m));
  if (state.sniffUntil && Date.now() < state.sniffUntil) {
    for (const m of msgs) {
      if (m.dir !== 'in' || mixerNoiseMidi(m) || m.t < (state.sniffStart || 0) - 50) continue;
      const line = `${m.text}    ${m.hex}`;
      if (!state.sniffHits.includes(line)) state.sniffHits.push(line);
    }
  }
  const rows = collapseMixerLog(msgs.map((m) => {
    const time = new Date(m.t).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dir = m.dir === 'out' ? 'OUT → DAW' : 'IN  ← DAW';
    return `${time}  ${dir.padEnd(10)}  ${m.text}    ${m.hex}`;
  }));
  return { meta, log: rows.join('\n') || 'No MIDI in this filter. Move a fader or bank; for listen sniff, hide meters and watch IN ← DAW.' };
}

function patchMixer(mixer) {
  const status = $('#mixerStatus');
  if (status) status.textContent = mixerStatusText(mixer);
  const scanEl = $('#mixerScan');
  if (scanEl) {
    scanEl.hidden = !mixer.scanning;
    const label = scanEl.querySelector('.mixer-scan-label');
    if (label) label.textContent = mixer.scanLabel || 'Building mixer…';
  }
  if (state.mixerMonitor) {
    const dbg = mixerDebugHtml(mixer);
    const meta = $('#mixerDebugMeta');
    if (meta) meta.textContent = dbg.meta;
    const log = $('#mixerDebugLog');
    if (log) {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.textContent = dbg.log;
      if (stick) log.scrollTop = log.scrollHeight;
    }
  }
  const board = $('#mixerBoard');
  if (!board) return;
  const tracks = mixer.tracks || [];
  const key = mixerStripKey(mixer);
  if (board.dataset.sig !== key) {
    faderMotion.clear();
    if (faderMotionRaf) {
      cancelAnimationFrame(faderMotionRaf);
      faderMotionRaf = 0;
    }
    board.dataset.sig = key;
    board.innerHTML = mixerBoardHtml(mixer);
    bindMixerFaders();
    return;
  }
  for (const t of tracks) {
    const el = board.querySelector(`[data-fader][data-index="${t.index}"][data-master="${t.master ? '1' : '0'}"]`);
    if (!el) continue;
    const strip = el.closest('.mixer-strip') || el.parentElement;
    strip.classList.toggle('is-live', Boolean(t.live || t.master));
    strip.classList.toggle('is-view', !t.live && !t.master);
    el.dataset.live = t.live || t.master ? '1' : '0';
    const rec = strip.querySelector('.mixer-rec');
    if (rec) rec.classList.toggle('armed', Boolean(t.rec));
    const listen = strip.querySelector('.mixer-listen');
    if (listen) listen.classList.toggle('on', Boolean(t.listen));
    const nameEl = strip.querySelector('.mixer-name');
    if (nameEl) nameEl.textContent = t.name || '—';
    if (el.dataset.dragging === '1' || Number(el.dataset.echoUntil || 0) > Date.now()) continue;
    easeFaderTo(el, sliderFromTrack(t));
    const dbEl = strip.querySelector('.mixer-db');
    if (dbEl) dbEl.textContent = t.known ? formatDb(t.db) : '—';
  }
}

function applyMixerPayload(payload) {
  if (state.view !== 'endpoints' || state.sub !== 'mixer') return;
  if (payload.endpointId !== state.param) return;
  patchMixer(payload);
}

function bindMixerFaders() {
  const board = $('#mixerBoard');
  if (!board || board.dataset.bound === '1') return;
  board.dataset.bound = '1';
  let dragEl = null;
  board.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('[data-fader]');
    if (!el) return;
    if (el.dataset.master !== '1' && el.dataset.live !== '1') {
      const page = Number(el.closest('[data-page]')?.dataset.page);
      if (Number.isInteger(page))
        api(`/endpoints/${state.param}/mixer/focus`, { method: 'POST', body: { page } });
      ev.preventDefault();
      return;
    }
    dragEl = el;
    el.dataset.dragging = '1';
    delete el.dataset.echoUntil;
    stopFaderMotion(el);
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  const send = (el, touching) => {
    if (!el) return;
    const dbEl = el.closest('.mixer-strip')?.querySelector('.mixer-db');
    const midi = Math.max(0, Math.min(16383, Number(el.value) || 0));
    const db = midiToDb(midi);
    if (dbEl) dbEl.textContent = formatDb(db);
    api(`/endpoints/${state.param}/mixer/fader`, {
      method: 'POST',
      body: {
        index: Number(el.dataset.index),
        master: el.dataset.master === '1',
        midi,
        touching
      }
    });
  };
  board.addEventListener('input', (ev) => {
    const el = dragEl || ev.target.closest('[data-fader]');
    if (!el) return;
    if (dragEl && el !== dragEl) return;
    const now = Date.now();
    if (now - Number(el.dataset.lastSend || 0) < 40) return;
    el.dataset.lastSend = String(now);
    send(el, true);
  });
  const endTouch = (ev) => {
    const el = dragEl || ev.target.closest?.('[data-fader]') || board.querySelector('[data-dragging="1"]');
    if (!el || el.dataset.dragging !== '1') return;
    el.dataset.dragging = '0';
    el.dataset.echoUntil = String(Date.now() + 350);
    dragEl = null;
    send(el, false);
  };
  board.addEventListener('pointerup', endTouch);
  board.addEventListener('pointercancel', endTouch);
  window.addEventListener('pointerup', endTouch);
}

async function endpoints() {
  const [ep, cl] = await Promise.all([api('/endpoints'), api('/clients')]);
  const items = ep.endpoints || [];
  const r = `<aside class="rail">
    <div class="rail-head"><h2>Endpoints</h2></div>
    <div class="rail-list">
      ${items.map((e) => endpointRailItem(e, state.param)).join('') || '<p class="rail-empty">No endpoints yet.</p>'}
    </div>
  </aside>`;
  if (state.param === 'new') {
    location.hash = '#/endpoints';
    return { rail: r, main: hint('Endpoints', 'Companions appear here after they sign in. Assign each one to a client.') };
  }
  if (!state.param) {
    return {
      rail: r,
      main: `<div class="top"><div><h1>Endpoints</h1><p class="sub">A companion installation that has signed into an AsaphOps account. They cannot be created here.</p></div></div>
        <article class="card"><p class="sub">Launch the AsaphOps companion, sign in, then assign the machine to a client from this list.</p></article>`
    };
  }
  const d = await api(`/endpoints/${state.param}`);
  if (!d.ok) return { rail: r, main: `<p class="err">${d.error}</p>` };
  const e = d.endpoint;
  const clientLabel = e.client_id
    ? `<a href="#/clients/${e.client_id}">${e.client_name}</a>`
    : 'Unassigned';
  if (state.sub === 'mixer') {
    const mix = await api(`/endpoints/${e.id}/mixer`);
    const mixer = mix.mixer || { connected: e.connected, tracks: [] };
    const dbg = mixerDebugHtml(mixer);
    return {
      rail: r,
      main: `<div class="top"><div><h1>${e.name} mixer</h1>
        <p class="sub">${clientLabel} · MCU + three extenders = 32 live faders. Bank ←/→ moves all four desks together for tracks 33+.</p></div>
        ${connectionBadge(e.connected, e.id)}</div>
        <article class="card mixer-card">
          <div class="mixer-toolbar">
            <p class="sub" id="mixerStatus">${mixerStatusText(mixer)}</p>
            <div class="mixer-actions">
              <button class="btn" type="button" data-action="mixer-bank" data-dir="left" title="MCU Bank Left">Bank ←</button>
              <button class="btn" type="button" data-action="mixer-bank" data-dir="right" title="MCU Bank Right">Bank →</button>
              <button class="btn" type="button" data-action="mixer-scan" data-id="${e.id}">Refresh surfaces</button>
              <button class="btn" type="button" data-action="mixer-monitor">${state.mixerMonitor ? 'Hide MIDI monitor' : 'MIDI monitor'}</button>
              <a class="btn" href="#/endpoints/${e.id}">Back to endpoint</a>
            </div>
          </div>
          <div class="mixer-scan" id="mixerScan" ${mixer.scanning ? '' : 'hidden'}>
            <div class="mixer-scan-spin" aria-hidden="true"></div>
            <p class="mixer-scan-label">${escapeHtml(mixer.scanLabel || 'Building mixer…')}</p>
          </div>
          <div class="mixer-board" id="mixerBoard" data-sig="${mixerStripKey(mixer)}">${mixerBoardHtml(mixer)}</div>
        </article>
        <article class="card mixer-debug" id="mixerDebug" ${state.mixerMonitor ? '' : 'hidden'}>
          <h2>MIDI monitor</h2>
          <p class="sub">Click <strong>Sniff DAW listen</strong>, then toggle the speaker on a track in the DAW (not the web IN button). Only <code>IN ← DAW</code> notes/CC/sysex are captured.</p>
          <div class="mixer-actions">
            <button class="btn" type="button" data-action="mixer-sniff">Sniff DAW listen</button>
            <button class="btn${state.mixerInOnly ? ' on' : ''}" type="button" data-action="mixer-in-only">IN only</button>
            <button class="btn${state.mixerHideMeters ? ' on' : ''}" type="button" data-action="mixer-hide-meters">Hide meters/displays</button>
            <button class="btn" type="button" data-action="mixer-listen-map" data-mode="none">IN: no MIDI</button>
            <button class="btn" type="button" data-action="mixer-listen-map" data-mode="shift-rec">IN: Shift+Rec</button>
          </div>
          <p class="sub" id="mixerSniffHint">${escapeHtml(state.sniffResult || 'Listen MIDI is off until a sniff finds a message, or you enable Shift+Rec for Logic/Cubase.')}</p>
          <p class="sub" id="mixerDebugMeta">${state.mixerMonitor ? escapeHtml(dbg.meta) : ''}</p>
          <pre class="mixer-debug-log" id="mixerDebugLog">${state.mixerMonitor ? escapeHtml(dbg.log) : ''}</pre>
        </article>`
    };
  }
  return { rail: r, main: `<div class="top"><div><h1>${e.name}</h1><p class="sub">${clientLabel} · ${e.code || '—'}</p></div>${connectionBadge(e.connected, e.id)}</div>
    <article class="card"><h2>Machine</h2>
      <p>Hostname: ${e.hostname || '—'}</p>
      <p>OS: ${e.os || '—'}</p>
      <p>App version: ${e.app_version || '—'}</p>
      <p>Machine ID: ${e.machine_id || '—'}</p>
      <p>Last seen: <span data-endpoint-last-seen="${e.id}">${fmtTime(e.last_seen_at)}</span></p>
      <p>Signed in as: ${e.person_name || e.person_email || '—'}</p>
    </article>
    <article class="card"><h2>Mixer</h2>
      <p class="sub">The mixer shows 32 live Mackie channels (MCU + XT1–XT3). Rebuild and restart the companion so those ports exist, then add three Mackie Control Extenders in the DAW. Restart the ops server to pick up mixer changes.</p>
      <p><a class="btn primary" href="#/endpoints/${e.id}/mixer">Open mixer</a></p>
    </article>
    <article class="card"><h2>Assign to client</h2>
      <form class="form-grid" data-form="assign-endpoint">
        <div class="span2"><label>Client</label>
          <select name="clientId">
            <option value="">Unassigned</option>
            ${(cl.clients || []).map((c) => `<option value="${c.id}" ${e.client_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="span2 err banner" id="formErr" hidden></div>
        <div class="span2"><button class="btn primary" type="submit">Save assignment</button></div>
      </form></article>
    <article class="card"><h2>Details</h2>
      <p>Notes: ${e.notes || '—'}</p>
      <div data-endpoint-remove="${e.id}">${e.connected
        ? '<p class="sub">Sign out or close the companion before removing this endpoint.</p>'
        : `<button class="btn danger" type="button" data-action="remove-endpoint" data-id="${e.id}">Remove</button>`}</div>
    </article>` };
}

window.addEventListener('hashchange', route);
document.getElementById('root').addEventListener('click', onAction);
route();
