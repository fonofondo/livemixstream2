# AsaphOps

Live audio operations: a Node ops app plus a JUCE companion and thin DAW plugin.

The **companion is the local persistent authority**. The plugin is a DAW adapter. Account-side **Endpoints** are companion machines registered when the companion signs into an AsaphOps account. They cannot be created in the web UI; ops assigns each one to a client after it appears.

See [companion.md](companion.md) for the architecture.

## Ops web app

```bash
cd asaphops
npm install
npm start
```

Open http://localhost:3100

Demo login: `ops@asaphops.local` / `asaphops`

Endpoints stay empty until a companion signs in. Then open **Endpoints**, select the machine, and assign it to a client.

## Companion and plugin

Independent CMake project under `asaphops/` (the old LiveMixStream plugin at the repo root is not built on CI).

```bash
cd asaphops
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

Linux packages typically needed: ALSA/JACK, X11, FreeType, curl, and the usual JUCE GUI deps.

macOS companion + VST3 + AU (universal arm64/x86_64) build on GitHub Actions. Push to `main`/`master`, open a PR, or **Actions → AsaphOps macOS → Run workflow**. Download the **AsaphOps-macOS** artifact (no Apple Developer account; ad-hoc signed only).

On the Mac:

```bash
unzip AsaphOps-macOS-Companion.zip -d /Applications
xattr -cr /Applications/AsaphOps.app
open /Applications/AsaphOps.app

unzip AsaphOps-macOS-VST3.zip -d ~/Library/Audio/Plug-Ins/VST3
xattr -cr ~/Library/Audio/Plug-Ins/VST3/AsaphOps.vst3

unzip AsaphOps-macOS-AU.zip -d ~/Library/Audio/Plug-Ins/Components
xattr -cr ~/Library/Audio/Plug-Ins/Components/AsaphOps.component
```

If Gatekeeper blocks it: Privacy & Security → Open Anyway. Notarization is not used.

In the DAW, add **Mackie Control Universal** on `AsaphOps MCU` and three **Mackie Control Extenders** on `AsaphOps XT1`, `XT2`, `XT3`.

Local Mac build: `asaphops/scripts/build-macos.sh`

Outputs (paths vary slightly by generator):

- Companion (macOS): `build/AsaphOpsCompanion_artefacts/Release/AsaphOps.app`
- Companion (Linux): `build/AsaphOpsCompanion_artefacts/Release/AsaphOps`
- Plugin: `build/AsaphOpsPlugin_artefacts/Release/VST3/AsaphOps.vst3`

On Linux the companion is a normal window (no system tray). JUCE’s X11 tray dock can crash the desktop session.

On macOS the plugin also builds AU. Point the plugin at the companion with `ASAPHOPS_COMPANION=/path/to/AsaphOps` if it cannot find the app automatically.

Sign in from the companion Settings tab (same demo user). That upserts an Endpoint and opens a live socket to AsaphOps. Connected means that socket is up — sign-out, close, or a dropped network shows disconnected. The web UI updates over a server-sent event stream (no polling). Disconnecting or closing the DAW does not delete the endpoint or local project IDs.
