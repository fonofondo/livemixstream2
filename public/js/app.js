(function () {
  'use strict';

  const sessionIdDisplay = document.getElementById('sessionIdDisplay');
  const sessionTitleDisplay = document.getElementById('sessionTitleDisplay');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const playHint = document.getElementById('playHint');
  const muteBtn = document.getElementById('muteBtn');
  const volumeIcon = document.getElementById('volumeIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const canvas = document.getElementById('audioCanvas');
  const latencySelect = document.getElementById('latencySelect');
  const specFormatDisplay = document.getElementById('specFormatDisplay');
  const specLatencyDisplay = document.getElementById('specLatencyDisplay');
  const specBitrateDisplay = document.getElementById('specBitrateDisplay');
  const canvasCtx = canvas ? canvas.getContext('2d') : null;

  function getSessionIdFromUrl() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2 && pathParts[0] === 's') return pathParts[1].toUpperCase();
    const params = new URLSearchParams(window.location.search);
    return (params.get('session') || 'DEMO7F').toUpperCase();
  }

  const sessionId = getSessionIdFromUrl();
  sessionIdDisplay.textContent = sessionId;

  let targetBufferSeconds = 0.2;
  if (latencySelect) {
    latencySelect.innerHTML = `
      <option value="0.05">Ultra-Low (~50 ms buffer)</option>
      <option value="0.1">Low (~100 ms)</option>
      <option value="0.2" selected>Standard (~200 ms)</option>
      <option value="0.5">Safe (~500 ms)</option>
    `;
    const saved = localStorage.getItem('livemixstream_target_latency');
    if (saved) {
      latencySelect.value = saved;
      targetBufferSeconds = parseFloat(saved);
    }
    latencySelect.addEventListener('change', () => {
      targetBufferSeconds = parseFloat(latencySelect.value);
      localStorage.setItem('livemixstream_target_latency', String(targetBufferSeconds));
      nextPlayTime = 0;
    });
  }

  let isPlaying = false;
  let isMuted = false;
  let currentVolume = parseFloat(volumeSlider ? volumeSlider.value : 0.85);
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let audioCtx = null;
  let gainNode = null;
  let analyserNode = null;
  let nextPlayTime = 0;
  let audioSpec = { sampleRate: 48000, channels: 2, bitrate: 256 };
  let mediaMode = 'websocket';
  let webrtcHandle = null;
  let remoteAudio = null;

  const PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
  const PAUSE_SVG = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  const VOL_HIGH_SVG = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  const VOL_MUTED_SVG = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';

  function initAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx({ sampleRate: audioSpec.sampleRate || 48000 });
      gainNode = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 128;
      gainNode.gain.value = isMuted ? 0 : currentVolume;
      gainNode.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
      drawVisualizer();
    } else if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function drawVisualizer() {
    if (!canvasCtx || !canvas) return;
    requestAnimationFrame(drawVisualizer);
    const width = canvas.width = canvas.parentElement.clientWidth;
    const height = canvas.height = canvas.parentElement.clientHeight;
    canvasCtx.clearRect(0, 0, width, height);
    if (!analyserNode || !isPlaying) {
      canvasCtx.beginPath();
      canvasCtx.strokeStyle = 'rgba(99, 102, 241, 0.2)';
      canvasCtx.lineWidth = 2;
      const time = Date.now() * 0.003;
      for (let x = 0; x < width; x += 5) {
        const y = height / 2 + Math.sin(x * 0.02 + time) * 6;
        if (x === 0) canvasCtx.moveTo(x, y); else canvasCtx.lineTo(x, y);
      }
      canvasCtx.stroke();
      return;
    }
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserNode.getByteFrequencyData(dataArray);
    const barWidth = (width / bufferLength) * 2;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * (height * 0.85);
      const gradient = canvasCtx.createLinearGradient(0, height, 0, height - barHeight);
      gradient.addColorStop(0, '#6366f1');
      gradient.addColorStop(1, '#ec4899');
      canvasCtx.fillStyle = gradient;
      canvasCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);
      x += barWidth;
    }
  }

  function playAudioChunk(arrayBuffer) {
    if (!audioCtx || !isPlaying) return;
    // Prefer WebRTC only when it is actively producing audible media
    if (mediaMode === 'webrtc' && webrtcHandle && remoteAudio && !remoteAudio.paused && remoteAudio.srcObject)
      return;
    try {
      const float32Array = new Float32Array(arrayBuffer);
      if (float32Array.length === 0) return;
      const numChannels = audioSpec.channels || 2;
      const frameCount = float32Array.length / numChannels;
      const audioBuffer = audioCtx.createBuffer(numChannels, frameCount, audioCtx.sampleRate);
      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < frameCount; i++) channelData[i] = float32Array[i * numChannels + ch] || 0;
      }
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      const currentTime = audioCtx.currentTime;
      if (nextPlayTime < currentTime) nextPlayTime = currentTime + targetBufferSeconds;
      else if (nextPlayTime > currentTime + targetBufferSeconds + 0.15) nextPlayTime = currentTime + targetBufferSeconds;
      source.start(nextPlayTime);
      nextPlayTime += audioBuffer.duration;
      if (specLatencyDisplay) {
        specLatencyDisplay.textContent = `~${Math.round((nextPlayTime - currentTime) * 1000)} ms`;
      }
    } catch (_) {
      audioCtx.decodeAudioData(arrayBuffer.slice(0), (decoded) => {
        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(gainNode);
        const currentTime = audioCtx.currentTime;
        if (nextPlayTime < currentTime) nextPlayTime = currentTime + targetBufferSeconds;
        source.start(nextPlayTime);
        nextPlayTime += decoded.duration;
      }, () => {});
    }
  }

  async function startWebRtc(wsConn) {
    if (!window.mediasoupClient) throw new Error('mediasoup-client missing');
    const device = new window.mediasoupClient.Device();

    const waitFor = (type) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ' + type)), 10000);
      const handler = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === type) {
            clearTimeout(t);
            wsConn.removeEventListener('message', handler);
            resolve(msg);
          } else if (msg.type === 'ERROR') {
            clearTimeout(t);
            wsConn.removeEventListener('message', handler);
            reject(new Error(msg.error));
          }
        } catch (_) {}
      };
      wsConn.addEventListener('message', handler);
    });

    wsConn.send(JSON.stringify({ type: 'WEBRTC_GET_CAPABILITIES' }));
    const caps = await waitFor('WEBRTC_CAPABILITIES');
    await device.load({ routerRtpCapabilities: caps.rtpCapabilities });

    wsConn.send(JSON.stringify({ type: 'WEBRTC_CREATE_TRANSPORT' }));
    const transportMsg = await waitFor('WEBRTC_TRANSPORT');
    const recvTransport = device.createRecvTransport(transportMsg.params);

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      const onConnected = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'WEBRTC_CONNECTED') {
            wsConn.removeEventListener('message', onConnected);
            callback();
          } else if (msg.type === 'ERROR') {
            wsConn.removeEventListener('message', onConnected);
            errback(new Error(msg.error));
          }
        } catch (_) {}
      };
      wsConn.addEventListener('message', onConnected);
      wsConn.send(JSON.stringify({ type: 'WEBRTC_CONNECT_TRANSPORT', dtlsParameters }));
    });

    wsConn.send(JSON.stringify({ type: 'WEBRTC_CONSUME', rtpCapabilities: device.rtpCapabilities }));
    const consumerMsg = await waitFor('WEBRTC_CONSUMER');
    const consumer = await recvTransport.consume(consumerMsg.params);

    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.autoplay = true;
    }
    const stream = new MediaStream([consumer.track]);
    remoteAudio.srcObject = stream;
    remoteAudio.volume = isMuted ? 0 : currentVolume;
    await remoteAudio.play().catch(() => {});

    // Feed analyser via MediaStreamSource when possible
    try {
      initAudioContext();
      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(analyserNode);
    } catch (_) {}

    mediaMode = 'webrtc';
    if (specLatencyDisplay) specLatencyDisplay.textContent = '~WebRTC jitter buffer';
    return {
      close() {
        try { consumer.close(); } catch (_) {}
        try { recvTransport.close(); } catch (_) {}
      }
    };
  }

  async function fetchSessionDetails() {
    try {
      const res = await fetch(`/api/session/${sessionId}`);
      const data = await res.json();
      if (data.success) {
        sessionTitleDisplay.textContent = data.title || 'Live Mix Session';
        if (data.audioSpec) { audioSpec = data.audioSpec; updateSpecDisplay(); }
        if (data.mediaMode) mediaMode = data.mediaMode;
        if (data.hierarchy) applyHierarchyPayload(data.hierarchy);
        updateStatus(data.status);
      } else {
        sessionTitleDisplay.textContent = 'Session Inactive';
        updateStatus('Disconnected');
      }
    } catch (e) {
      console.warn('session API', e.message);
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?role=listener&session=${sessionId}`;
    updateStatus('Connecting');
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectAttempts = 0;
      setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
        }
      }, 4000);

      if (isPlaying && (mediaMode === 'webrtc' || mediaMode === 'hybrid' || mediaMode === 'plain')) {
        startWebRtc(ws).then((h) => { webrtcHandle = h; mediaMode = 'webrtc'; }).catch((err) => {
          console.warn('WebRTC unavailable, using WS PCM fallback', err.message);
          mediaMode = 'websocket';
        });
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'INIT' || msg.type === 'AUDIO_CONFIG') {
            if (msg.title) sessionTitleDisplay.textContent = msg.title;
            if (msg.audioSpec) { audioSpec = msg.audioSpec; updateSpecDisplay(); }
            if (msg.status) updateStatus(msg.status);
            if (msg.mediaMode) mediaMode = msg.mediaMode;
            // Prefer WebSocket PCM when available; WebRTC is optional enhancement
            if (msg.mediaMode === 'plain') mediaMode = 'hybrid';
            if (msg.sfuReady === false) mediaMode = 'websocket';
            if (msg.hierarchy) applyHierarchyPayload(msg.hierarchy);
          } else if (msg.type === 'HIERARCHY_STATE') {
            upsertHierarchyGroup(msg);
          } else if (msg.type === 'SESSION_STATE') {
            updateStatus(msg.status);
            if (msg.hierarchy) applyHierarchyPayload(msg.hierarchy);
          } else if (msg.type === 'PONG') {
            const rtt = Date.now() - msg.clientTimestamp;
            if (mediaMode === 'websocket' && audioCtx) {
              const bufferDepthMs = Math.max(0, Math.round((nextPlayTime - audioCtx.currentTime) * 1000));
              const effectiveLatencyMs = Math.round(rtt / 2) + bufferDepthMs;
              specLatencyDisplay.textContent = `~${effectiveLatencyMs} ms`;
              ws.send(JSON.stringify({ type: 'CLIENT_TELEMETRY', effectiveLatencyMs, rttMs: rtt, bufferDepthMs }));
            } else {
              specLatencyDisplay.textContent = `~${Math.round(rtt / 2) + 40} ms RTT/2`;
              ws.send(JSON.stringify({ type: 'CLIENT_TELEMETRY', effectiveLatencyMs: Math.round(rtt / 2) + 40, rttMs: rtt }));
            }
          }
        } catch (err) {
          console.error(err);
        }
      } else if (event.data instanceof ArrayBuffer) {
        playAudioChunk(event.data);
      }
    };

    ws.onclose = () => {
      updateStatus('Disconnected');
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
    reconnectTimer = setTimeout(connectWebSocket, delay);
  }

  function updateStatus(status) {
    statusBadge.className = 'status-badge';
    const s = String(status || '');
    if (s === 'Live') {
      statusBadge.classList.add('live');
      statusText.textContent = '● LIVE';
      dawOnline = true;
    } else if (s === 'Connecting') {
      statusBadge.classList.add('connecting');
      statusText.textContent = 'CONNECTING';
    } else if (s === 'Waiting' || s === 'Created') {
      statusBadge.classList.add('connecting');
      statusText.textContent = 'DAW ONLINE · WAITING FOR STREAM';
      dawOnline = true;
    } else if (s === 'Offline' || s === 'Disconnected' || s === 'Ended' || s === 'Expired') {
      statusBadge.classList.add('disconnected');
      statusText.textContent = '● DAW OFFLINE';
      dawOnline = false;
      hierarchyGroups = [];
    } else {
      statusBadge.classList.add('disconnected');
      statusText.textContent = s.toUpperCase() || 'DISCONNECTED';
      dawOnline = false;
    }
    paintTracks();
  }

  function updateSpecDisplay() {
    const rateKb = audioSpec.sampleRate ? `${Math.round(audioSpec.sampleRate / 1000)}k` : '48k';
    const ch = audioSpec.channels === 1 ? 'Mono' : 'Stereo';
    specFormatDisplay.textContent = `${rateKb} · ${ch}`;
    specBitrateDisplay.textContent = `${audioSpec.bitrate || 256} kbps`;
  }

  let hierarchyGroups = [];
  let dawOnline = false;

  function applyHierarchyPayload(payload) {
    if (!payload) {
      hierarchyGroups = [];
      paintTracks();
      return;
    }
    if (Array.isArray(payload))
      hierarchyGroups = payload;
    else if (payload.groups)
      hierarchyGroups = payload.groups;
    else if (payload.tracks)
      hierarchyGroups = [payload];
    else
      hierarchyGroups = [];
    paintTracks();
  }

  function upsertHierarchyGroup(state) {
    if (!state) return;
    const idx = hierarchyGroups.findIndex((g) => g.groupId === state.groupId);
    if (idx >= 0) hierarchyGroups[idx] = state;
    else hierarchyGroups.push(state);
    paintTracks();
  }

  function controlTracks(group) {
    return (group.tracks || []).filter((t) => t.mode !== 'Streaming' && t.mode !== 'streaming');
  }

  function paintTracks() {
    const root = document.getElementById('hierarchyTracks');
    if (!root) return;
    root.innerHTML = '';
    if (!dawOnline) {
      root.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;grid-column:1/-1">DAW offline — tracks appear when the Streaming plugin is connected.</p>';
      return;
    }
    const byId = new Map();
    for (const group of hierarchyGroups) {
      controlTracks(group || {}).forEach((t) => {
        if (t && t.instanceId) byId.set(t.instanceId, { ...t, groupId: group.groupId || 'default' });
      });
    }
    const tracks = Array.from(byId.values());
    if (!tracks.length) {
      root.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;grid-column:1/-1">No Track Control plugins linked yet.</p>';
      return;
    }
    tracks.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'track-btn ' + (t.unducked ? 'unducked' : 'ducked');
      btn.innerHTML = `<strong>${escapeHtml(t.trackName)}</strong>`;
      btn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'TOGGLE_TRACK', instanceId: t.instanceId, groupId: t.groupId || 'default' }));
        }
      });
      root.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  playBtn.addEventListener('click', async () => {
    isPlaying = !isPlaying;
    if (isPlaying) {
      initAudioContext();
      playIcon.innerHTML = PAUSE_SVG;
      playHint.textContent = 'Listening live';
      if (ws && ws.readyState === WebSocket.OPEN && (mediaMode === 'webrtc' || mediaMode === 'hybrid' || mediaMode === 'plain')) {
        try {
          webrtcHandle = await startWebRtc(ws);
          mediaMode = 'webrtc';
        } catch (err) {
          console.warn(err.message);
          mediaMode = 'websocket';
        }
      }
    } else {
      playIcon.innerHTML = PLAY_SVG;
      playHint.textContent = 'Click to listen live';
      if (webrtcHandle) { webrtcHandle.close(); webrtcHandle = null; }
      if (remoteAudio) { remoteAudio.pause(); remoteAudio.srcObject = null; }
    }
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      isMuted = !isMuted;
      if (gainNode) gainNode.gain.value = isMuted ? 0 : currentVolume;
      if (remoteAudio) remoteAudio.volume = isMuted ? 0 : currentVolume;
      volumeIcon.innerHTML = isMuted ? VOL_MUTED_SVG : VOL_HIGH_SVG;
    });
  }
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      currentVolume = parseFloat(volumeSlider.value);
      if (!isMuted && gainNode) gainNode.gain.value = currentVolume;
      if (remoteAudio && !isMuted) remoteAudio.volume = currentVolume;
    });
  }

  fetchSessionDetails();
  connectWebSocket();
})();
