'use strict';

class EventHub {
  constructor() {
    this.clients = new Set();
  }

  add(ws, meta) {
    ws.asaphix = meta;
    this.clients.add(ws);
  }

  remove(ws) {
    this.clients.delete(ws);
  }

  emit(orgId, payload) {
    const msg = JSON.stringify({
      schemaVersion: 1,
      eventId: payload.eventId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      serverTimestamp: Date.now(),
      organizationId: orgId,
      ...payload
    });
    for (const ws of this.clients) {
      if (!ws.asaphix || ws.asaphix.orgId !== orgId) continue;
      if (ws.readyState !== 1) continue;
      try { ws.send(msg); } catch (_) {}
    }
  }
}

module.exports = { EventHub };
