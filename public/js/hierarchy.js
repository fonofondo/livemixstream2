(function () {
  'use strict';

  const groupsRoot = document.getElementById('groupsRoot');
  const connStatus = document.getElementById('connStatus');
  let groups = [];
  let ws = null;

  function setConnected(ok) {
    connStatus.textContent = ok ? '● CONNECTED' : '● DISCONNECTED';
    connStatus.className = 'conn ' + (ok ? 'ok' : 'bad');
  }

  function controlTracks(group) {
    return (group.tracks || []).filter((t) => t.mode !== 'Streaming' && t.mode !== 'streaming');
  }

  function render() {
    groupsRoot.innerHTML = '';
    if (!groups.length) {
      groupsRoot.innerHTML = `<div class="group-card"><p style="color:var(--text-muted)">No tracks yet. Insert Track Control plugins on DAW tracks.</p></div>`;
      return;
    }

    groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'group-card';
      const tracks = controlTracks(group);
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:1.1rem">${escapeHtml(group.groupId)}</h2>
        </div>
        <div class="track-grid"></div>
      `;
      const grid = card.querySelector('.track-grid');
      if (!tracks.length) {
        grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No Track Control plugins in this group.</p>';
      } else {
        tracks.forEach((t) => {
          const btn = document.createElement('button');
          btn.className = 'track-btn ' + (t.unducked ? 'unducked' : 'ducked');
          btn.innerHTML = `<strong>${escapeHtml(t.trackName)}</strong>`;
          btn.addEventListener('click', () => toggleTrack(group, t.instanceId));
          grid.appendChild(btn);
        });
      }
      groupsRoot.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function upsertGroup(state) {
    const idx = groups.findIndex((g) => g.groupId === state.groupId);
    if (idx >= 0) groups[idx] = state;
    else groups.push(state);
    render();
  }

  async function toggleTrack(group, instanceId) {
    const payload = {
      type: 'TOGGLE_TRACK',
      groupId: group.groupId,
      instanceId,
      sessionId: group.sessionId
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      await fetch('/api/hierarchy/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      refresh();
    }
  }

  async function refresh() {
    const res = await fetch('/api/hierarchy');
    const data = await res.json();
    if (data.success) {
      groups = data.groups || [];
      render();
    }
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws?role=hierarchy-ui`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 2000);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'HIERARCHY_SNAPSHOT') {
          groups = msg.groups || [];
          render();
        } else if (msg.type === 'HIERARCHY_STATE') {
          upsertGroup(msg);
        }
      } catch (_) {}
    };
  }

  refresh();
  connect();
})();
