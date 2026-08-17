# LiveMixStream

## Complete Requirements Specification

**Document version:** 3.2
**Date:** August 2026
**Project:** LiveMixStream
**Primary purpose:** Real-time audio streaming and browser-controlled track hierarchy
**Target platforms:** Windows, macOS, Linux
**Primary plugin format:** VST3
**Additional macOS format:** Audio Unit (AU)

---

# 1. Product Overview

LiveMixStream is a cross-platform real-time audio system consisting of:

1. **LiveMixStream Plugin** — a single VST3/AU plugin installed in the DAW.
2. **LiveMixStream Server** — backend infrastructure providing signaling, WebRTC media distribution, session management, hierarchy management, authentication, monitoring, and administration.
3. **LiveMixStream Web** — browser interfaces for listeners, hierarchy control, and administrators.

The LiveMixStream Plugin has two principal capabilities:

* **Track Control Mode** — participates in AudioHierarchy and controls the gain of the DAW track on which the plugin is inserted.
* **Streaming Mode** — captures DAW audio and streams it through the LiveMixStream Server using WebRTC.

The plugin shall support either capability, and the architecture shall support both capabilities being active simultaneously.

**Track Control Mode is the default mode for a new plugin instance.**

The selected operating mode shall be **persistent per plugin instance** and shall be remembered when the DAW project is saved/reloaded or the DAW is restarted.

There shall be **no "Both" option in the mode selector**.

When the user selects **Streaming Mode**, Track Control functionality remains active automatically. Therefore:

| Mode              | Track Control | Streaming |
| ----------------- | ------------: | --------: |
| **Track Control** |             ✓ |         — |
| **Streaming**     |             ✓ |         ✓ |

The user does **not** need to insert a second LiveMixStream instance or enable a separate "Both" or "also stream" option.

---

# 2. Product Terminology

## 2.1 LiveMixStream Plugin

The single native plugin distributed to users.

Formats:

* VST3
* AU on macOS

It contains all audio, networking, hierarchy, streaming, authentication, and UI functionality required by the product.

There shall not be separate "master plugin" and "track control plugin" products.

---

## 2.2 Track Control Mode

The default operating mode for a new plugin instance.

The plugin:

* Registers its instance with the server.
* Assigns a unique instance ID.
* Has a human-readable track name.
* Belongs to a hierarchy group.
* Receives hierarchy commands.
* Applies gain changes to its own audio.
* Does not require streaming to be active.

---

## 2.3 Streaming Mode

Optional capability.

When **Streaming Mode** is selected, the plugin:

* Creates or joins a streaming session.
* Captures audio.
* Encodes it.
* Establishes a WebRTC connection.
* Sends the stream to the LiveMixStream Server.
* **Continues to participate in AudioHierarchy and Track Control simultaneously.**

From the user's perspective, **Streaming Mode is therefore "Streaming + Track Control"**. There is no separate "Both" mode and no need to insert a second LiveMixStream instance.

---

## 2.4 Simultaneous Track Control and Streaming

The underlying plugin architecture shall support Track Control and Streaming functionality operating simultaneously.

This is accomplished by selecting **Streaming Mode** on the same plugin instance. Track Control remains active automatically.

Conceptually:

```text
DAW
 │
 ▼
LiveMixStream Plugin
 │
 ├── Track Control
 │      └── hierarchy gain
 │
 └── Streaming
        └── WebRTC
```

---

## 2.5 LiveMixStream Server

A separate application running on a server/VPS.

It is responsible for:

* WebRTC signaling
* SFU/media distribution
* Streaming sessions
* Hierarchy groups
* Authentication
* Plugin registry
* Listener management
* Administration
* Monitoring
* Audit logging

The server does **not** run inside the DAW.

---

## 2.6 SFU

SFU means **Selective Forwarding Unit**.

The SFU receives one encoded stream from the LiveMixStream Plugin and forwards it to multiple listeners.

```text
LiveMixStream Plugin
        │
        │ one upload
        ▼
       SFU
    ┌───┼────┐
    ▼   ▼    ▼
   L1   L2   Admin
```

The plugin should not need to upload a separate copy for every listener.

---

# 3. Product Goals

LiveMixStream shall:

1. Provide professional-quality real-time audio streaming.
2. Provide low and predictable latency.
3. Allow browser-based listening.
4. Require no software installation for ordinary listeners.
5. Support multiple simultaneous listeners.
6. Support Windows, macOS, and Linux.
7. Provide VST3 support on all three platforms.
8. Provide AU support on macOS.
9. Use a single plugin product for all functionality.
10. Make Track Control the default plugin mode.
11. Allow multiple LiveMixStream instances within a DAW project.
12. Provide browser-controlled Lead Track Ducking.
13. Support multiple independent hierarchy groups.
14. Allow Track Control and Streaming to operate simultaneously.
15. Provide comprehensive administrator monitoring.
16. Allow administrators to listen to any active stream.
17. Allow administrators to manage streams and hierarchy groups.
18. Avoid dependency on proprietary DAW APIs for AudioHierarchy.
19. Operate initially on inexpensive VPS infrastructure.
20. Provide a path to horizontal scaling.

---

# 4. Non-Goals for Version 1

The initial system shall not attempt to provide:

* Arbitrary control of DAW tracks without LiveMixStream instances.
* Full DAW remote control.
* Remote editing of DAW projects.
* Remote recording.
* Video.
* Screen sharing.
* Two-way audio.
* Talkback.
* Remote effects processing.
* Automatic mastering.
* AI processing.
* Full multitrack remote mixing.
* Native mobile applications.
* Full cloud DAW/project storage.

