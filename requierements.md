# LiveMixStream

## Detailed Requirements Specification

**Document version:** 1.0
**Date:** August 2026
**Project type:** Cross-platform real-time audio streaming system
**Primary platforms:** Windows, macOS, Linux
**Primary plugin formats:** VST3, Audio Unit (macOS)
**Client playback:** Web browser

---

# 1. Product Overview

LiveMixStream is a real-time, high-quality audio streaming system designed to allow an audio engineer, musician, producer, or broadcaster to transmit audio directly from a Digital Audio Workstation (DAW) to one or more remote listeners.

The transmitter will use a native audio plugin inserted into a DAW. The plugin captures the DAW's audio output, establishes a streaming session, and transmits the audio to the LiveMixStream backend.

Listeners will receive the stream through a standard web browser without installing a DAW plugin.

The initial product should prioritize:

* Very high audio quality
* Low and predictable latency
* Simple session creation
* Simple listener access through a URL
* Cross-platform DAW support
* Minimal installation friction
* Low infrastructure cost
* Ability to scale from a small private service to many simultaneous sessions and listeners

---

# 2. Product Concept

The fundamental workflow is:

```text
                 TRANSMITTER

          Windows / macOS / Linux
                    │
                    ▼
             ┌─────────────┐
             │    DAW      │
             │ Reaper etc. │
             └──────┬──────┘
                    │
                    ▼
          ┌───────────────────┐
          │ LiveMixStream     │
          │ Plugin             │
          │ VST3 / AU         │
          └─────────┬─────────┘
                    │
                    │ Internet
                    ▼
          ┌───────────────────┐
          │ LiveMixStream     │
          │ Backend / SFU      │
          └─────────┬─────────┘
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       Browser   Browser   Browser
       Listener  Listener  Listener
```

The transmitter creates a session and receives a unique URL.

Example:

```text
https://livemixstream.com/s/7F3K9P
```

The transmitter sends that URL to the listeners.

A listener opens the URL and immediately receives the audio.

---

# 3. Goals

## 3.1 Primary goals

LiveMixStream shall:

1. Capture audio directly from a DAW plugin.
2. Stream audio over the Internet in real time.
3. Support multiple simultaneous listeners.
4. Provide browser-based playback.
5. Support Windows, macOS, and Linux.
6. Support VST3.
7. Support Audio Unit on macOS.
8. Provide sufficiently low latency for remote mixing, production, teaching, rehearsals, and review.
9. Preserve professional audio quality.
10. Require no plugin installation for listeners.
11. Allow a transmitter to create a session with minimal configuration.
12. Operate using relatively inexpensive cloud infrastructure.
13. Allow future scaling without redesigning the fundamental architecture.

---

# 4. Non-Goals for Version 1

The following are explicitly outside the initial scope:

* Full DAW functionality
* Remote control of the transmitter DAW
* Remote mixing
* Remote recording
* Two-way audio
* Voice chat
* Video
* Screen sharing
* Automatic mastering
* AI processing
* Built-in effects
* Multitrack remote mixing
* Mobile native applications
* Audio editing
* Cloud storage of recordings

These may be considered for later versions.

---

# 5. Target Users

## 5.1 Audio professionals

Examples:

* Mixing engineers
* Recording engineers
* Producers
* Mastering engineers
* Sound designers

Typical use:

> "Listen to the mix I'm currently working on."

---

## 5.2 Musicians

Examples:

* Bands
* Orchestras
* Remote collaborators
* Music teachers

Typical use:

> "Listen to the live rehearsal/mix remotely."

---

## 5.3 Clients

Clients should not need to understand audio software.

Their workflow should be:

```text
Receive link
    ↓
Open link
    ↓
Press Play
    ↓
Listen
```

---

# 6. Functional Requirements

## 6.1 Plugin

### FR-001 — Plugin formats

The transmitter application shall initially provide:

* VST3 for Windows
* VST3 for macOS
* VST3 for Linux
* Audio Unit for macOS

The plugin shall share the same core implementation across platforms.

---

### FR-002 — Cross-platform codebase

The system shall use a shared source codebase for the majority of plugin functionality.

Platform-specific code shall be isolated behind abstraction layers.

Target architecture:

```text
LiveMixStream Core
       │
       ├── Audio Engine
       ├── Network Engine
       ├── Session Manager
       ├── Authentication
       └── UI
              │
              ├── Windows VST3
              ├── macOS VST3
              ├── macOS AU
              └── Linux VST3
```

