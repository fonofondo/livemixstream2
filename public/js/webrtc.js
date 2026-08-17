'use strict';

/**
 * Shared WebRTC listener helpers for mediasoup SFU.
 * Falls back to binary WebSocket PCM/Opus when SFU is unavailable.
 */
(function (global) {
  async function startWebRtcPlayback(ws, audioEl) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      remoteStream.addTrack(ev.track);
      if (audioEl) {
        audioEl.srcObject = remoteStream;
        audioEl.play().catch(() => {});
      }
    };

    // Lightweight mediasoup-client-less flow using server-provided params
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebRTC timeout')), 15000);

      async function onMessage(event) {
        if (typeof event.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }

        try {
          if (msg.type === 'WEBRTC_CAPABILITIES') {
            ws.send(JSON.stringify({ type: 'WEBRTC_CREATE_TRANSPORT' }));
          } else if (msg.type === 'WEBRTC_TRANSPORT') {
            const params = msg.params;
            // Use RTCPeerConnection with mediasoup ICE/DTLS via manual SDP is complex.
            // Prefer mediasoup-client when available.
            if (global.mediasoupClient) {
              clearTimeout(timeout);
              ws.removeEventListener('message', onMessage);
              const device = new global.mediasoupClient.Device();
              await device.load({ routerRtpCapabilities: await fetchCapabilities() });
              const sendTransport = null;
              const recvTransport = device.createRecvTransport(params);
              recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                ws.send(JSON.stringify({ type: 'WEBRTC_CONNECT_TRANSPORT', dtlsParameters }));
                const onConnected = (ev2) => {
                  if (typeof ev2.data !== 'string') return;
                  try {
                    const m = JSON.parse(ev2.data);
                    if (m.type === 'WEBRTC_CONNECTED') {
                      ws.removeEventListener('message', onConnected);
                      callback();
                    }
                  } catch (_) {}
                };
                ws.addEventListener('message', onConnected);
              });
              ws.send(JSON.stringify({
                type: 'WEBRTC_CONSUME',
                rtpCapabilities: device.rtpCapabilities
              }));
              const onConsumer = async (ev2) => {
                if (typeof ev2.data !== 'string') return;
                try {
                  const m = JSON.parse(ev2.data);
                  if (m.type === 'WEBRTC_CONSUMER') {
                    ws.removeEventListener('message', onConsumer);
                    const consumer = await recvTransport.consume(m.params);
                    remoteStream.addTrack(consumer.track);
                    if (audioEl) {
                      audioEl.srcObject = remoteStream;
                      await audioEl.play().catch(() => {});
                    }
                    resolve({ mode: 'webrtc', stream: remoteStream, close: () => {
                      try { consumer.close(); } catch (_) {}
                      try { recvTransport.close(); } catch (_) {}
                      try { pc.close(); } catch (_) {}
                    }});
                  }
                } catch (err) { reject(err); }
              };
              ws.addEventListener('message', onConsumer);
            } else {
              // Without mediasoup-client, signal that caller should use WS fallback
              clearTimeout(timeout);
              ws.removeEventListener('message', onMessage);
              reject(new Error('mediasoup-client not loaded'));
            }
          } else if (msg.type === 'ERROR') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMessage);
            reject(new Error(msg.error || 'WebRTC error'));
          }
        } catch (err) {
          clearTimeout(timeout);
          ws.removeEventListener('message', onMessage);
          reject(err);
        }
      }

      async function fetchCapabilities() {
        const res = await fetch('/api/webrtc/capabilities');
        const data = await res.json();
        return data.rtpCapabilities;
      }

      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ type: 'WEBRTC_GET_CAPABILITIES' }));
    });
  }

  global.LiveMixWebRtc = { startWebRtcPlayback };
})(window);