---

# 5. High-Level Architecture

```text
                         LIVE MIX STREAM
                              SERVER
 ┌───────────────────────────────────────────────────────────────┐
 │                                                               │
 │ Authentication                                                │
 │ Session Manager                                               │
 │ WebSocket Signaling                                           │
 │ WebRTC / SFU                                                  │
 │ Hierarchy Manager                                             │
 │ Plugin Registry                                               │
 │ Admin API                                                     │
 │ Monitoring                                                    │
 │ Audit Logging                                                 │
 │                                                               │
 └───────────────┬───────────────────────┬───────────────────────┘
                 │                       │
                 │                       │
            DAW Connections        Browser Connections
                 │                       │
                 ▼                       ▼
        LiveMixStream Plugin      LiveMixStream Web
                 │                       │
        ┌────────┴────────┐       ┌──────┴─────────────┐
        │                 │       │                    │
 Track Control       Streaming   Listener        Admin / Control
     Mode                Mode
```

---

# 6. Plugin Architecture

There shall be **one plugin product**.

```text
LiveMixStream
      │
      ├── Audio Engine
      │
      ├── Track Control
      │
      ├── Streaming
      │
      ├── Network
      │
      ├── Authentication
      │
      ├── Session Management
      │
      └── User Interface
```

The same source code shall produce:

```text
Windows
└── LiveMixStream.vst3

macOS
├── LiveMixStream.vst3
└── LiveMixStream.component

Linux
└── LiveMixStream.vst3
```

---

# 7. Plugin Mode and Persistence

The plugin shall provide two operating modes:

```text
● Track Control
○ Streaming
```

There shall be **no "Both" mode option**.

## Default

A newly created plugin instance shall default to:

```text
Track Control
```

## Mode behavior

The two modes have the following behavior:

| Mode              | Track Control | Streaming |
| ----------------- | ------------: | --------: |
| **Track Control** |             ✓ |         — |
| **Streaming**     |             ✓ |         ✓ |

Thus, selecting **Streaming** automatically enables streaming **while retaining Track Control functionality**.

The user does **not** need to:

* Insert a second LiveMixStream instance.
* Enable a separate "Both" mode.
* Enable a separate "also stream" checkbox.

The same plugin instance performs both functions.

## Persistent selection

The selected mode shall be saved as part of the plugin instance's persistent state.

For example:

```text
Project saved
    ↓
LiveMixStream instance
    ↓
mode = Streaming
    ↓
DAW project reopened
    ↓
mode = Streaming
    ↓
Track Control + Streaming active
```

The same applies to Track Control mode.

The mode selection shall survive:

* DAW project save/reload
* DAW restart
* Plugin editor close/reopen

The implementation shall use the DAW/plugin state mechanism appropriate to the plugin format, such as JUCE state serialization.

The server shall **not** be the authoritative storage location for the user's selected local operating mode.

---

# 8. Track Control Mode

Track Control Mode shall:

1. Register the plugin instance.
2. Assign a unique instance ID.
3. Allow the user to provide a track name.
4. Allow selection of a hierarchy group.
5. Receive hierarchy state.
6. Determine whether the instance is Lead or Secondary.
7. Apply appropriate gain.
8. Smoothly transition between gain states.
9. Operate without streaming.

---

# 9. Streaming Mode

Streaming Mode shall:

1. Create a session.
2. Capture DAW audio.
3. Encode audio.
4. Establish WebRTC.
5. Send audio to the LiveMixStream Server.
6. Allow listeners to connect.
7. Report stream status.
8. Report listener count where available.
9. **Continue operating as a Track Control instance.**
10. **Receive and apply AudioHierarchy commands while streaming.**

---

# 10. Simultaneous Operation

**Streaming Mode inherently provides simultaneous Track Control + Streaming functionality.**

There is no separate third mode.

```text
                    LiveMixStream Plugin
                            │
                    MODE = STREAMING
                            │
                 ┌──────────┴──────────┐
                 │                     │
                 ▼                     ▼
          Track Control           Streaming
                 │                     │
          Hierarchy gain            WebRTC
                 │                     │
                 ▼                     ▼
             DAW output          Server / SFU
```

The user simply selects **Streaming** on the same plugin instance.

Audio path:

```text
DAW
 │
 ▼
LiveMixStream
 │
 ▼
Hierarchy Gain
 │
 ├──────────────► DAW output
 │
 └──► Stream capture
        │
        ▼
      Encode
        │
        ▼
      WebRTC
```

By default, streamed audio shall reflect the hierarchy-adjusted signal.

---

# 11. Plugin Formats

## Windows

* VST3
* x64 initially
* Future ARM64 consideration

## macOS

* VST3
* AU
* Apple Silicon
* Intel where practical

## Linux

* VST3
* x86-64 initially

---

# 12. Cross-Platform Codebase

The majority of the plugin shall share one source codebase.

Recommended technology:

* C++
* JUCE
* CMake

Platform-specific code shall be isolated.

---

# 13. Audio Capture

The plugin shall receive audio from the DAW at its insertion point.

Initial support:

* Mono
* Stereo

Architecture shall permit future multichannel support.

---

# 14. Sample Rates

Initial support:

* 44.1 kHz
* 48 kHz
* 88.2 kHz
* 96 kHz

Future:

* 176.4 kHz
* 192 kHz
* Other rates as practical

---

# 15. Audio Representation