---

### FR-003 — DAW audio capture

The plugin shall receive audio from the DAW at the plugin's insertion point.

It shall support at minimum:

* Mono
* Stereo

The architecture should not prevent future multichannel support.

---

### FR-004 — Sample rates

The plugin shall support common DAW sample rates, initially:

* 44.1 kHz
* 48 kHz
* 88.2 kHz
* 96 kHz

The architecture should permit future support for higher rates.

---

### FR-005 — Bit depth

The plugin shall internally process audio using floating-point samples.

The plugin should support the DAW's native floating-point audio representation without unnecessary conversion.

---

### FR-006 — Plugin bypass

The plugin shall provide a standard bypass mechanism.

Bypassing the plugin shall stop or suspend network transmission according to the selected behavior.

---

# 7. Session Management

## FR-010 — Create session

The transmitter shall be able to create a new streaming session.

The session shall receive a unique identifier.

Example:

```text
Session ID:
7F3K9P
```

---

## FR-011 — Session URL

The system shall generate a listener URL.

Example:

```text
https://livemixstream.com/s/7F3K9P
```

The plugin shall provide a convenient mechanism for copying the URL.

---

## FR-012 — Session state

The system shall track at minimum:

* Created
* Connecting
* Live
* Paused
* Disconnected
* Expired

---

## FR-013 — Session expiration

Inactive sessions should automatically expire.

The initial default should be configurable by the backend.

Example:

```text
No transmitter connection for 30 minutes
        ↓
Session expires
```

---

## FR-014 — Session privacy

Sessions shall be private by default.

A listener possessing the session URL may access the stream.

Future versions may support:

* Password protection
* Authentication
* Invitations
* Expiring links
* Per-listener permissions

---

# 8. Audio Transport

## FR-020 — Real-time transport

The system shall use a real-time transport suitable for interactive audio.

The preferred initial technology is WebRTC.

The architecture should allow alternative transports to be added later.

---

## FR-021 — Low latency

The system shall target:

**Preferred:** <300 ms end-to-end

**Acceptable:** <500 ms

The system shall expose enough telemetry to determine actual latency.

---

## FR-022 — Jitter handling

The receiver shall compensate for network jitter using an adaptive jitter buffer.

The system shall prioritize continuous playback over absolute minimum latency.

---

## FR-023 — Packet loss

The transport shall tolerate reasonable Internet packet loss.

Short network disturbances should not cause permanent session failure.

---

## FR-024 — Network adaptation

The system should adapt transmission characteristics to network conditions.

Possible adaptations include:

* Bitrate
* Packet size
* Buffer size
* Codec parameters

Audio quality should degrade gracefully rather than abruptly disconnecting.

---

# 9. Audio Quality

## FR-030 — High-quality mode

The system shall provide a high-quality streaming mode intended for professional audio monitoring.

The initial target should be approximately:

```text
48 kHz
Stereo
High-quality codec
Low compression
```

---

## FR-031 — Efficient mode

The system should provide an Internet-efficient mode for users with limited bandwidth.

Example:

```text
Low bandwidth
Medium quality
High quality
```

---

## FR-032 — Lossless mode

The architecture should permit a future PCM/lossless mode.

This should not be required for the MVP because uncompressed professional audio can consume significant bandwidth.

---

# 10. Browser Listener

## FR-040 — Browser compatibility

The listener application shall operate in modern:

* Chrome
* Edge
* Firefox
* Safari

The initial target should prioritize Chromium-based browsers and Safari on macOS/iOS.

---

## FR-041 — No installation

Listeners shall not be required to install software.

---

## FR-042 — Session page

The listener page shall display:

```text
LiveMixStream

Session:
My Mix

        ▶

      Volume
───────────────

48 kHz · Stereo
```

---

## FR-043 — Playback controls

The listener shall have:

* Play/pause
* Volume
* Mute
* Connection status

---

## FR-044 — Browser audio permission

The system shall handle browser autoplay restrictions gracefully.

If automatic playback is blocked, the user shall be presented with an obvious Play button.

---

# 11. Listener Experience

The listener should not need technical knowledge.

The desired workflow is:

```text
Click link
   ↓
Page loads
   ↓
"PLAY" button
   ↓
Audio starts
```

No configuration should normally be necessary.

---

# 12. Backend

## FR-050 — Session server

The backend shall maintain session information.

At minimum:

```text
session_id
transmitter_id
created_at
status
configuration
listener_count
```

---

## FR-051 — Signaling

