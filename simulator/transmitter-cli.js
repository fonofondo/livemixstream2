const http = require('http');
const WebSocket = require('ws');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

async function runCliTransmitter() {
  console.log(`[CLI Transmitter] Creating session at ${SERVER_URL}/api/session...`);
  
  const postData = JSON.stringify({
    title: 'CLI Automated Test Stream',
    quality: 'High',
    sampleRate: 48000,
    channels: 2
  });

  const req = http.request(`${SERVER_URL}/api/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const result = JSON.parse(data);
      if (!result.success) {
        console.error('Failed to create session:', result);
        process.exit(1);
      }

      console.log(`\n====================================================`);
      console.log(` [SESSION CREATED SUCCESSFULLY]`);
      console.log(` Session ID: ${result.sessionId}`);
      console.log(` Listener URL: ${result.listenerUrl}`);
      console.log(`====================================================\n`);

      startStreaming(result.wsUrl, result.config.sampleRate);
    });
  });

  req.on('error', (e) => {
    console.error(`Connection error: ${e.message}`);
    process.exit(1);
  });

  req.write(postData);
  req.end();
}

function startStreaming(wsUrl, sampleRate) {
  console.log(`Connecting WebSocket transmitter to ${wsUrl}...`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`Connected! Generating 440Hz stereo PCM audio stream...\nPress Ctrl+C to stop.`);

    let phase = 0;
    const bufferSize = 1024; // 1024 frames = ~21.3ms at 48kHz
    const channels = 2;
    let packets = 0;
    let totalBytes = 0;

    const streamInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(streamInterval);
        return;
      }

      const pcmData = new Float32Array(bufferSize * channels);
      for (let i = 0; i < bufferSize; i++) {
        phase++;
        const sampleL = Math.sin(2 * Math.PI * 440 * (phase / sampleRate)) * 0.4;
        const sampleR = Math.sin(2 * Math.PI * 880 * (phase / sampleRate)) * 0.3;
        pcmData[i * 2] = sampleL;
        pcmData[i * 2 + 1] = sampleR;
      }

      ws.send(Buffer.from(pcmData.buffer));
      packets++;
      totalBytes += pcmData.byteLength;

      if (packets % 100 === 0) {
        console.log(`[Stream Stats] Sent ${packets} audio packets (${(totalBytes / (1024 * 1024)).toFixed(2)} MB)`);
      }
    }, 20); // 20ms frame interval
  });

  ws.on('message', (msg) => {
    try {
      const payload = JSON.parse(msg.toString());
      if (payload.type === 'LISTENER_COUNT') {
        console.log(`>>> Listener update: ${payload.count} listener(s) connected (${payload.event})`);
      }
    } catch(e) {}
  });

  ws.on('close', () => console.log('Transmitter disconnected.'));
  ws.on('error', (err) => console.error('Transmitter error:', err.message));
}

runCliTransmitter();