Internal audio processing shall use floating-point samples.

Unnecessary conversions shall be avoided.

---

# 16. Real-Time Audio Safety

The DAW audio thread shall never perform:

* Network I/O
* HTTP
* WebSocket operations
* DNS
* JSON parsing
* File I/O
* Database operations
* Blocking locks
* Potentially blocking memory allocation

Required conceptual architecture:

```text
                  AUDIO THREAD

DAW
 │
 ▼
processBlock()
 │
 ├── hierarchy gain
 │
 └── real-time-safe audio buffer
             │
             ▼
       ASYNCHRONOUS SIDE
             │
             ├── Encoder
             ├── Network
             └── WebRTC
```

---

# 17. AudioHierarchy

AudioHierarchy is the remote gain-control system.

Multiple LiveMixStream instances can participate.

Example:

```text
REAPER

Guitar
 └── LiveMixStream

Vocals
 └── LiveMixStream

Keys
 └── LiveMixStream
```

Browser:

```text
[ Guitar ] [ Vocals ] [ Keys ]
```

Clicking Guitar:

```text
Guitar  = 1.0
Vocals  = 0.3
Keys    = 0.3
```

---

# 18. Fundamental AudioHierarchy Principle

The plugin controls **only the audio passing through its own instance**.

It does not control arbitrary DAW tracks.

Therefore:

```text
Track A
 └── LiveMixStream
     → controllable

Track B
 └── no LiveMixStream
     → unaffected
```

This eliminates the need for DAW-specific mixer APIs.

---

# 19. Hierarchy Roles

```cpp
enum class HierarchyRole
{
    Idle,
    Lead,
    Secondary
};
```

### Idle

No active Lead/Secondary state.

Recommended gain:

```text
1.0
```

### Lead

```text
targetGain = 1.0
```

### Secondary

```text
targetGain = duckGain
```

---

# 20. Plugin Instance Identity

Every instance shall have a unique:

```text
instanceId
```

Example:

```text
b83d1e4c-0f91-4b87-9e72-...
```

The human-readable `trackName` shall not be used as the unique identity.

---

# 21. Track Name

User-defined examples:

* Guitar
* Vocals
* Keys
* Bass
* Kick
* MC
* Playback

Duplicate names shall be permitted.

The web UI shall distinguish duplicates.

---

# 22. Hierarchy Group

Each Track Control instance belongs to one hierarchy group.

Default:

```text
default
```

Examples:

```text
Band
Stage A
Stage B
Broadcast
Main Mix
```

Groups operate independently.

---

# 23. Multiple Groups

Example:

```text
GROUP: BAND

Guitar     LEAD
Bass       SECONDARY
Vocals     SECONDARY
Keys       SECONDARY


GROUP: BROADCAST

Voice      LEAD
Music      SECONDARY
FX         SECONDARY
```

Changing the Lead in BAND shall not affect BROADCAST.

---

# 24. Duck Gain

Default:

```text
0.30
```

Equivalent approximately:

```text
-10.46 dB
```

Range:

```text
0.0–1.0
```

Reference:

```text
1.0  = 0 dB
0.5  = -6.02 dB
0.3  = -10.46 dB
0.25 = -12.04 dB
0.1  = -20 dB
```

---

# 25. Duck Gain Configuration

The server shall hold the authoritative group setting.

The plugin may store a local/default value.

The browser shall be able to modify the group setting.

```text
Browser
   │
   ▼
Server
   │
   ▼
All group members
```

---

# 26. Fade Duration

Default:

```text
200 ms
```

Range:

```text
50–1000 ms
```

The setting shall be authoritative at hierarchy-group level.

---

# 27. Gain Ramp

Gain transitions shall be continuous.

Example:

```text
1.0 ┤╲
    │ ╲
0.3 ┤  ╲────────
    └────────────
       200 ms
```

No:

* Clicks
* Pops
* Zipper noise
* Discontinuities

---

# 28. Gain Ramp Interruption

If a new command arrives during an existing fade:

```text
current gain = 0.55
new target   = 1.0
```

The plugin shall ramp:

```text
0.55 → 1.0
```

rather than restarting from the previous target.

---

# 29. Gain Processing

Recommended:

```text
DAW Track
   │
   ▼
LiveMixStream
   │
   ▼
Hierarchy Gain
   │
   ▼
Plugin Output
   │
   ├──► DAW downstream processing
   │
   └──► Streaming capture
```

The exact stream tap position shall be explicitly defined during implementation.

---

# 30. Hierarchy Network Registration

Plugin → Server:

```json
{
  "type": "HIERARCHY_REGISTER",
  "instanceId": "b83d1e4c-...",
  "trackName": "Guitar",
  "groupId": "default"
}
```

Server → Plugin:

```json
{
  "type": "HIERARCHY_STATE",
  "groupId": "default",
  "leadInstanceId": "b83d1e4c-...",
  "duckGain": 0.3,
  "fadeDurationMs": 200
}
```

---

# 31. Lead Determination

The plugin shall compare:

```text
instanceId
```

with:

```text
leadInstanceId
```

If equal:

```text
Lead
targetGain = 1.0
```

Otherwise:

```text
Secondary
targetGain = duckGain
```

---

# 32. Hierarchy Lifecycle

```text
Plugin
 │
 ▼
Connect WSS
 │
 ▼
Register
 │
 ▼
Receive current state
 │
 ▼
Apply state
```

Disconnect:

```text
Disconnect
   ↓
Server removes instance
```

---