The backend shall provide signaling required to establish WebRTC connections.

---

## FR-052 — Media routing

The architecture shall support routing one transmitter stream to multiple listeners.

The preferred architecture is an SFU or equivalent media relay.

```text
                Transmitter
                     │
                     ▼
                  SFU
              ┌──────┼──────┐
              ▼      ▼      ▼
             L1     L2     L3
```

The server should not unnecessarily decode and re-encode audio for each listener.

---

## FR-053 — Single encoding

The transmitter should encode the stream once whenever practical.

The server should distribute the resulting media stream rather than independently transcoding it for every listener.

---

# 13. Infrastructure

## FR-060 — Initial deployment

The MVP shall be deployable on a single inexpensive VPS.

Potential providers include:

* InterServer
* Google Cloud
* Hetzner
* Other VPS providers

The application shall not initially require Kubernetes or a multi-server cluster.

---

## FR-061 — Server requirements

The MVP server should require approximately:

* 1–2 CPU cores
* 2–4 GB RAM
* SSD storage
* Public IPv4/IPv6
* UDP support
* HTTPS
* Sufficient outbound bandwidth

---

## FR-062 — Bandwidth monitoring

The system shall monitor:

* Total outbound traffic
* Traffic per session
* Traffic per listener
* Current listener count

Bandwidth usage shall be visible to administrators.

---

## FR-063 — Horizontal scalability

The backend architecture shall allow future deployment of multiple media servers.

Future architecture:

```text
                    API
                     │
              ┌──────┴──────┐
              │ Load Balancer│
              └──────┬──────┘
                     │
           ┌─────────┼─────────┐
           ▼         ▼         ▼
         SFU 1     SFU 2     SFU 3
```

---

# 14. Authentication

## FR-070 — Transmitter authentication

The plugin shall authenticate with the LiveMixStream backend.

Authentication may initially use:

* API key
* Device token
* User token

---

## FR-071 — Listener authentication

The MVP shall support anonymous listener access using a session-specific URL.

---

## FR-072 — Token security

Session URLs/tokens shall contain sufficient entropy to prevent practical guessing.

Session identifiers should not be sequential.

---

# 15. Security

## FR-080 — Encryption

All signaling traffic shall use HTTPS/TLS.

Audio transport shall use WebRTC's encrypted media transport.

---

## FR-081 — Session isolation

A listener connected to session A shall never receive audio from session B.

---

## FR-082 — Authentication isolation

Transmitter credentials shall never be exposed to listeners.

---

## FR-083 — Abuse prevention

The backend should include basic protection against:

* Session flooding
* Connection flooding
* Excessive listener creation
* Brute-force session ID discovery
* Unauthorized API requests

---

# 16. Plugin User Interface

The MVP plugin UI should be intentionally simple.

Example:

```text
┌──────────────────────────────────┐
│        LiveMixStream              │
│                                  │
│  Status: ● LIVE                  │
│                                  │
│  Session                         │
│  ┌────────────────────────────┐  │
│  │ My Mixing Session           │  │
│  └────────────────────────────┘  │
│                                  │
│  [ CREATE SESSION ]              │
│                                  │
│  Listener URL                    │
│  ┌────────────────────────────┐  │
│  │ livemixstream.com/s/7F3K9P │  │
│  └────────────────────────────┘  │
│                                  │
│  [ COPY LINK ]                   │
│                                  │
│  Quality: [ High ▼ ]             │
│                                  │
│  Listeners: 3                    │
│  Latency: 180 ms                 │
│  Bitrate: 256 kbps              │
│                                  │
│  [ STOP STREAM ]                 │
└──────────────────────────────────┘
```

---

# 17. Diagnostics

The plugin should expose:

* Connection state
* Round-trip latency
* Estimated network latency
* Bitrate
* Packet loss
* Jitter
* Listener count
* Server connection

Example:

```text
● LIVE

Latency       184 ms
Bitrate       256 kbps
Packet loss   0.2%
Listeners     4
Server        Miami
```

---

# 18. Logging

The plugin shall maintain useful diagnostic logs.

Logs should include:

* Session creation
* Connection attempts
* Connection failures
* Network errors
* Session termination
* Codec initialization
* Server responses

Logs shall not contain sensitive credentials.

---

# 19. Crash Handling

The plugin shall avoid destabilizing the host DAW.

Network failures must never cause the audio thread to block indefinitely.

This is a critical requirement.

The real-time audio thread shall not perform blocking operations such as:

* Network I/O
* DNS resolution
* File I/O
* Memory allocation where avoidable
* Database operations

The architecture should use:

```text
DAW audio thread
       │
       ▼
Lock-free audio buffer
       │
       ▼
Network thread
       │
       ▼
Encoder
       │
       ▼
WebRTC
```

---

# 20. Audio Thread Requirements

The plugin's audio processing path shall be real-time safe.

The audio callback should:

1. Receive DAW samples.
2. Copy/write them into a lock-free or real-time-safe buffer.
3. Return immediately.

A separate worker/network pipeline shall handle:

* Encoding
* Packetization
* Network transmission
* Session management

---

# 21. Platform Requirements

## Windows

Support:

* Windows 10+
* Windows 11+
* VST3
* x64 initially

Future:

* ARM64

---

## macOS

Support:

* Current supported macOS versions
* Apple Silicon
* Intel where practical

Formats:

* VST3
* AU

The release process shall support:

* Code signing
* Developer ID
* Apple notarization

---

## Linux

Initial target:

* Ubuntu-based distributions
* x86-64
* VST3

The architecture should avoid unnecessary dependencies on a specific desktop environment.

---

# 22. Build System

The project shall use a reproducible cross-platform build system.

Preferred structure:

```text
LiveMixStream/
│
├── Source/
│   ├── Audio/
│   ├── Network/
│   ├── Session/
│   ├── Authentication/
│   ├── UI/
│   └── Plugin/
│
├── Tests/
│
├── Resources/
│
├── CMakeLists.txt
│
└── CI/
```

The project should use CMake and a cross-platform C++ framework such as JUCE.

---

# 23. CI/CD

Automated builds should eventually produce:

```text
Windows
    LiveMixStream.vst3

macOS
    LiveMixStream.vst3
    LiveMixStream.component

Linux
    LiveMixStream.vst3
```

CI should perform:

1. Compilation
2. Unit tests
3. Plugin validation
4. Packaging
5. Signing
6. Notarization on macOS
7. Release artifact generation

---

# 24. Installation

## Windows

Provide an installer or package that places the VST3 in the standard location.

---

## macOS

Provide a `.pkg` or `.dmg`.

The release shall be signed and notarized for production distribution.

---

## Linux

Initially provide:

* `.zip`
* `.tar.gz`

Installation may be manual.

A package manager can be added later.

---

# 25. Web Application

The web application shall have at least two conceptual areas.

### Public listener

```text
/s/{session}
```

### Backend/API

```text
/api/session
/api/auth
/api/signaling
```

The web frontend should be lightweight and optimized for immediate playback.

---

# 26. Administration

An administrator interface should eventually provide:

* Active sessions
* Active listeners
* Bandwidth usage
* Server status
* User accounts
* Session history
* Errors
* Abuse controls

The MVP may omit a graphical administration interface and rely on server monitoring.

---

# 27. Observability

The backend shall expose metrics for:

* Active sessions
* Active listeners
* Bandwidth
* CPU usage
* RAM usage
* Network usage
* WebRTC connection failures
* Packet loss
* Session duration

---

# 28. Reliability Requirements

## Target availability

MVP target:

**99%**

Production target:

**99.9%**

The plugin shall recover gracefully from temporary network interruptions.

---

# 29. Recovery

If the network connection is lost:

```text
CONNECTED
    ↓
CONNECTION LOST
    ↓
RECONNECTING
    ↓
CONNECTED
```

The plugin should automatically attempt reconnection.

The listener should similarly attempt to reconnect without requiring a page reload.

---

# 30. Performance Requirements

The MVP should support at minimum:

### One transmitter

* 1 active audio stream
* 25 simultaneous listeners

without requiring more than one server.

The architecture should be designed so that the same implementation can eventually support hundreds or thousands of listeners by adding media servers.

---

# 31. Bandwidth Model

The system should use a simple bandwidth model.

For example:

```text
256 kbps stream
       │
       ▼
       SFU
   ┌───┼────┐
   ▼   ▼    ▼
  L1  L2    L3
```

For N listeners:

```text
Outbound ≈ bitrate × N
```

plus protocol overhead.

This makes bandwidth the primary scaling cost rather than CPU.

---

# 32. Cost Objective

The MVP should prioritize inexpensive infrastructure.

The initial goal is to operate a small deployment on a low-cost VPS.

A single server should be sufficient for early development and beta testing.

The architecture must not assume expensive managed cloud services.

---

# 33. Future Features

The architecture should leave room for:

### Higher channel counts

```text
Stereo
   ↓
5.1
   ↓
7.1
   ↓
Multichannel
```

### Lossless streaming

### 96/192 kHz

### Multiple simultaneous streams

### Password-protected sessions

### User accounts

### Session recording

### Audio comments

### Timestamped client feedback

### Client approval workflow

### Stream history

### Mobile listener application

### Native desktop listener

### Remote talkback

### Two-way audio

### Video

### Screen sharing

---

# 34. Possible Future Architecture

```text
                    ┌─────────────────┐
                    │   LiveMixStream │
                    │      API        │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Session Manager  │
                    └────────┬────────┘
                             │
                 ┌───────────▼───────────┐
                 │      SFU Cluster      │
                 │                       │
                 │  SFU 1   SFU 2  SFU 3 │
                 └────┬──────┬──────┬────┘
                      │      │      │
                    ┌─┘      │      └─┐
                    ▼        ▼        ▼
                 Browser  Browser  Browser
```

---

# 35. MVP Definition

The first usable version of LiveMixStream shall contain only:

### Transmitter

* VST3
* AU on macOS
* Stereo audio
* 44.1/48/96 kHz
* Session creation
* Session URL
* Start/stop streaming
* Connection status
* Listener count
* Basic bitrate/latency information

### Backend

* Session creation
* Authentication
* WebRTC signaling
* Media relay/SFU
* Listener management
* Basic logging

### Browser

* Session URL
* Play/pause
* Volume
* Connection status
* Stereo playback

### Deployment

* One VPS
* HTTPS
* Automated deployment
* Basic monitoring

---

# 36. MVP Success Criteria

The MVP will be considered successful if:

1. A user can install the plugin.
2. The plugin loads successfully in Reaper.
3. The plugin loads successfully in Studio One.
4. The plugin loads successfully in Logic on macOS through AU.
5. The user can create a session.
6. The system generates a shareable URL.
7. Another person can open that URL in a browser.
8. The listener can hear the DAW audio.
9. Audio remains synchronized and continuous.
10. Typical latency is below approximately 500 ms.
11. Multiple listeners can hear the same stream simultaneously.
12. Temporary network failures do not crash the DAW.
13. The entire system can operate on a single inexpensive VPS.

---

# 37. Recommended Technical Direction

For the initial implementation, the recommended stack is:

```text
PLUGIN
C++ + JUCE
    │
    ├── VST3
    └── AU
          │
          ▼
   LiveMixStream Core
          │
          ▼
      WebRTC Client
          │
          ▼
SERVER
Linux VPS
    │
    ├── Signaling
    ├── Session API
    └── WebRTC SFU
          │
          ▼
BROWSER
HTML / CSS / JavaScript
    │
    ▼
WebRTC
    │
    ▼
Web Audio API
```

### Suggested initial components

**Plugin**

* C++
* JUCE
* CMake
* VST3
* AU
* WebRTC-compatible transport

**Backend**

* Linux
* C++/Go/Rust/Node.js depending on implementation choice
* WebRTC SFU
* REST/WebSocket signaling

**Frontend**

* TypeScript
* HTML/CSS
* WebRTC
* Web Audio API

**Infrastructure**

* Single VPS initially
* Nginx/Caddy
* HTTPS
* Docker optional
* PostgreSQL/SQLite only if persistent user/session data becomes necessary

---

# 38. Critical Architectural Principle

The most important architectural rule is:

> **Never allow Internet/network activity to block the DAW's real-time audio thread.**

The system should behave like this:

```text
                 REAL-TIME SIDE

DAW
 │
 ▼
Plugin audio callback
 │
 ▼
Lock-free buffer
 │
 └─────────────────────────────┐
                               │
                         ASYNCHRONOUS
                              SIDE
                               │
                               ▼
                         Audio encoder
                               │
                               ▼
                            WebRTC
                               │
                               ▼
                           Internet
```

This separation is fundamental to making LiveMixStream reliable inside professional DAWs.

---

# 39. Product Philosophy

LiveMixStream should follow a simple principle:

**The transmitter should feel like a normal DAW plugin; the listener should feel like opening a normal web link.**

The technical complexity should remain invisible to both users.

The ideal experience is:

```text
ENGINEER

Insert LiveMixStream
        ↓
Create Session
        ↓
Copy Link
        ↓
Send Link


CLIENT

Click Link
        ↓
Press Play
        ↓
Listen
```

Everything between those two experiences should be handled by LiveMixStream.
