const TOKEN_KEY = 'asaphix_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  view: 'ops',
  data: {},
  error: ''
};

function $(sel, el = document) { return el.querySelector(sel); }

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: state.token ? `Bearer ${state.token}` : '',
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    location.hash = '#/login';
  }
  return data;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function badge(status) {
  const s = String(status || '').toLowerCase();
  let cls = '';
  if (s === 'live' || s === 'accepted' || s === 'activated' || s === 'passed') cls = 'live';
  else if (s === 'degraded' || s === 'pending' || s === 'starting' || s === 'planned') cls = 'warn';
  else if (s === 'failed' || s === 'offline' || s === 'revoked' || s === 'declined') cls = 'bad';
  return `<span class="badge ${cls}">${status || 'unknown'}</span>`;
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || (state.token ? 'ops' : 'login');
  const [view, id] = hash.split('/');
  state.view = view;
  state.param = id;
  render();
}

function navItems(role) {
  const all = [
    ['ops', 'Operations', ['owner', 'administrator', 'supervisor']],
    ['engineer', 'My services', ['engineer']],
    ['volunteer', 'Site checks', ['volunteer']],
    ['schedule', 'Schedule', ['owner', 'administrator', 'supervisor']],
    ['people', 'People', ['owner', 'administrator']],
    ['locations', 'Locations', ['owner', 'administrator']],
    ['endpoints', 'Endpoints', ['owner', 'administrator', 'supervisor']],
    ['capacity', 'Stream channels', ['owner', 'administrator', 'supervisor']],
    ['audit', 'Audit & usage', ['owner', 'administrator', 'supervisor']],
    ['org', 'Organization', ['owner']]
  ];
  return all.filter(([, , roles]) => roles.includes(role));
}

function shell(content, rail) {
  if (!state.me) return content;
  const role = state.me.membership.role;
  const items = navItems(role).map(([id, label]) =>
    `<a href="#/${id}" class="${state.view === id ? 'active' : ''}">${label}</a>`
  ).join('');
  return `<div class="app${rail ? ' with-rail' : ''}">
    <aside class="sidebar">
      <div class="brand"><strong>Asaphix</strong><span>Live audio operations</span></div>
      <nav>${items}</nav>
      <div class="userbox">
        <div>${state.me.user.name}</div>
        <div class="muted">${role} · ${state.me.organization.name}</div>
        <button class="btn" style="margin-top:10px" id="logoutBtn">Sign out</button>
      </div>
    </aside>
    ${rail || ''}
    <main class="main">${content}</main>
  </div>`;
}

function loginView(mode = 'login') {
  return `<div class="auth"><form class="auth-card" id="authForm">
    <h1>Asaphix</h1>
    <p class="sub">Coordinate PA support across every campus without paying per named account.</p>
    ${mode === 'signup' ? `<label>Organization</label><input name="organizationName" required />` : ''}
    <label>Name</label><input name="name" ${mode === 'login' ? '' : 'required'} style="${mode === 'login' ? 'display:none' : ''}" />
    <label>Email</label><input name="email" type="email" required value="owner@demo.asaphix" />
    <label>Password</label><input name="password" type="password" required value="demo-owner" />
    <div class="err" id="authErr"></div>
    <button class="btn primary" style="width:100%;margin-top:12px">${mode === 'signup' ? 'Create organization' : 'Sign in'}</button>
    <p class="sub" style="margin-top:14px">${mode === 'signup'
      ? `Already have an account? <a href="#/login">Sign in</a>`
      : `New organization? <a href="#/signup">Create one</a>`}</p>
    <p class="sub">Demo: owner@demo.asaphix / demo-owner · supervisor@demo.asaphix / demo-supervisor · engineer1@demo.asaphix / demo-engineer</p>
  </form></div>`;
}

async function loadMe() {
  if (!state.token) return null;
  const data = await api('/me');
  if (!data.success) return null;
  state.me = data;
  return data;
}