# 33. Reconnection

On reconnect:

```text
CONNECT
 ↓
REGISTER
 ↓
CURRENT HIERARCHY STATE
 ↓
COMPARE
 ↓
SMOOTH RAMP
```

The server is authoritative.

---

# 34. Hierarchy Failure

If the hierarchy connection fails:

* Keep current gain.
* Do not abruptly change gain.
* Attempt reconnection.
* Apply authoritative state after reconnect.

---

# 35. Hierarchy API

## GET `/api/hierarchy`

Example:

```json
{
  "groups": [
    {
      "groupId": "default",
      "leadInstanceId": "abc",
      "duckGain": 0.3,
      "fadeDurationMs": 200,
      "tracks": [
        {
          "instanceId": "abc",
          "trackName": "Guitar",
          "role": "lead"
        },
        {
          "instanceId": "def",
          "trackName": "Vocals",
          "role": "secondary"
        }
      ]
    }
  ]
}
```

---

## POST `/api/hierarchy/lead`

```json
{
  "groupId": "default",
  "instanceId": "abc"
}
```

---

## POST `/api/hierarchy/settings`

```json
{
  "groupId": "default",
  "duckGain": 0.3,
  "fadeDurationMs": 200
}
```

---

# 36. No-Lead State

```json
{
  "groupId": "default",
  "leadInstanceId": null
}
```

Recommended behavior:

```text
All participating tracks → 1.0
```

---

# 37. Hierarchy Web Interface

Route:

```text
/hierarchy
```

The page shall provide:

* Group panels
* Track buttons
* Lead selection
* Duck level
* Fade duration
* Gain indicators
* Connection status
* Real-time synchronization

---

# 38. Hierarchy UI

Example:

```text
┌─────────────────────────────────────────────┐
│ 🎛 AUDIO HIERARCHY             ● CONNECTED │
├─────────────────────────────────────────────┤
│                                             │
│ BAND                                        │
│                                             │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│ │ GUITAR   │ │ VOCALS   │ │ KEYS     │     │
│ │ 100%     │ │ 30%      │ │ 30%      │     │
│ └──────────┘ └──────────┘ └──────────┘     │
│                                             │
│ Duck Level                                  │
│ ───────────────●────────── 30%              │
│                                             │
│ Fade                                        │
│ ─────────●──────────────── 200 ms           │
└─────────────────────────────────────────────┘
```

---

# 39. Browser Synchronization

Multiple browser instances shall remain synchronized.

```text
Phone
  │
  ▼
Server
  │
  ├──► Desktop
  ├──► Tablet
  └──► Plugins
```

---

# 40. Streaming Sessions

Streaming Mode shall create sessions.

Each session shall contain:

```text
sessionId
transmitterInstanceId
createdAt
status
configuration
listenerCount
```

Example:

```text
https://livemixstream.com/s/7F3K9P
```

---

# 41. Session States

```text
Created
Connecting
Live
Paused
Disconnected
Ended
Expired
```

---

# 42. Session Expiration

Default recommendation:

```text
30 minutes without transmitter connection
→ expire session
```

Configurable by server.

---

# 43. WebRTC Transport

WebRTC shall be the preferred initial transport.

It provides:

* Low latency
* Encryption
* NAT traversal
* Packet-loss handling
* Jitter management
* Congestion control
* Browser support

---

# 44. Streaming Audio Quality

Initial target:

```text
48 kHz
Stereo
High-quality codec
```

The architecture shall support configurable quality.

Possible modes:

```text
Low
Medium
High
```

Future:

* Lossless PCM
* Multichannel
* 96 kHz+
* Higher-quality professional modes

---

# 45. Streaming Latency

Target:

```text
Preferred: <300 ms
Acceptable: <500 ms
```

---

# 46. Hierarchy Control Latency

Target:

```text
Preferred control propagation: <100 ms
```

This is independent of the configured audio fade.

---

# 47. Browser Listener

Listeners shall require no installation.

Workflow:

```text
Receive URL
 ↓
Open browser
 ↓
Play
 ↓
Listen
```

Target browsers:

* Chrome
* Edge
* Firefox
* Safari

---

# 48. Listener Controls

Minimum:

* Play/Pause
* Volume
* Mute
* Connection status

Future:

* Latency
* Bitrate
* Quality selection
* Audio meters

---

# 49. Autoplay

The listener application shall gracefully handle browser autoplay restrictions.

If autoplay is unavailable:

```text
[ PLAY ]
```

shall be shown prominently.

---

# 50. SFU Media Distribution

The plugin shall upload the stream once:

```text
Plugin
 │
 │ one encoded stream
 ▼
SFU
 ├──► Listener 1
 ├──► Listener 2
 ├──► Listener 3
 └──► Admin
```

This prevents the transmitter from maintaining one upload per listener.

---

# 51. Network Recovery

Streaming connections shall recover automatically when practical.

```text
CONNECTED
 ↓
LOST
 ↓
RECONNECTING
 ↓
CONNECTED
```

A temporary network failure shall not crash the DAW.

---

# 52. Administration System

LiveMixStream shall provide a dedicated administrator interface.

Route:

```text
/admin
```

The Admin Panel is distinct from the public listener and hierarchy interfaces.

---

# 53. Admin Dashboard

The dashboard shall display:

