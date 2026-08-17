const TOKEN_KEY = 'asaphops_token';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  view: 'clients',
  param: '',
  liveStream: null,
  liveStreamGen: 0
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
  const [view, param] = hash.split('/');
  if (view === 'locations') {
    location.hash = `#/endpoints${param ? `/${param}` : ''}`;
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
  state.param = param || '';
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
  return { rail: r, main: `<div class="top"><div><h1>${e.name}</h1><p class="sub">${clientLabel} · ${e.code || '—'}</p></div>${connectionBadge(e.connected, e.id)}</div>
    <article class="card"><h2>Machine</h2>
      <p>Hostname: ${e.hostname || '—'}</p>
      <p>OS: ${e.os || '—'}</p>
      <p>App version: ${e.app_version || '—'}</p>
      <p>Machine ID: ${e.machine_id || '—'}</p>
      <p>Last seen: <span data-endpoint-last-seen="${e.id}">${fmtTime(e.last_seen_at)}</span></p>
      <p>Signed in as: ${e.person_name || e.person_email || '—'}</p>
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
