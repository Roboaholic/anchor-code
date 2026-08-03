# Anchor Mobile

Anchor Mobile is the Android companion for Anchor Code. It connects to the
desktop app through the end-to-end encrypted Anchor Relay and keeps all
workspace, Git, comment, terminal, and agent operations on the PC.

## Implemented features

- Pair with the PC by scanning one encrypted Anchor Relay QR code. The App has
  no IP address, port, or token form.
- Review commit-to-worktree changes with inline or side-by-side diffs.
- Browse folders, search workspace content, and preview Markdown.
- Tap one or two lines to create a structured Anchor Code comment.
- Set comments to `discussing`, `need_modify`, or `closed`, and reply remotely.
- Start configured agent CLI sessions on the PC and operate their complete
  xterm-compatible TUI, including ANSI color, cursor updates, keyboard input,
  scrollback, reconnect replay, and terminal resize.
- Pair by scanning the QR code shown by the PC, with camera and image-picker
  scanning available in the Android app.
- Choose and switch between recent workspaces previously opened on the PC;
  mobile selections are synchronized back to the desktop window.
- Phone and tablet layouts with touch-sized controls and safe-area support.

## Architecture

```text
Android React UI
  -> Repository
  -> AES-GCM WebSocket Relay Transport
  -> Cloudflare Worker + Durable Object (opaque forwarding)
  -> transport-neutral RemoteRequestHandler (PC)
  -> existing Host / History / Annotations / Terminal / Agent services
  -> active Local, WSL, or SSH workspace
```

The Android app never receives direct filesystem or shell access. Paths are
restricted to the workspace currently open in Anchor Code. Terminal and agent
processes continue to run on the PC if the mobile app disconnects.

The PC and App both open outbound WSS connections to the public Relay. The PC
does not listen on a LAN port, and Cloudflare cannot read source code, prompts,
terminal data, or API results because those payloads are encrypted end to end.
See
[../REMOTE_CONNECTIVITY_PLAN.md](../REMOTE_CONNECTIVITY_PLAN.md) for the
beginner-oriented explanation, detailed milestones, and acceptance criteria.

## Desktop setup

1. Run Anchor Code and open the workspace to review.
2. Open **Settings -> Mobile access**.
3. Enable **Mobile access** and wait until the Relay status is `online`.
4. Scan the generated QR code in Anchor Mobile.
5. Approve the pending mobile device on the PC.
6. Select a workspace from the PC's recent-workspace list. A workspace must be
   opened on the PC at least once before it can be selected remotely.

The production Relay is fixed to
`https://anchor-code-relay.anchor-code-mobile.workers.dev`. After approval, the
App stores its independently revocable device credential and reconnects without
scanning again. Pairing QR codes expire and should not be published.

## Mobile-data access

No PC IP address, router port mapping, overlay network, reverse proxy, or second
PC program is required. Both devices only need outbound access to the Anchor
Relay. In networks where `workers.dev` is unreachable, the phone must use a
network path such as the VPN already verified for this deployment.

## Web preview

Directly opening `mobile/web/index.html` with `file://` cannot load Vite ES
modules. Use the preview server:

```bash
npm run mobile:preview
```

Then open <http://127.0.0.1:5174/>.

## APK regression baseline

Run the minimum APK safety gate before changing or packaging mobile features:

```bash
npm run mobile:baseline
```

It contains two layers and does not require an Android emulator:

1. Vitest component/contract tests cover Agent session visibility, shared
   navigation state, Review comment persistence, Markdown/Mermaid rendering,
   and encrypted Relay transport compatibility.
2. Playwright runs the app in a 390 x 844 touch-enabled Chromium viewport and
   verifies the scanner frame, scrolling and bottom navigation, Agent
   full-screen transitions, Review comments, and older WebView compatibility.

Both the pull-request CI APK job and the unified PC/mobile release workflow run
this gate before building an APK. A failed baseline therefore prevents the
GitHub Release from being published without its APK.

## Build APK

Mobile Web has its own package manifest and type-check boundary in `mobile/web/`.
It consumes only the versioned types under `contracts/remote-api/v1`; PC service
implementation files are not imported into the mobile application.

Local APK versions can be supplied independently when needed:

```bash
./gradlew assembleRelease -PanchorMobileVersionCode=2 -PanchorMobileVersionName=0.2.0
```

```bash
npm run mobile:apk
```

Output:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Official APK releases use the same version as the PC application. Pushing a
`v*` tag builds the desktop installers and `Anchor-Mobile-<version>.apk`, then
attaches all of them to the same GitHub Release.

The Android shell is deliberately small: one Java Activity hosts the bundled
React application in a WebView. The web bundle is generated directly into
`app/src/main/assets`.

## Three-stage verification

The `verification/` scripts follow the same contract-first approach used by the
referenced app-simulation workflow:

1. `phase1_api.sh`: production Relay health and protocol version.
2. `phase2_emulator.sh`: x86_64 APK install/start at the QR scan screen.
3. `phase3_tablet.sh`: arm64 tablet install/start through a dedicated Windows
   ADB server, followed by real QR pairing.

Copy `verification/contract.sh.example` to a private file, fill in device paths,
and source it before running a phase.