```text
┌─────────────────────────────────────────────────────┐
│ LIVE MIX STREAM — ADMIN                             │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ACTIVE STREAMS       12                             │
│ ACTIVE LISTENERS     48                             │
│ CONNECTED INSTANCES  37                             │
│ HIERARCHY GROUPS      8                             │
│                                                     │
│ BANDWIDTH             84 Mbps                      │
│ SERVER CPU            31%                          │
│ SERVER RAM            42%                          │
│                                                     │
│ [ STREAMS ] [ INSTANCES ] [ HIERARCHY ] [ SERVERS ]│
└─────────────────────────────────────────────────────┘
```

---

# 54. Instance Registry

The administrator shall be able to see all known LiveMixStream instances.

Each record may include:

* Instance ID
* Plugin version
* DAW where detectable
* OS
* User/account
* Device identifier where available
* Connection state
* Current stream
* Hierarchy group
* Hierarchy role
* Last seen
* Connection duration

---

# 55. Instance Status

The system shall distinguish:

### Active

Connected and communicating.

### Streaming

Connected and actively transmitting audio.

### Connected / Idle

Connected but not currently streaming.

### Disconnected

No current connection.

### Offline / Expired

No connection for a configured historical period.

Example:

```text
Guitar
● STREAMING

Vocals
● CONNECTED / IDLE

Keys
○ DISCONNECTED
Last seen: 18 min ago
```

---

# 56. Instance Search

Admin shall be able to filter/search by:

* Instance ID
* Track name
* Plugin mode
* User
* DAW
* OS
* Version
* Status
* Stream
* Hierarchy group

---

# 57. Instance Detail View

Example:

```text
Track: Guitar
Instance: abc123

Status:
ACTIVE

Plugin:
1.0.0

DAW:
REAPER

OS:
Linux

Hierarchy:
Band
LEAD

Streaming:
Session 7F3K9P
Listeners: 4

Last seen:
2026-08-13 01:32
```

---

# 58. Active Stream Registry

Admin shall see:

```text
ACTIVE STREAMS

Session       Source       Listeners    Bitrate
------------------------------------------------
7F3K9P        Main Mix         4        256 kbps
A81BC2        Rehearsal       12        512 kbps
C712AA        Vocals           1        256 kbps
```

---

# 59. Admin Listen

Administrators shall be able to listen to any active stream.

Action:

```text
[ LISTEN ]
```

The admin becomes an authorized WebRTC listener through the SFU.

```text
Streaming Plugin
        │
        ▼
       SFU
    ┌───┼──────┐
    ▼   ▼      ▼
 Client Client ADMIN
```

The admin does not need access to the transmitter's machine.

---

# 60. Admin Stream Monitoring

While listening, admin shall see:

* Playback
* Session ID
* Source
* Listener count
* Bitrate
* Latency
* Packet loss
* Jitter
* Connection status
* Stream duration

---

# 61. Admin Stream Access

Administrative stream access shall be independent of the public listener URL.

An administrator can listen even when:

* The public URL is unknown.
* The stream is private.
* Public authentication is enabled.

Server authorization shall enforce admin privileges.

---

# 62. Force Disconnect

Admin shall be able to force-disconnect an instance.

```text
[ FORCE DISCONNECT ]
```

The server shall:

1. Close the connection.
2. Mark the instance administratively disconnected.
3. Record the action.
4. Optionally prevent immediate reconnection.

---

# 63. End Stream

Admin shall be able to terminate an active stream.

```text
[ END STREAM ]
```

Listeners shall receive:

```text
Stream ended
```

The plugin itself shall remain installed.

---

# 64. Admin Hierarchy View

Admin shall see all groups:

```text
BAND

Guitar       LEAD
Bass         SECONDARY
Vocals       SECONDARY
Keys         SECONDARY


BROADCAST

Voice        LEAD
Music        SECONDARY
FX           SECONDARY
```

---

# 65. Admin Hierarchy Control

Authorized admins may:

* Select Lead
* Remove Lead
* Change duck level
* Change fade duration
* Remove instance from group
* Disconnect instance

Every action shall be logged.

---

# 66. Server Monitoring

Admin shall see:

* CPU
* RAM
* Disk
* Network ingress
* Network egress
* Active WebSocket connections
* Active WebRTC connections
* Active streams
* Active listeners
* Server uptime
* Application version

---

# 67. Bandwidth Monitoring

Track:

* Total ingress
* Total egress
* Per-stream traffic
* Per-listener traffic
* Per-instance traffic
* Historical usage

Example:

```text
Current outbound: 84 Mbps
Today: 412 GB
Streams: 12
Listeners: 48
```

---

# 68. Connection Statistics

Where available:

* RTT
* Jitter
* Packet loss
* Bitrate
* Connection duration
* Reconnection count
* WebRTC state

---

# 69. Audit Log

Administrative actions shall be recorded.

Example:

```text
01:31:02  Admin selected Vocals as Lead
01:31:14  Admin listened to stream 7F3K9P
01:32:01  Admin changed duck gain to 0.25
01:33:44  Admin disconnected instance ABC123
01:34:12  Admin ended stream A81BC2
```

Each record:

* Timestamp
* Administrator
* Action
* Target
* Result

---

# 70. Authentication

## Plugin

Plugin authentication may use:

* Device token
* API token
* User token

## Administrator

Admin authentication shall be required.

Future:

* Two-factor authentication
* Role-based access control

## Listener

Initially may use session-specific URLs.

---

# 71. Security

Production communication shall use:

```text
HTTPS
WSS
Encrypted WebRTC media
```

Credentials shall never be exposed to listeners.

Admin APIs shall never be publicly writable.

---

# 72. Abuse Protection

Protect against:

