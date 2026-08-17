Yes. I would define the companion architecture around one principle:

> **The plugin is the DAW adapter; the companion application is the persistent authority.**

Account-side **Endpoints** are companion-machine registrations created when the companion signs into AsaphOps. They are not DAW projects, and they are not created in the ops web UI.

## AsaphOps Companion Architecture — v0.1

### 1. Components

```text
┌─────────────────────────────────────────────────────────────┐
│                        ASAPHOPS                              │
│                                                             │
│  ┌──────────────────────┐       ┌────────────────────────┐  │
│  │    Companion App     │       │       DAW Plugin       │  │
│  │                      │       │                        │  │
│  │ • Project registry  │◄─────►│ • Host detection       │  │
│  │ • Session registry  │  IPC  │ • DAW integration      │  │
│  │ • Control surfaces  │       │ • Parameter/control     │  │
│  │ • Configuration      │       │ • Connection           │  │
│  │ • Networking         │       │ • Minimal state        │  │
│  │ • Updates            │       │                        │  │
│  └──────────┬───────────┘       └────────────┬───────────┘  │
│             │                                │              │
└─────────────┼────────────────────────────────┼──────────────┘
              │                                │
        external clients                    DAW
```

The **companion app is always the server**.

The plugin is always a client.

---

# 2. Companion application

Built entirely with **JUCE/C++**.

### Responsibilities

The companion app owns:

* persistent project identities
* DAW identities
* plugin connections
* control-surface connections
* application configuration
* authentication/authorization
* local IPC server
* network communication
* logging/diagnostics
* update mechanism
* optional system-tray/menu-bar presence

It should remain alive independently of any DAW.

### Process model

One companion process per user session:

```text
AsaphOps
   │
   ├── IPC Server
   ├── Project Registry
   ├── Session Manager
   ├── Control Surface Manager
   ├── Network Manager
   └── UI
```

Multiple DAWs and multiple plugin instances connect to the **same process**.

---

# 3. Plugin

Also JUCE.

The plugin should be deliberately thin.

### Responsibilities

* identify its host
* obtain available project/session information
* establish IPC
* report plugin instance information
* receive commands
* send control events
* detect connection loss
* request companion launch when necessary

It should **not** own persistent application/session state.

---

# 4. Automatic launch

This should be a fundamental feature.

When the plugin initializes:

```text
PLUGIN INITIALIZATION
        │
        ▼
Try IPC connection
        │
   ┌────┴────┐
   │         │
success    failure
   │         │
   │         ▼
   │    Launch Companion
   │         │
   │         ▼
   │    Wait for IPC
   │         │
   └─────────┘
        │
        ▼
   Handshake
        │
        ▼
   Connected
```

### Important

The plugin **must never block the DAW's audio thread** while doing this.

Connection/launch happens asynchronously.

---

# 5. Preventing multiple companion processes

The companion uses a well-known IPC endpoint.

Conceptually:

```text
Plugin A ──┐
Plugin B ──┤
Plugin C ──┼──► AsaphOps
Plugin D ──┘
```

All instances connect to the same service.

If the service isn't available, the first plugin attempts to launch it.

The companion itself establishes a single-instance lock.

Therefore:

```text
4 plugin instances
       ↓
1 AsaphOps process
```

not four processes.

---

# 6. Persistent identity

This is the most important part.

The hierarchy should be:

```text
Machine
   │
   └── DAW installation
          │
          └── Project
                 │
                 └── Plugin instance
```

But **only the companion owns persistent identities**.

### Machine ID

Generated once and stored by the companion.

```text
machineId = UUID
```

### DAW identity

Derived from information reported by the plugin:

```text
hostType
hostPath
hostVersion
```

with a generated internal ID maintained by the companion.

### Project identity

The companion maintains:

```text
projectId = UUID
```

and associates it with whatever stable project information the plugin can provide.

For example:

```text
projectId:
    01K2ABC...

daw:
    Studio One

projectPath:
    /Music/Salsa/Show.song
```

The **UUID belongs to the companion's database**, not the plugin.

---

# 7. Critical lifecycle behavior

### Plugin removed

```text
Project
  │
  └── plugin removed
          ↓
    connection disappears

Project remains in registry
```

Nothing is deleted.

### Plugin added again

```text
Plugin starts
     ↓
Companion already knows project
     ↓
Reconnect
     ↓
Same projectId
```

### DAW closed

```text
DAW exits
   ↓
Plugin disconnects
   ↓
Companion remains running
```

Project identity remains.

### Computer reboot