async function render() {
  const root = document.getElementById('root');
  if (!state.token && state.view !== 'signup' && state.view !== 'invite') {
    root.innerHTML = loginView('login');
    bindAuth('login');
    return;
  }
  if (state.view === 'signup') {
    root.innerHTML = loginView('signup');
    bindAuth('signup');
    return;
  }
  if (state.view === 'invite') {
    root.innerHTML = `<div class="auth"><form class="auth-card" id="inviteForm">
      <h1>Accept invitation</h1>
      <label>Name</label><input name="name" required />
      <label>Password</label><input name="password" type="password" required />
      <div class="err" id="authErr"></div>
      <button class="btn primary" style="width:100%;margin-top:12px">Join organization</button>
    </form></div>`;
    $('#inviteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = await api('/invitations/accept', { method: 'POST', body: { acceptToken: state.param, name: fd.get('name'), password: fd.get('password') } });
      if (!data.success) { $('#authErr').textContent = data.error; return; }
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      location.hash = '#/ops';
    });
    return;
  }

  if (!state.me) await loadMe();
  if (!state.me) {
    root.innerHTML = loginView('login');
    bindAuth('login');
    return;
  }

  const role = state.me.membership.role;
  if (state.view === 'ops' && role === 'engineer') state.view = 'engineer';
  if (state.view === 'ops' && role === 'volunteer') state.view = 'volunteer';
  if (state.view === 'ops' && role === 'viewer') state.view = 'engineer';

  const views = { ops, engineer, volunteer, schedule, people, locations, endpoints, capacity, audit, org, session: sessionView };
  const fn = views[state.view] || ops;
  root.innerHTML = shell(`<p class="sub">Loading…</p>`);
  try {
    const result = await fn();
    const html = typeof result === 'string' ? result : result.html;
    const rail = typeof result === 'string' ? null : result.rail;
    root.innerHTML = shell(html, rail);
    bindShell();
  } catch (err) {
    root.innerHTML = shell(`<p class="err">${err.message}</p>`);
    bindShell();
  }
}

function bindAuth(mode) {
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    const data = await api(mode === 'signup' ? '/auth/register' : '/auth/login', { method: 'POST', body });
    if (!data.success) { $('#authErr').textContent = data.error; return; }
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    state.me = null;
    location.hash = '#/ops';
    route();
  });
}

function bindShell() {
  const out = $('#logoutBtn');
  if (out) out.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.token = '';
    state.me = null;
    localStorage.removeItem(TOKEN_KEY);
    location.hash = '#/login';
  });
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', onAction);
  });
  document.querySelectorAll('form[data-form]').forEach((form) => {
    form.addEventListener('submit', onForm);
  });
}

async function onAction(ev) {
  const el = ev.currentTarget;
  const action = el.dataset.action;
  const id = el.dataset.id;
  if (action === 'start') {
    const data = await api('/sessions/start', { method: 'POST', body: { eventId: id, endpointId: el.dataset.endpoint || undefined } });
    alert(data.success ? (data.duplicate ? 'Already live on this service.' : 'Stream channel acquired.') : (data.error || 'Start failed'));
  } else if (action === 'end') {
    if (!confirm('End this live session and release the stream channel?')) return;
    const reason = prompt('Reason', 'Service ended') || 'stopped';
    await api(`/sessions/${id}/end`, { method: 'POST', body: { reason } });
  } else if (action === 'takeover') {
    const reason = prompt('Takeover reason', 'Supervisor covering');
    if (!reason) return;
    await api(`/sessions/${id}/takeover`, { method: 'POST', body: { reason } });
  } else if (action === 'reassign') {
    const userId = prompt('User ID to assign as controlling engineer');
    const reason = prompt('Reason');
    if (!userId || !reason) return;
    await api(`/sessions/${id}/reassign`, { method: 'POST', body: { userId, reason } });
  } else if (action === 'preflight') {
    const data = await api('/preflight', { method: 'POST', body: { eventId: id, endpointId: el.dataset.endpoint || undefined } });
    state.data.lastPreflight = data;
  } else if (action === 'ack') {
    await api(`/alerts/${id}/ack`, { method: 'POST', body: { notes: 'Acknowledged from operations' } });
  } else if (action === 'decide') {
    await api(`/assignments/${id}/decide`, { method: 'POST', body: { accept: el.dataset.accept === '1' } });
  } else if (action === 'listen') {
    window.open(el.dataset.url, '_blank');
  } else if (action === 'talkback') {
    await api('/talkback/signal', { method: 'POST', body: { sessionId: id, speaking: true } });
    alert('Talkback presence signaled. Program audio is unchanged.');
  } else if (action === 'note') {
    const body = prompt('Incident note');
    if (!body) return;
    await api(`/sessions/${id}/incidents`, { method: 'POST', body: { body } });
  } else if (action === 'revoke-ep') {
    if (!confirm('Revoke this endpoint?')) return;
    await api(`/endpoints/${id}/revoke`, { method: 'POST' });
  } else if (action === 'activate-ep') {
    const data = await api(`/endpoints/${id}/activation`, { method: 'POST' });
    alert(data.success ? `Activation code (30 min): ${data.activationCode}` : data.error);
  } else if (action === 'cancel-event') {
    if (!confirm('Cancel this service event?')) return;
    await api(`/events/${id}/cancel`, { method: 'POST' });
  }
  route();
}