* Session flooding
* Connection flooding
* Session-ID brute force
* Excessive listeners
* Unauthorized hierarchy commands
* Authentication abuse

---

# 73. Plugin UI

Because Track Control is the default, the primary plugin UI shall emphasize hierarchy.

The mode selector shall contain **only two options**:

```text
┌─────────────────────────────────┐
│         LiveMixStream            │
│                                  │
│  Track Name                      │
│  [ Vocals                     ]  │
│                                  │
│  Hierarchy Group                 │
│  [ Band                        ]  │
│                                  │
│  ● SECONDARY                     │
│                                  │
│  Duck Level      30%             │
│  ───────────────●──────          │
│                                  │
│  Fade            200 ms          │
│  ───────●────────────────        │
│                                  │
│  MODE                            │
│  ● Track Control                 │
│  ○ Streaming                     │
│                                  │
│  Connection                      │
│  ● Connected                     │
└─────────────────────────────────┘
```

When **Streaming** is selected, Track Control remains active automatically.

There shall be **no "Both" option** and no separate "also stream" control.

The selected mode shall be saved with the plugin instance and restored when the DAW project is reopened.

---

# 74. Streaming UI

When Streaming is selected, the plugin shall expose:

```text
┌─────────────────────────────────┐
│         LiveMixStream            │
│                                  │
│  MODE                            │
│  ○ Track Control                 │
│  ● Streaming                     │
│                                  │
│  STREAM                          │
│                                  │
│  Status:                         │
│  ● LIVE                          │
│                                  │
│  Session:                        │
│  My Mixing Session               │
│                                  │
│  [ CREATE SESSION ]              │
│                                  │
│  Listener URL:                   │
│  livemixstream.com/s/7F3K9P      │
│                                  │
│  [ COPY LINK ]                   │
│                                  │
│  Quality: High                   │
│  Bitrate: 256 kbps              │
│  Listeners: 4                   │
│  Latency: 180 ms                │
│                                  │
│  HIERARCHY                       │
│  ● LEAD                          │
│                                  │
│  [ STOP STREAM ]                 │
└─────────────────────────────────┘
```

The Streaming UI shall continue to display the current hierarchy role because Track Control remains active.

The Streaming mode selection shall be persistent per instance.

---

# 75. Plugin Configuration Persistence

Persist locally as part of the plugin instance's saved state:

* **Operating mode**
* Track name
* Hierarchy group
* Default duck gain
* Default fade duration
* Streaming preferences
* Other non-authoritative settings

The selected operating mode is explicitly required to survive DAW project reloads.

The active Lead shall not be treated as permanent authoritative state.

The server remains authoritative for the current active hierarchy state.

---

# 76. Build System

Recommended:

```text
C++
JUCE
CMake
```

Structure:

```text
LiveMixStream/
├── Source/
│   ├── Audio/
│   ├── Network/
│   ├── Session/
│   ├── Hierarchy/
│   ├── Streaming/
│   ├── Authentication/
│   ├── Plugin/
│   └── UI/
│
├── Server/
├── Public/
├── Tests/
├── Resources/
└── CMakeLists.txt
```

---

# 77. Continuous Integration

CI shall produce:

```text
Windows
└── LiveMixStream.vst3

macOS
├── LiveMixStream.vst3
└── LiveMixStream.component

Linux
└── LiveMixStream.vst3
```

Pipeline:

```text
Build
 ↓
Unit tests
 ↓
Plugin validation
 ↓
Package
 ↓
Code signing
 ↓
macOS notarization
 ↓
Release
```

---

# 78. macOS Distribution

Production builds shall support:

* Developer ID
* Notarization
* Apple Silicon
* AU
* VST3

Distribution may occur directly through the LiveMixStream website.

App Store distribution is not required.

---

# 79. Windows Distribution

Provide:

* VST3
* Installer/package
* Optional code signing

---

# 80. Linux Distribution

Initial:

* `.tar.gz`
* `.zip`

Future:

* `.deb`
* `.rpm`

---

# 81. Infrastructure

The MVP shall operate initially on a single inexpensive VPS.

Minimum initial infrastructure requirements:

* 1–2 CPU cores
* 2–4 GB RAM
* SSD
* Public IP
* UDP support
* HTTPS
* WSS
* WebRTC/SFU capability
* Adequate outbound bandwidth
* Server monitoring

The production system shall use:

```text
HTTPS
    ↓
Web application / Admin / Listener

WSS
    ↓
Plugin signaling / hierarchy control

WebRTC
    ↓
Real-time media

SFU
    ↓
Media distribution
```

Potential providers:

* InterServer
* Google Cloud
* Hetzner
* Other VPS providers

The infrastructure architecture shall not be tightly coupled to a specific provider.

---

# 82. Initial Scaling Target

One server should support at least:

```text
1 transmitter
25 simultaneous listeners
```

The architecture shall permit scaling by adding media servers.

---

# 83. Bandwidth Model

Example at 256 kbps:

```text
10 listeners  ≈ 2.56 Mbps
50 listeners  ≈ 12.8 Mbps
100 listeners ≈ 25.6 Mbps
```

Actual bandwidth will include protocol overhead.

---

# 84. Media Server Scaling

Future:

```text
                    API
                     │
               Load Balancer
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      SFU 1        SFU 2        SFU 3
        │            │            │
      users        users        users
```

---

# 85. Persistent Storage

Active state may initially be held in memory.

Persistent storage will eventually hold:

