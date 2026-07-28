# TS Web Client

Browser-based client for TeamSpeak servers — same idea as the native
installable client, but running in a web browser. The TeamSpeak server side
stays exactly as-is (a regular TS server); only the client is being
reimagined.

**Status: private prototype, not for production use.**

## Features

- Connect to a real TeamSpeak (3/5/6) server
- Channel/client tree with correct ordering, click to switch channels
- Text chat: channel, server-wide, and private (1:1) — each in its own tab
- Voice with voice activation ("Sprachaktivierung", not push-to-talk),
  adjustable sensitivity, and per-client speaking indicators
- Audio output device picker (routes playback to a chosen device)
- Light/dark theme

## Architecture

Browsers can't send raw UDP, which is what TeamSpeak's native protocol runs
over, so a pure client-side implementation isn't possible — a server-side
gateway is required that speaks the real TS protocol on one side and
WebSocket to the browser on the other.

```
Browser (web/)  <--WebSocket-->  Gateway (gateway/)  <--stdin/stdout JSON-->  Rust connector (connector/)  <--TS3/TS5 protocol-->  TeamSpeak Server
```

- **`web/`** — Vite + React frontend. TS3-lookalike UI: channel tree, chat
  tabs, voice controls.
- **`gateway/`** — Node.js/TypeScript WebSocket server. Spawns the Rust
  connector per browser connection and relays newline-delimited JSON events
  between it and the browser.
- **`connector/`** — Rust binary wrapping [`tsclientlib`](https://github.com/ReSpeak/tsclientlib)
  (vendored as a git submodule in `tsclientlib/`), the actual TS3/TS5
  protocol implementation. Handles connecting, channel/client state, chat,
  and Opus-encoded voice.

## Installation

See [INSTALL.md](INSTALL.md).