async function onForm(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const kind = form.dataset.form;
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  if (kind === 'invite') {
    if (body.locationScope) body.locationScope = body.locationScope.split(',').map((s) => s.trim()).filter(Boolean);
    const data = await api('/invitations', { method: 'POST', body });
    alert(data.success ? `Invite created. Share ${location.origin}/app#/invite/${data.acceptToken}` : data.error);
  } else if (kind === 'location') {
    await api('/locations', { method: 'POST', body });
  } else if (kind === 'room') {
    await api('/rooms', { method: 'POST', body });
  } else if (kind === 'endpoint') {
    const data = await api('/endpoints', { method: 'POST', body });
    alert(data.success ? `Created. Activation code: ${data.activationCode}` : data.error);
  } else if (kind === 'template') {
    body.weekday = Number(body.weekday);
    body.durationMin = Number(body.durationMin || 75);
    body.setupMin = Number(body.setupMin || 30);
    body.preflightMin = Number(body.preflightMin || 20);
    body.teardownMin = Number(body.teardownMin || 15);
    const data = await api('/templates', { method: 'POST', body });
    if (!data.success) {
      alert(data.error || 'Could not create event');
      return;
    }
    location.hash = `#/schedule/${data.template.id}`;
    return;
  } else if (kind === 'assign') {
    await api(`/events/${body.eventId}/assignments`, { method: 'PUT', body: { userId: body.userId, duty: body.duty } });
  } else if (kind === 'override') {
    body.concurrentStreams = Number(body.concurrentStreams);
    await api('/capacity/override', { method: 'POST', body });
  } else if (kind === 'org') {
    await api('/org', { method: 'PATCH', body });
  }
  route();
}

function dutyLine(assignments = []) {
  return assignments.map((a) => `${a.duty}: ${a.name} (${a.status})`).join(' · ') || 'Unassigned';
}