* Users
* Devices
* Sessions
* Audit logs
* Usage statistics
* Administrative settings

PostgreSQL is recommended when persistent storage becomes necessary.

---

# 86. Observability

Expose metrics for:

* Active streams
* Active listeners
* Connected plugin instances
* Active hierarchy groups
* Bandwidth
* CPU
* RAM
* WebRTC failures
* Packet loss
* Session duration
* Reconnection frequency

---

# 87. Future Hierarchy Modes

Architecture shall support:

### Lead Ducking

```text
Lead = 100%
Others = 30%
```

### Lead Mute

```text
Lead = 100%
Others = 0%
```

### Priority Levels

```text
Priority 1 = 100%
Priority 2 = 60%
Priority 3 = 30%
```

### Multiple Leads

```text
Guitar = 100%
Vocals = 100%
Keys = 30%
Bass = 30%
```

### Crossfade

```text
Old Lead: 100% → 30%
New Lead: 30%  → 100%
```

---

# 88. Future Streaming Features

Potential future functionality:

* Lossless streaming
* Multichannel
* 5.1/7.1
* 96/192 kHz
* Stream recording
* Talkback
* Two-way audio
* Native listener application
* Mobile application
* Client comments
* Timestamped feedback
* Session approval
* Remote monitoring
* Multitrack transmission

---

# 89. Future Administrative Features

Potential future functionality:

* User management
* Organization management
* Role-based permissions
* Usage billing
* Bandwidth quotas
* Stream recording
* Server clusters
* Geographic media-server selection
* Advanced analytics
* Automatic server scaling
* Plugin fleet management
* Remote plugin configuration

---

# 90. Critical Architectural Principle

The most important implementation rule is:

> **Network activity must never block the DAW's real-time audio thread.**

Required separation:

```text
                    REAL-TIME

DAW
 │
 ▼
processBlock()
 │
 ├── Track Control / hierarchy gain
 │
 └── audio buffer
             │
             ▼
          ASYNC
             │
       ┌─────┴──────┐
       ▼            ▼
    Encoder       Network
       │            │
       └─────┬──────┘
             ▼
           WebRTC
```

---

# 91. Complete System Flow

```text
                         ADMIN
                           │
                           ▼
                     /admin
                           │
                           ▼
                  ┌─────────────────┐
                  │ Admin Control   │
                  │ Panel           │
                  └────────┬────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│              LiveMixStream Server                   │
│                                                     │
│ Authentication                                      │
│ Session Manager                                     │
│ Hierarchy Manager                                   │
│ WebRTC Signaling                                    │
│ SFU                                                 │
│ Instance Registry                                   │
│ Admin API                                           │
│ Monitoring                                          │
│ Audit Log                                           │
└────────────────────────┬────────────────────────────┘
                         │
              WSS / WebRTC
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
     LiveMixStream Plugin       LiveMixStream Web
             │                       │
       ┌─────┴─────┐          ┌──────┴────────┐
       │           │          │               │
 Track Control  Streaming   Listener      Hierarchy
     Mode         Mode                    Control
```

---

# 92. End-to-End AudioHierarchy Flow

```text
1. Insert LiveMixStream into:

   Guitar
   Vocals
   Keys

2. Each instance starts in:

   TRACK CONTROL MODE

3. Each registers:

   instanceId
   trackName
   groupId

4. Server creates:

   Band
   ├── Guitar
   ├── Vocals
   └── Keys

5. Browser opens:

   /hierarchy

6. User clicks:

   VOCALS

7. Browser sends:

   POST /api/hierarchy/lead

8. Server updates:

   leadInstanceId = VOCALS

9. Server broadcasts:

   HIERARCHY_STATE

10. Plugins receive state asynchronously.

11. Vocals:

   target = 1.0

12. Guitar:

   target = 0.3

13. Keys:

   target = 0.3

14. Audio threads smoothly ramp.

15. No clicks.

16. Browser clients synchronize.

17. If Streaming functionality is active,
    the remote listeners hear the resulting gain changes.
```

---

# 93. End-to-End Streaming Flow

```text
DAW
 │
 ▼
LiveMixStream Plugin
 │
 ▼
Streaming Mode
 │
 ▼
Audio capture
 │
 ▼
Encoder
 │
 ▼
WebRTC
 │
 ▼
LiveMixStream Server
 │
 ▼
SFU
 │
 ├──► Listener 1
 ├──► Listener 2
 ├──► Listener 3
 └──► Administrator
```

Because Streaming Mode also retains Track Control, the actual audio flow is:

```text
DAW
 │
 ▼
LiveMixStream Plugin
 │
 ▼
Hierarchy Gain
 │
 ├──────────────► DAW output
 │
 └──► Streaming capture
        │
        ▼
      Encoder
        │
        ▼
      WebRTC
        │
        ▼
      Server / SFU
```

---

# 94. End-to-End Administration Flow

```text
Administrator
      │
      ▼
    /admin
      │
      ▼
 Authenticate
      │
      ▼
 Dashboard
      │
      ├── Instances
      ├── Streams
      ├── Listeners
      ├── Hierarchy
      ├── Servers
      ├── Bandwidth
      └── Audit Log
             │
             ├── LISTEN
             ├── END STREAM
             ├── FORCE DISCONNECT
             └── CONTROL HIERARCHY
```

---

# 95. MVP Definition

## LiveMixStream Plugin

One plugin:

* VST3
* AU on macOS
* Windows
* macOS
* Linux
* Track Control as default mode
* Persistent per-instance mode selection
* Streaming capability
* **Streaming mode automatically includes Track Control**
* Stereo audio
* 44.1/48/96 kHz
* Unique instance ID
* Track name
* Hierarchy group
* Duck gain
* Fade duration
* Lead/Secondary state
* Real-time-safe gain ramp
* Session creation
* Shareable URL
* WebRTC
* Listener count
* Diagnostics

## Server

* Authentication
* Plugin registry
* WebSocket signaling
* WebRTC/SFU
* Streaming sessions
* Hierarchy manager
* Hierarchy API
* Admin API
* Monitoring
* Audit log

## Web

### Listener

* Session URL
* Playback
* Volume
* Mute
* Connection state

### Hierarchy

* Groups
* Tracks
* Lead selection
* Duck gain
* Fade duration
* Real-time synchronization

### Admin

* Authentication
* Dashboard
* Instance registry
* Active/inactive status
* Stream registry
* Listener counts
* Hierarchy groups
* Current Leads
* Plugin versions
* Connection statistics
* Bandwidth
* Server health
* Search/filter
* Listen to any active stream
* End stream
* Force disconnect
* Hierarchy control
* Audit log

## Infrastructure

* One initial VPS
* Public IP
* HTTPS
* WSS
* WebRTC
* SFU/media distribution
* UDP support
* Adequate outbound bandwidth
* Basic server monitoring
* Automated builds/CI
* Path to multiple media servers

---

# 96. MVP Acceptance Criteria

## Plugin

1. LiveMixStream loads in Reaper.
2. LiveMixStream loads in Studio One / Fender Studio Pro.
3. LiveMixStream loads in Logic through AU.
4. LiveMixStream loads in supported Linux DAWs through VST3.
5. Multiple instances coexist.
6. New instances default to Track Control mode.
7. Changing the mode persists with the plugin instance.
8. Reloading the DAW project restores the previously selected mode.
9. There is no "Both" option in the mode selector.
10. Selecting Streaming automatically retains Track Control functionality.
11. No second LiveMixStream instance is required to stream and participate in Track Control simultaneously.

## AudioHierarchy

12. Instances register automatically.
13. Unique instance IDs are generated.
14. Track names can be configured.
15. Groups can be configured.
16. Browser can select Lead.
17. Lead reaches unity gain.
18. Secondary tracks reach configured duck gain.
19. Gain transitions are smooth.
20. Rapid Lead changes are glitch-free.
21. Multiple groups are independent.
22. Duplicate track names work.
23. Reconnection restores server state.
24. No DAW-specific API is required.

## Streaming

25. User can switch to Streaming Mode.
26. User can create a session.
27. System generates listener URL.
28. Browser can receive audio.
29. Multiple listeners can connect.
30. Typical latency is below 500 ms.
31. Temporary network failures do not crash the DAW.
32. Streaming and Track Control operate simultaneously on the same plugin instance.

## Administration

33. Admin can authenticate.
34. Admin can see connected instances.
35. Admin can see inactive instances.
36. Admin can see active streams.
37. Admin can see listener counts.
38. Admin can see hierarchy groups.
39. Admin can see current Leads.
40. Admin can see plugin versions.
41. Admin can see connection statistics.
42. Admin can see bandwidth.
43. Admin can see server health.
44. Admin can listen to any active stream.
45. Admin can force-disconnect an instance.
46. Admin can end a stream.
47. Admin can control hierarchy.
48. Administrative actions are audited.

## Infrastructure

49. Production communication uses HTTPS.
50. Plugin signaling uses WSS.
51. Audio streaming uses WebRTC.
52. The server provides SFU/media distribution.
53. The initial deployment works on a single VPS.
54. Basic server resource monitoring is available.
55. CI can build the supported plugin formats.
56. The architecture can later support multiple media servers.

---

# 97. Product Philosophy

The user should install **one plugin**:

```text
LiveMixStream
```

For a new instance, the default experience is:

```text
Insert plugin
      ↓
Track Control mode
      ↓
Name track
      ↓
Choose hierarchy group
      ↓
Plugin connects
      ↓
Ready for Track Control
```

If the user wants to stream:

```text
Select Streaming mode
      ↓
Track Control remains active
      ↓
Create Session
      ↓
Copy URL
      ↓
Send to listeners
```

There is **no need for a second plugin instance** and no separate "Both" mode.

The selected mode remains associated with that plugin instance.

The listener experience:

```text
Click URL
   ↓
Browser
   ↓
Play
   ↓
Listen
```

The hierarchy experience:

```text
Open /hierarchy
      ↓
Select Lead
      ↓
Tracks smoothly duck
```

The administrator experience:

```text
Open /admin
      ↓
See entire LiveMixStream deployment
      ↓
Monitor instances
      ↓
Monitor streams
      ↓
Listen to any active stream
      ↓
Control hierarchy
      ↓
Diagnose problems
```

The central architectural principle is:

> **LiveMixStream is one cross-platform DAW plugin with Track Control as its default capability and Streaming as an optional capability. The selected mode is persistent per plugin instance. Selecting Streaming automatically retains Track Control functionality, so no second plugin instance and no "Both" mode are required. The LiveMixStream Server is a separate backend that coordinates the plugin instances, distributes audio, manages hierarchy state, and provides administrative control.**

The plugin controls only the audio passing through its own DAW instance, allowing AudioHierarchy to work across different DAWs without requiring proprietary DAW APIs, companion applications, OSC, MIDI, Mackie Control, HUI, or other intermediary control mechanisms.
