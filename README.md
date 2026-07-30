<p align="center">
  <img src="web/public/logo.png" width="140" alt="WebSpeak3 logo">
</p>

<h1 align="center">WebSpeak3</h1>

<p align="center">
  <a href="#legal--disclaimer"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-build%20passing-2496ED?logo=docker&logoColor=white" alt="Docker Build"></a>
  <a href="gateway/package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node Version"></a>
  <a href="connector/Cargo.toml"><img src="https://img.shields.io/badge/rust-2021-000000?logo=rust&logoColor=white" alt="Rust Version"></a>
  <img src="https://img.shields.io/badge/status-beta%20%2F%20prototype-yellow" alt="Project Status">
</p>

<p align="center">
  <b>A modern, self-hosted browser client for TeamSpeak 3 servers — no install, just open a tab.</b>
</p>

<p align="center">
  <a href="#-quick-start">🚀 Quick Start</a> ·
  <a href="INSTALL.md">📖 Installation</a> ·
  <a href="https://github.com/Moepchi/webspeak3/issues">🐛 Report Bug</a>
</p>

---

## 📸 Preview

<table>
  <tr>
    <th>Dark Mode</th>
    <th>Light Mode</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/webspeak_dark.png" width="100%" alt="Dark mode screenshot"></td>
    <td><img src="docs/screenshots/webspeak_light.png" width="100%" alt="Light mode screenshot"></td>
  </tr>
</table>

## ✨ Features

|  |  |
|---|---|
| 🔌 **Real TeamSpeak protocol** | Connects to actual TS3/TS6 servers over a WebSocket gateway — the server stays exactly as-is |
| 🎙️ **Low-latency voice** | Opus-encoded voice with voice activation ("Sprachaktivierung") and adjustable sensitivity |
| 🔊 **Custom audio output picker** | Route playback to any output device — works even in browsers without `AudioContext.setSinkId` |
| 💬 **Full text chat** | Channel, server-wide, and private (1:1) chat, each in its own tab |
| 🌳 **Live channel/client tree** | Correct ordering, status icons (channel commander, away, muted, deafened), click to switch channels |
| ⭐ **Favorites & reconnect** | Remembers your last server/nickname; switch servers without leaving your tab |
| 🌗 **Dark / light theme** | Clean, modern UI that adapts to your preference |
| 🔁 **Seamless reconnect** | Switch connections mid-session — old state tears down cleanly, no leaks or duplicates |

## 🧱 Tech Stack

<p>
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

<details>
<summary><b>🏗️ Architecture details</b></summary>

<br>

Browsers can't send raw UDP, which is what TeamSpeak's native protocol runs
over, so a pure client-side implementation isn't possible — a server-side
gateway is required that speaks the real TS protocol on one side and
WebSocket to the browser on the other.

```
Browser (web/)  <--WebSocket-->  Gateway (gateway/)  <--stdin/stdout JSON-->  Rust connector (connector/)  <--TS3/TS6 protocol-->  TeamSpeak Server
```

- **`web/`** — Vite + React frontend. TS3-lookalike UI: channel tree, chat
  tabs, voice controls.
- **`gateway/`** — Node.js/TypeScript WebSocket server. Spawns the Rust
  connector per browser connection and relays newline-delimited JSON events
  between it and the browser.
- **`connector/`** — Rust binary wrapping [`tsclientlib`](https://github.com/ReSpeak/tsclientlib)
  (vendored as a git submodule in `tsclientlib/`), the actual TS3/TS6
  protocol implementation. Handles connecting, channel/client state, chat,
  and Opus-encoded voice.

</details>

## 🚀 Quick Start

Spin up the whole stack with Docker Compose:

```bash
docker compose up -d
```

That's it — open `http://localhost:8080` (or your configured port/reverse
proxy) and connect to any TeamSpeak 3 server.

For manual/non-Docker setup, environment variables, and reverse-proxy notes,
see the full [Installation Guide](INSTALL.md).

## Credits

The vast majority of this project's code was written by [Claude Code](https://claude.com/claude-code) (Anthropic's Claude), working iteratively with the repo owner one feature at a time.

---

### Legal / Disclaimer

**WebSpeak3** is an independent, open-source, self-hosted project and is
**not** affiliated with, associated with, authorized by, endorsed by, or in
any way officially connected with TeamSpeak Systems GmbH.

"TeamSpeak", "TS3", and related logos or names are registered trademarks of
TeamSpeak Systems GmbH. All product and company names are trademarks™ or
registered® trademarks of their respective holders. Use of them does not
imply any affiliation with or endorsement by them.