async function ops() {
  const data = await api('/ops');
  if (!data.success) return `<p class="err">${data.error}</p>`;
  const cap = data.capacity;
  const cards = data.cards.map((c) => {
    const st = c.runtime ? c.runtime.status : c.event.status;
    const liveId = c.session && c.session.id;
    const listen = c.runtime ? `/s/${c.runtime.sessionId}` : '';
    const audio = c.runtime && c.runtime.audioSpec
      ? `${c.runtime.audioSpec.sampleRate} Hz · ${c.runtime.audioSpec.channels} ch · ${c.runtime.audioSpec.bitrate} kbps`
      : 'No live audio yet';
    return `<article class="card">
      <div class="row">
        <div>
          <h2>${c.event.name} · ${c.event.location_name}</h2>
          <p class="sub">${c.event.room_name || 'Room'} · ${fmtTime(c.event.starts_at)} · ${dutyLine(c.assignments)}</p>
        </div>
        ${badge(st)}
      </div>
      <p class="sub" style="margin:10px 0">${audio}${c.runtime ? ` · listeners ${c.runtime.listeners}` : ''}</p>
      <div class="wrap">
        <button class="btn" data-action="preflight" data-id="${c.event.id}">Preflight</button>
        <button class="btn primary" data-action="start" data-id="${c.event.id}">Start / acquire channel</button>
        ${listen ? `<button class="btn" data-action="listen" data-url="${listen}">Listen</button>` : ''}
        ${liveId ? `<button class="btn" data-action="talkback" data-id="${liveId}">Talkback signal</button>` : ''}
        ${liveId ? `<button class="btn" data-action="reassign" data-id="${liveId}">Reassign</button>` : ''}
        ${liveId ? `<button class="btn" data-action="takeover" data-id="${liveId}">Take over</button>` : ''}
        ${liveId ? `<button class="btn" data-action="note" data-id="${liveId}">Incident note</button>` : ''}
        ${liveId ? `<button class="btn danger" data-action="end" data-id="${liveId}">End session</button>` : ''}
      </div>
      ${(c.alerts || []).map((a) => `<p class="sub" style="margin-top:8px">${badge(a.severity)} ${a.message} <button class="btn" data-action="ack" data-id="${a.id}">Ack</button></p>`).join('')}
    </article>`;
  }).join('') || `<article class="card"><p class="sub">No services in the current operations window. Add a schedule to materialize events.</p></article>`;

  const pf = state.data.lastPreflight;
  return `<div class="top"><div><h1>Operations</h1><p class="sub">All services in the setup-to-teardown window. Capacity is enforced by the server.</p></div></div>
    <div class="metrics">
      <div class="metric"><div class="lbl">Channels used</div><div class="val">${cap.used} / ${cap.limit}</div></div>
      <div class="metric"><div class="lbl">Available</div><div class="val">${cap.available}</div></div>
      <div class="metric"><div class="lbl">Services in window</div><div class="val">${data.cards.length}</div></div>
      <div class="metric"><div class="lbl">Open alerts</div><div class="val">${data.cards.reduce((n, c) => n + (c.alerts || []).length, 0)}</div></div>
    </div>
    ${pf ? `<article class="card"><h2>Last preflight · ${pf.status}</h2><div class="checks">${pf.checks.map((c) => `<div class="check"><span>${c.label}</span><span class="${c.ok ? 'ok' : 'fail'}">${c.ok ? 'Pass' : 'Fail'} · ${c.detail}</span></div>`).join('')}</div></article>` : ''}
    <div class="cards">${cards}</div>`;
}

async function engineer() {
  const data = await api('/events');
  const rows = (data.events || []).map((e) => {
    const mine = (e.assignments || []).filter((a) => a.email && state.me.user.email === a.email || a.user_id === state.me.user.id);
    return `<article class="card">
      <div class="row"><div><h2>${e.name} · ${e.location_name}</h2><p class="sub">${fmtTime(e.starts_at)} · ${dutyLine(e.assignments)}</p></div>${badge(e.status)}</div>
      <div class="wrap" style="margin-top:10px">
        ${mine.map((a) => a.status === 'pending' ? `<button class="btn primary" data-action="decide" data-id="${a.id}" data-accept="1">Accept</button><button class="btn" data-action="decide" data-id="${a.id}" data-accept="0">Decline</button>` : '').join('')}
        <button class="btn" data-action="preflight" data-id="${e.id}">Run preflight</button>
        <button class="btn primary" data-action="start" data-id="${e.id}">Start service</button>
      </div>
    </article>`;
  }).join('');
  return `<div class="top"><div><h1>Assigned services</h1><p class="sub">Accept work, run preflight, then acquire a stream channel only when the service is ready.</p></div></div><div class="cards">${rows || '<article class="card"><p class="sub">No assignments.</p></article>'}</div>`;
}

