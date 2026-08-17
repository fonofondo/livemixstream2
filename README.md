# LiveMixStream

Cross-platform real-time audio streaming and browser-controlled track hierarchy from DAW to web.

## Components

1. **JUCE plugin** (VST3 / AU / Standalone) — Track Control (default) + Streaming mode
2. **Node server** — hierarchy, sessions, admin, mediasoup SFU (WebRTC) with WebSocket fallback
3. **Web apps** — listener `/s/:id`, hierarchy `/hierarchy`, admin `/admin`, transmitter test bench

Canonical HTTP/WSS port: **3001**.

## Quick start

### 1. Install and configure

```bash
npm install
cp .env.example .env   # optional — edit values as needed
```

Node does **not** load `.env` automatically. Export variables before starting the server:

```bash
set -a && source .env && set +a
npm start
```

Or set only what you need:

```bash
export PORT=3001
export LIVEMIXSTREAM_SERVER_URL=http://localhost:3001
npm start
```

### 2. Start the server

```bash
npm start
# or with auto-reload during development:
npm run dev
```

### 3. Load the plugin in your DAW

Build the plugin (see [Plugin build](#plugin-build) below), then reload the VST/AU in your DAW.

To point the plugin at a non-default server on **first open**, set the env var **before launching the DAW**:

```bash
export LIVEMIXSTREAM_SERVER_URL=http://localhost:3001
# then start your DAW from the same shell
```

After the first use, the URL is also saved to `~/.config/livemixstream/server.url` and in the DAW project state.

### URLs

- Listener (after creating a session): `http://localhost:3001/s/<SESSION>`
- Hierarchy: `http://localhost:3001/hierarchy`
- Admin: `http://localhost:3001/admin` (default password `admin`)
- Transmitter bench: `http://localhost:3001/transmitter.html`
- Metrics: `http://localhost:3001/api/metrics`

### Tests

```bash
npm test
npm run test:simulator
```

## Environment variables

See [`.env.example`](.env.example) for a full template.

| Variable | Used by | Default | Purpose |
|----------|---------|---------|---------|
| `PORT` | Server | `3001` | HTTP / WebSocket listen port |
| `LMS_ADMIN_PASSWORD` | Server | `admin` | Admin UI login password |
| `LMS_PLUGIN_TOKEN` | Server | *(empty)* | Optional plugin auth token |
| `LIVEMIXSTREAM_SERVER_URL` | Plugin | `http://localhost:3001` | Default server URL on first open |
| `MEDIASOUP_ANNOUNCED_IP` | Server (WebRTC) | `127.0.0.1` | Public IP for ICE/RTP (set in production) |
| `MEDIASOUP_MIN_PORT` | Server (WebRTC) | `40000` | Start of UDP port range for mediasoup |
| `MEDIASOUP_MAX_PORT` | Server (WebRTC) | `40100` | End of UDP port range for mediasoup |
| `SERVER_URL` | Simulator CLI | `http://localhost:3001` | Target server for `npm run test:simulator` |

**Plugin URL priority:** saved DAW state → `~/.config/livemixstream/server.url` → `LIVEMIXSTREAM_SERVER_URL` → hardcoded default.

## Plugin build

```bash
sudo apt-get install -y libopus-dev libcurl4-openssl-dev   # Linux
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release
```

Default server URL in the plugin: `http://localhost:3001`  
Override with `LIVEMIXSTREAM_SERVER_URL` (before launching the DAW), or edit the URL in Master mode (saved to `~/.config/livemixstream/server.url`).

## Modes

| Mode | Track Control | Streaming |
|------|---------------|-----------|
| Track Control (default) | yes | no |
| Streaming | yes (automatic) | yes |

Mode, track name, group, and instance ID persist with the DAW project.

## Deployment

Copy and edit env vars for production, then start with Docker:

```bash
cp .env.example .env
# edit MEDIASOUP_ANNOUNCED_IP to your public IP
set -a && source .env && set +a
docker compose up -d
```

Or export directly:

```bash
export MEDIASOUP_ANNOUNCED_IP=YOUR.PUBLIC.IP
docker compose up -d
```

Caddy terminates HTTPS/WSS to `localhost:3001`. RTP uses UDP `40000-40100` on the host (not through Caddy).

## Architecture notes

- DAW audio thread: hierarchy gain ramp + lock-free queue write only
- Async thread: Opus encode + RTP to mediasoup PlainTransport (or WS binary fallback)
- Browsers: mediasoup-client WebRTC consume when SFU is ready
- Hierarchy: server-authoritative lead / duck / fade; plugins hold gain on disconnect

## License

MIT