```text
Computer
   ↓
reboot
   ↓
Companion starts
   ↓
registry restored
   ↓
DAW opens
   ↓
plugin connects
   ↓
project recognized
```

---

# 8. Companion startup

I would support **two startup mechanisms**.

### A. OS login startup

The companion can optionally start automatically when the user logs in.

This is ideal for production.

```text
User logs in
    ↓
AsaphOps starts
    ↓
waits for plugins
```

### B. Plugin-triggered startup

If the companion isn't running:

```text
Plugin
  ↓
launch AsaphOps
  ↓
connect
```

This is essential because the user shouldn't have to understand that there is a separate application.

---

# 9. IPC protocol

Start with a simple versioned protocol.

For example:

```json
{
  "protocol": 1,
  "message": "hello",
  "requestId": "..."
}
```

Plugin handshake:

```json
{
  "protocol": 1,
  "message": "plugin_hello",
  "plugin": {
    "id": "...",
    "version": "0.1.0",
    "format": "VST3"
  },
  "host": {
    "type": "StudioOne",
    "version": "...",
    "path": "..."
  }
}
```

Companion response:

```json
{
  "message": "hello_ack",
  "connectionId": "...",
  "projectId": "...",
  "sessionId": "..."
}
```

I'd make the protocol transport-independent so that later you can change the underlying IPC without changing the protocol.

---

# 10. IPC transport

Use native local IPC rather than localhost HTTP as the primary mechanism.

Conceptually:

```text
Linux     Unix domain socket
macOS     Unix domain socket
Windows   Named pipe
```

JUCE can provide the abstraction around the connection.

No internet connection should be required for:

```text
Plugin ↔ Companion
```

This is a **local system relationship**.

---

# 11. Security

The companion should reject arbitrary local clients.

At minimum:

```text
Plugin
   ↓
local IPC
   ↓
authentication/handshake
   ↓
authorized
```

The initial implementation can use a locally generated secret/token stored by the companion.

Later this can become more sophisticated.

---

# 12. UI architecture

The companion should be able to run in two modes:

### Background mode

```text
No window
     │
     └── tray/menu-bar icon
```

### Full application

```text
AsaphOps
────────────────────────
Projects
Devices
Connections
Settings
Diagnostics
────────────────────────
```

The user doesn't need to open it for normal operation.

---

# 13. Failure behavior

The plugin should tolerate the companion disappearing.

```text
Connected
   ↓
Companion crashes
   ↓
Plugin detects disconnect
   ↓
retry
   ↓
launch companion if necessary
   ↓
reconnect
```

Likewise:

```text
Companion
   ↓
DAW disappears
   ↓
plugin connection closes
   ↓
project/session marked inactive
```

**No persistent data should be deleted merely because a connection disappears.**

---

# 14. Platform targets

Single JUCE codebase:

```text
                CMake + JUCE
                     │
        ┌────────────┼────────────┐
        │            │            │
      Linux        macOS       Windows
        │            │            │
      App          App          App
        │            │            │
      VST3         VST3         VST3
                     │
                     AU
```

For macOS:

* Companion `.app`
* VST3
* AU

For Windows:

* Companion `.exe`
* VST3

For Linux:

* Companion executable
* VST3

The core architecture remains identical.

---

# 15. Repository structure

I'd start with:

```text
asaphops/
│
├── CMakeLists.txt
├── JUCE/
│
├── src/
│   ├── shared/
│   │   ├── protocol/
│   │   ├── identity/
│   │   ├── models/
│   │   └── utilities/
│   │
│   ├── companion/
│   │   ├── App.cpp
│   │   ├── App.h
│   │   ├── IPCServer/
│   │   ├── ProjectRegistry/
│   │   ├── SessionManager/
│   │   └── UI/
│   │
│   └── plugin/
│       ├── PluginProcessor.cpp
│       ├── PluginProcessor.h
│       ├── PluginEditor.cpp
│       └── IPCClient/
│
├── resources/
│
└── .github/
    └── workflows/
        ├── linux.yml
        ├── windows.yml
        └── macos.yml
```

---

# 16. The key design rule

I would put this in the architecture specification in bold:

> **The existence or absence of a plugin connection must never determine the existence or identity of a project.**

That gives you the behavior you were after from the beginning:

```text
                 PROJECT
                    │
              persistent ID
                    │
          ┌─────────┴─────────┐
          │                   │
       DAW open           DAW closed
          │
       Plugin
          │
       connected
          │
      Control Surface
```

The plugin is effectively a **door into the DAW**.

The companion application is **the system itself**.

That is the architecture I would build around.