async function volunteer() {
  const data = await api('/events');
  const eps = await api('/endpoints');
  const rows = (data.events || []).map((e) => `<article class="card">
    <h2>${e.name} · ${e.location_name}</h2>
    <p class="sub">${fmtTime(e.starts_at)}</p>
    <button class="btn" data-action="preflight" data-id="${e.id}">Guided site check</button>
  </article>`).join('');
  return `<div class="top"><div><h1>Local site checks</h1><p class="sub">Confirm the endpoint and input path before the engineer takes the service live.</p></div></div>
    <article class="card"><h2>Endpoints</h2>${(eps.endpoints || []).map((e) => `<p>${e.name} ${badge(e.status)}</p>`).join('')}</article>
    <div class="cards">${rows || '<article class="card"><p class="sub">No upcoming local services.</p></article>'}</div>`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function scheduleRail(templates, selectedId) {
  const items = (templates || []).map((t) => `
    <a class="rail-item${selectedId === t.id ? ' active' : ''}" href="#/schedule/${t.id}">
      <span class="title">${t.name}</span>
      <span class="meta">${t.location_name}${t.room_name ? ' · ' + t.room_name : ''} · ${WEEKDAYS[t.weekday] || ''} ${t.start_local}</span>
    </a>`).join('');
  return `<aside class="rail">
    <div class="rail-head">
      <h2>Registered events</h2>
      <a class="btn primary" href="#/schedule/new">Create new</a>
    </div>
    <div class="rail-list">
      ${items || '<p class="rail-empty">No registered events yet.</p>'}
    </div>
  </aside>`;
}

function templateCreateForm(locs) {
  const rooms = locs.rooms || [];
  return `<div class="top"><div><h1>Register event</h1><p class="sub">A registered event is the service definition. Upcoming dates are generated from it and stay listed separately.</p></div></div>
    <article class="card">
      <form class="form-grid" data-form="template">
        <div class="span2"><label>Name</label><input name="name" placeholder="Sunday Morning" required /></div>
        <div><label>Location</label><select name="locationId">${(locs.locations || []).map((l) => `<option value="${l.id}">${l.name}</option>`).join('')}</select></div>
        <div><label>Room</label><select name="roomId"><option value="">None</option>${rooms.map((r) => {
          const loc = (locs.locations || []).find((l) => l.id === r.location_id);
          return `<option value="${r.id}">${loc ? loc.name + ' · ' : ''}${r.name}</option>`;
        }).join('')}</select></div>
        <div><label>Weekday</label><select name="weekday">${WEEKDAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></div>
        <div><label>Start time</label><input name="startLocal" value="10:00" required /></div>
        <div><label>Duration (min)</label><input name="durationMin" type="number" value="75" /></div>
        <div><label>Setup (min before)</label><input name="setupMin" type="number" value="30" /></div>
        <div><label>Preflight (min before)</label><input name="preflightMin" type="number" value="20" /></div>
        <div><label>Teardown (min after)</label><input name="teardownMin" type="number" value="15" /></div>
        <div class="span2"><button class="btn primary" type="submit">Save registered event</button></div>
      </form>
    </article>`;
}

function templateDetail(tpl, occurrences, people) {
  return `<div class="top"><div>
      <h1>${tpl.name}</h1>
      <p class="sub">${tpl.location_name}${tpl.room_name ? ' · ' + tpl.room_name : ''} · ${WEEKDAYS[tpl.weekday] || ''} ${tpl.start_local} · ${tpl.duration_min} min · ${tpl.timezone}</p>
    </div>${badge(tpl.enabled ? 'active' : 'disabled')}</div>
    <article class="card">
      <h2>Definition</h2>
      <p class="sub">Setup ${tpl.setup_min} min before · preflight ${tpl.preflight_min} min before · teardown ${tpl.teardown_min} min after · every ${tpl.interval_weeks} week(s)</p>
    </article>
    <article class="card"><h2>Assign personnel to an occurrence</h2>
      <form class="form-grid" data-form="assign">
        <select name="eventId">${occurrences.map((e) => `<option value="${e.id}">${fmtTime(e.starts_at)}</option>`).join('') || '<option value="">No upcoming dates</option>'}</select>
        <select name="duty"><option value="primary">Primary engineer</option><option value="backup">Backup</option><option value="volunteer">Local volunteer</option></select>
        <select name="userId">${(people.people || []).map((p) => `<option value="${p.id}">${p.name} (${p.role})</option>`).join('')}</select>
        <button class="btn primary" type="submit"${occurrences.length ? '' : ' disabled'}>Assign</button>
      </form>
    </article>
    <article class="card"><h2>Upcoming occurrences</h2>
      <table><thead><tr><th>When</th><th>Status</th><th>Staff</th><th></th></tr></thead><tbody>
      ${occurrences.map((e) => `<tr><td>${fmtTime(e.starts_at)}</td><td>${badge(e.status)}</td><td>${dutyLine(e.assignments)}</td><td><button class="btn" data-action="cancel-event" data-id="${e.id}">Cancel</button></td></tr>`).join('') || '<tr><td colspan="4">None materialized yet.</td></tr>'}
      </tbody></table>
    </article>`;
}

async function schedule() {
  const [ev, tpl, locs, people] = await Promise.all([api('/events'), api('/templates'), api('/locations'), api('/engineers')]);
  const templates = tpl.templates || [];
  const rail = scheduleRail(templates, state.param === 'new' ? null : state.param);

  if (state.param === 'new') {
    return { rail, html: templateCreateForm(locs) };
  }

  const selected = templates.find((t) => t.id === state.param);
  if (!selected) {
    return {
      rail,
      html: `<div class="top"><div><h1>Schedule</h1><p class="sub">Registered events are unique service definitions. Occurrences of those events appear after you select one.</p></div></div>
        <article class="card"><p class="sub">${templates.length ? 'Select a registered event in the list, or create a new one.' : 'Create a registered event to start scheduling services.'}</p></article>`
    };
  }

  const occurrences = (ev.events || []).filter((e) => e.template_id === selected.id);
  return { rail, html: templateDetail(selected, occurrences, people) };
}

async function people() {
  const data = await api('/people');
  return `<div class="top"><div><h1>People</h1><p class="sub">Accounts are free to create. You pay for concurrent stream channels.</p></div></div>
    <article class="card"><h2>Invite</h2>
      <form class="form-grid" data-form="invite">
        <input name="email" type="email" placeholder="Email" required />
        <input name="name" placeholder="Name" />
        <select name="role"><option>engineer</option><option>supervisor</option><option>administrator</option><option>volunteer</option><option>viewer</option></select>
        <button class="btn primary" type="submit">Send invite</button>
      </form>
    </article>
    <article class="card"><h2>Members</h2>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
      <tbody>${(data.members || []).map((m) => `<tr><td>${m.name}</td><td>${m.email}</td><td>${m.role}</td></tr>`).join('')}</tbody></table>
    </article>`;
}

async function locations() {
  const data = await api('/locations');
  return `<div class="top"><div><h1>Locations</h1><p class="sub">Campuses, rooms, and the spaces endpoints belong to.</p></div></div>
    <article class="card"><h2>Add location</h2>
      <form class="form-grid" data-form="location"><input name="name" placeholder="Name" required /><input name="timezone" value="America/Chicago" /><input class="span2" name="address" placeholder="Address" /><button class="btn primary" type="submit">Add</button></form>
    </article>
    <article class="card"><h2>Add room</h2>
      <form class="form-grid" data-form="room">
        <select name="locationId">${(data.locations || []).map((l) => `<option value="${l.id}">${l.name}</option>`).join('')}</select>
        <input name="name" placeholder="Sanctuary" required />
        <button class="btn primary" type="submit">Add room</button>
      </form>
    </article>
    <article class="card"><h2>Inventory</h2>
      ${(data.locations || []).map((l) => `<p><strong>${l.name}</strong> · ${l.timezone}<br>${(data.rooms || []).filter((r) => r.location_id === l.id).map((r) => r.name).join(', ') || 'No rooms'}</p>`).join('')}
    </article>`;
}

async function endpoints() {
  const [eps, locs] = await Promise.all([api('/endpoints'), api('/locations')]);
  return `<div class="top"><div><h1>Endpoints</h1><p class="sub">Activation codes issue identity. The plugin protocol remains compatible; commercial identity is stored here.</p></div></div>
    <article class="card"><h2>Register endpoint</h2>
      <form class="form-grid" data-form="endpoint">
        <input name="name" placeholder="Sanctuary bridge" required />
        <select name="locationId">${(locs.locations || []).map((l) => `<option value="${l.id}">${l.name}</option>`).join('')}</select>
        <select name="type"><option value="plugin">DAW plugin</option><option value="bridge">Desktop bridge</option></select>
        <button class="btn primary" type="submit">Create + activation code</button>
      </form>
    </article>
    <article class="card"><h2>Inventory</h2>
      <table><thead><tr><th>Name</th><th>Code</th><th>Status</th><th></th></tr></thead>
      <tbody>${(eps.endpoints || []).map((e) => `<tr><td>${e.name}</td><td>${e.public_code || ''}</td><td>${badge(e.status)}</td><td><button class="btn" data-action="activate-ep" data-id="${e.id}">New code</button> <button class="btn danger" data-action="revoke-ep" data-id="${e.id}">Revoke</button></td></tr>`).join('')}</tbody></table>
    </article>`;
}

async function capacity() {
  const [cap, usage] = await Promise.all([api('/capacity'), api('/usage')]);
  return `<div class="top"><div><h1>Stream channels</h1><p class="sub">One purchased concurrent live stream. Duplicate start requests return the existing lease.</p></div></div>
    <div class="metrics">
      <div class="metric"><div class="lbl">Purchased</div><div class="val">${cap.limit}</div></div>
      <div class="metric"><div class="lbl">In use</div><div class="val">${cap.used}</div></div>
      <div class="metric"><div class="lbl">Available</div><div class="val">${cap.available}</div></div>
      <div class="metric"><div class="lbl">Source</div><div class="val" style="font-size:1rem">${cap.entitlement && cap.entitlement.source}</div></div>
    </div>
    ${state.me.membership.role === 'owner' ? `<article class="card"><h2>Support override</h2>
      <form class="form-grid" data-form="override"><input name="concurrentStreams" type="number" min="1" required /><input name="reason" placeholder="Reason" required /><button class="btn" type="submit">Apply override</button></form>
    </article>` : ''}
    <article class="card"><h2>Active leases</h2>
      <table><thead><tr><th>State</th><th>Event</th><th>Acquired</th><th>Expires</th></tr></thead>
      <tbody>${(cap.leases || []).map((l) => `<tr><td>${badge(l.state)}</td><td>${l.event_id || '—'}</td><td>${fmtTime(l.acquired_at)}</td><td>${fmtTime(l.expires_at)}</td></tr>`).join('') || '<tr><td colspan="4">None</td></tr>'}</tbody>
    </table></article>
    <article class="card"><h2>Usage</h2>
      <table><thead><tr><th>Started</th><th>Ended</th><th>Reason</th></tr></thead>
      <tbody>${(usage.usage || []).map((u) => `<tr><td>${fmtTime(u.started_at)}</td><td>${fmtTime(u.ended_at)}</td><td>${u.end_reason || ''}</td></tr>`).join('') || '<tr><td colspan="3">None yet</td></tr>'}</tbody>
    </table></article>`;
}

async function audit() {
  const data = await api('/audit?limit=80');
  return `<div class="top"><div><h1>Audit</h1><p class="sub">Privileged actions record the actual actor.</p></div></div>
    <article class="card"><table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Resource</th></tr></thead>
    <tbody>${(data.entries || []).map((e) => `<tr><td>${fmtTime(e.created_at)}</td><td>${e.action}</td><td>${e.actor_user_id || ''}</td><td>${e.resource_type || ''} ${e.resource_id || ''}</td></tr>`).join('')}</tbody></table></article>`;
}

async function org() {
  const org = state.me.organization;
  return `<div class="top"><div><h1>Organization</h1><p class="sub">${org.slug}</p></div></div>
    <article class="card"><form data-form="org" class="form-grid">
      <input name="name" value="${org.name}" />
      <input name="timezone" value="${org.timezone}" />
      <button class="btn primary" type="submit">Save</button>
    </form></article>`;
}

async function sessionView() {
  const data = await api(`/sessions/${state.param}`);
  if (!data.success) return `<p class="err">${data.error}</p>`;
  const s = data.session;
  return `<div class="top"><div><h1>Session</h1><p class="sub">${s.runtime_code} · ${s.state}</p></div>${badge(s.state)}</div>
    <article class="card"><div class="wrap">
      <button class="btn" data-action="listen" data-url="/s/${s.runtime_code}">Open monitor</button>
      <button class="btn danger" data-action="end" data-id="${s.id}">End</button>
    </div></article>`;
}

window.addEventListener('hashchange', route);
route();
