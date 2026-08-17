'use strict';

/**
 * mediasoup SFU wrapper.
 * - Plugin producers use PlainTransport (RTP/Opus over UDP)
 * - Browser listeners/admin use WebRtcTransport
 * Falls back to binary WebSocket fan-out if mediasoup is unavailable.
 */

let mediasoup = null;
try {
  mediasoup = require('mediasoup');
} catch (_) {
  console.warn('[SFU] mediasoup not installed — using WebSocket media fallback');
}

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    parameters: {
      minptime: 10,
      useinbandfec: 1
    }
  }
];

let worker = null;
let router = null;
let announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';
const rtcMinPort = Number(process.env.MEDIASOUP_MIN_PORT || 40000);
const rtcMaxPort = Number(process.env.MEDIASOUP_MAX_PORT || 40100);

async function init() {
  if (!mediasoup) return { ok: false, reason: 'mediasoup missing' };

  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort,
    rtcMaxPort
  });

  worker.on('died', () => {
    console.error('[SFU] mediasoup worker died');
    worker = null;
    router = null;
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log(`[SFU] mediasoup ready (UDP ${rtcMinPort}-${rtcMaxPort}, announce ${announcedIp})`);
  return { ok: true };
}

function isReady() {
  return !!(router && worker);
}

function getRtpCapabilities() {
  return router ? router.rtpCapabilities : null;
}

async function createPlainProducer(session) {
  if (!router) throw new Error('SFU not ready');

  const transport = await router.createPlainTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    rtcpMux: true,
    comedia: true
  });

  const ssrc = 0x12345678;
  const payloadType = 111;

  const producer = await transport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [
        {
          mimeType: 'audio/opus',
          clockRate: 48000,
          payloadType,
          channels: 2,
          parameters: { minptime: 10, useinbandfec: 1 }
        }
      ],
      encodings: [{ ssrc }]
    }
  });

  session.plainTransport = transport;
  session.producer = producer;
  session.mediaMode = 'plain';

  const tuple = transport.tuple;
  return {
    ip: tuple.localIp === '0.0.0.0' ? announcedIp : tuple.localIp,
    port: tuple.localPort,
    ssrc,
    payloadType,
    rtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined
  };
}

async function createWebRtcTransport() {
  if (!router) throw new Error('SFU not ready');

  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 600000
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  };
}

async function connectWebRtcTransport(transport, dtlsParameters) {
  await transport.connect({ dtlsParameters });
}

async function consume(session, transport, rtpCapabilities) {
  if (!session.producer) throw new Error('No producer for session');
  if (!router.canConsume({ producerId: session.producer.id, rtpCapabilities })) {
    throw new Error('Cannot consume');
  }

  const consumer = await transport.consume({
    producerId: session.producer.id,
    rtpCapabilities,
    paused: false
  });

  return {
    consumer,
    params: {
      id: consumer.id,
      producerId: session.producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    }
  };
}

async function closeSessionMedia(session) {
  try { if (session.producer) await session.producer.close(); } catch (_) {}
  try { if (session.plainTransport) await session.plainTransport.close(); } catch (_) {}
  session.producer = null;
  session.plainTransport = null;
  session.mediaMode = null;
}

module.exports = {
  init,
  isReady,
  getRtpCapabilities,
  createPlainProducer,
  createWebRtcTransport,
  connectWebRtcTransport,
  consume,
  closeSessionMedia,
  announcedIp,
  rtcMinPort,
  rtcMaxPort
};
