(function () {
  'use strict';

  const TOKEN_KEY = 'lms_admin_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let listenWs = null;
  let listenHandle = null;

  const loginView = document.getElementById('loginView');
  const dashboard = document.getElementById('dashboard');
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  const adminPassword = document.getElementById('adminPassword');

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...authHeaders(), ...(opts.headers || {}) }
    });
    if (res.status === 401) {
      logout();
      throw new Error('Unauthorized');
    }
    return res.json();
  }

  function showDashboard() {
    loginView.style.display = 'none';
    dashboard.style.display = 'flex';
    refresh();
  }

  function logout() {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    loginView.style.display = 'block';
    dashboard.style.display = 'none';
  }

  loginBtn.addEventListener('click', async () => {
    loginError.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword.value })
      });
      const data = await res.json();
      if (!data.success) {
        loginError.textContent = data.error || 'Login failed';
        return;
      }
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      showDashboard();
    } catch (e) {
      loginError.textContent = e.message;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) {}
    logout();
  });
  document.getElementById('refreshBtn').addEventListener('click', refresh);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  async function refresh() {
    const [sessionsRes, metricsRes, instancesRes, hierRes, auditRes] = await Promise.all([
      api('/api/admin/sessions'),
      fetch('/api/metrics').then((r) => r.json()),
      api('/api/admin/instances'),
      fetch('/api/hierarchy').then((r) => r.json()),
      api('/api/admin/audit')
    ]);

    document.getElementById('statStreams').textContent = sessionsRes.count || 0;
    document.getElementById('statListeners').textContent = metricsRes.metrics?.activeListeners || 0;
    document.getElementById('statInstances').textContent = instancesRes.count || 0;
    document.getElementById('statGroups').textContent = (hierRes.groups || []).length;
    document.getElementById('statTraffic').textContent = `${metricsRes.metrics?.totalOutboundMB || '0.00'} MB`;
    document.getElementById('statHeap').textContent = `${metricsRes.server?.heapUsedMB || 0} MB`;

    renderStreams(sessionsRes.sessions || []);
    renderInstances(instancesRes.instances || []);
    renderHierarchy(hierRes.groups || []);
    renderAudit(auditRes.entries || []);
  }

  function renderStreams(sessions) {
    const body = document.getElementById('streamsBody');
    body.innerHTML = '';
    sessions.forEach((s) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${s.sessionId}</code></td>
        <td>${escapeHtml(s.title)}</td>
        <td>${escapeHtml(s.status)}</td>
        <td>${s.activeListeners}</td>
        <td>${s.audioSpec?.bitrate || '-'} kbps</td>
        <td>
          <button class="btn" data-listen="${s.sessionId}">Listen</button>
          <a class="btn" href="/s/${s.sessionId}" target="_blank">Open</a>
          <button class="btn danger" data-end="${s.sessionId}">End</button>
        </td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-listen]').forEach((btn) => {
      btn.addEventListener('click', () => listenTo(btn.dataset.listen));
    });
    body.querySelectorAll('[data-end]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/admin/sessions/${btn.dataset.end}/end`, { method: 'POST' });
        refresh();
      });
    });
  }

  function renderInstances(instances) {
    const q = (document.getElementById('instanceSearch').value || '').toLowerCase();
    const filtered = !q ? instances : instances.filter((i) =>
      JSON.stringify(i).toLowerCase().includes(q)
    );
    const body = document.getElementById('instancesBody');
    body.innerHTML = '';
    filtered.forEach((i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(i.trackName)}</td>
        <td><code>${i.instanceId.slice(0, 8)}…</code></td>
        <td>${escapeHtml(i.mode)}</td>
        <td>${escapeHtml(i.sessionId || i.streamSessionId || '')}</td>
        <td>${escapeHtml(i.groupId)}</td>
        <td>${escapeHtml(i.role)}</td>
        <td>${escapeHtml(i.status)}</td>
        <td>${escapeHtml(i.os)}</td>
        <td><button class="btn danger" data-disc="${i.instanceId}">Disconnect</button></td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-disc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/admin/instances/${btn.dataset.disc}/disconnect`, { method: 'POST' });
        refresh();
      });
    });
  }

  document.getElementById('instanceSearch').addEventListener('input', refresh);

  function renderHierarchy(groups) {
    const root = document.getElementById('adminHierarchy');
    root.innerHTML = groups.map((g) => {
      const tracks = (g.tracks || []).filter((t) => t.mode !== 'Streaming' && t.mode !== 'streaming');
      return `
      <div style="margin-bottom:16px">
        <h3 style="margin:0 0 8px">Session ${escapeHtml(g.sessionId || '?')} · ${escapeHtml(g.groupId)}</h3>
        <div class="track-grid">${tracks.map((t) =>
          `<button class="track-btn ${t.unducked ? 'unducked' : 'ducked'}" data-tog-s="${escapeHtml(g.sessionId)}" data-tog-g="${escapeHtml(g.groupId)}" data-tog-i="${t.instanceId}">${escapeHtml(t.trackName)}</button>`
        ).join('') || '<p style="color:var(--text-muted)">No Track Control plugins</p>'}</div>
      </div>`;
    }).join('') || '<p style="color:var(--text-muted)">No session hierarchy yet</p>';

    root.querySelectorAll('[data-tog-s]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api('/api/admin/hierarchy/toggle', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: btn.dataset.togS,
            groupId: btn.dataset.togG,
            instanceId: btn.dataset.togI
          })
        });
        refresh();
      });
    });
  }

  function renderAudit(entries) {
    const body = document.getElementById('auditBody');
    body.innerHTML = entries.map((e) => `
      <tr>
        <td>${escapeHtml(e.timestamp)}</td>
        <td>${escapeHtml(e.admin)}</td>
        <td>${escapeHtml(e.action)}</td>
        <td>${escapeHtml(e.target)}</td>
        <td>${escapeHtml(e.result)}</td>
      </tr>`).join('');
  }

  async function listenTo(sessionId) {
    stopListen();
    document.getElementById('listenBox').style.display = 'block';
    document.getElementById('listenTitle').textContent = `Listening to ${sessionId}`;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    listenWs = new WebSocket(`${protocol}//${location.host}/ws?role=listener&session=${sessionId}`);
    listenWs.binaryType = 'arraybuffer';

    const audio = document.getElementById('adminAudio');
    listenWs.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'INIT' && msg.sfuReady && window.mediasoupClient) {
            // reuse listener WebRTC bootstrap via app pattern — keep simple WS for admin preview if needed
          }
        } catch (_) {}
        return;
      }
      // PCM fallback preview via Web Audio
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const f32 = new Float32Array(ev.data);
        const buf = ctx.createBuffer(2, f32.length / 2, 48000);
        for (let ch = 0; ch < 2; ch++) {
          const data = buf.getChannelData(ch);
          for (let i = 0; i < data.length; i++) data[i] = f32[i * 2 + ch] || 0;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      } catch (_) {}
    };
  }

  function stopListen() {
    if (listenWs) { try { listenWs.close(); } catch (_) {} listenWs = null; }
    if (listenHandle) { try { listenHandle.close(); } catch (_) {} listenHandle = null; }
    const audio = document.getElementById('adminAudio');
    audio.srcObject = null;
    document.getElementById('listenBox').style.display = 'none';
  }
  document.getElementById('stopListenBtn').addEventListener('click', stopListen);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (token) showDashboard();
  setInterval(() => { if (token) refresh().catch(() => {}); }, 5000);
})();
