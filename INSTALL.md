# Installation

## Prerequisites

- **Node.js** 20+ and npm
- **Rust** (stable toolchain) — [rustup.rs](https://rustup.rs)
- **CMake** and a C/C++ toolchain — needed to build the Opus codec library
  (`audiopus_sys`) used for voice. On Windows, the Visual Studio "Desktop
  development with C++" workload covers this; on Linux, install `cmake` and
  `build-essential` (or equivalent); on macOS, `cmake` via Homebrew plus Xcode
  command line tools.
- **git**

## 1. Clone the repository

The Rust connector depends on the `tsclientlib` crate, vendored as a git
submodule — make sure to pull it in too:

```bash
git clone --recurse-submodules <your-repo-url>
cd ts-web-client
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

## 2. Build the Rust connector

```bash
cd connector
cargo build
```

> **Note:** if the build fails with a CMake error like `Compatibility with
> CMake < 3.5 has been removed`, it's because the vendored Opus source uses an
> old `cmake_minimum_required`. Work around it with:
>
> ```bash
> CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build
> ```
> (On Windows PowerShell: `$env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"; cargo build`)

This produces `connector/target/debug/ts-connector` (or `ts-connector.exe` on
Windows), which the gateway spawns automatically — no manual step needed
after this.

## 3. Install and start the gateway

```bash
cd gateway
npm install
npm run dev
```

This starts the WebSocket gateway on `ws://localhost:8080`.

## 4. Install and start the web frontend

In a separate terminal:

```bash
cd web
npm install
npm run dev
```

Vite will print a local dev URL (typically `http://localhost:5173`) — open
it in a browser.

## 5. Connect

In the web UI, enter the address of a TeamSpeak server and a nickname, then
click **Connect**. Voice requires microphone permission when you enable the
mic button; the output-device picker (if your browser supports it) requires
no extra permission.

## Rebuilding after changes

- Frontend and gateway changes hot-reload automatically (`npm run dev` in
  both cases).
- Connector changes require a rebuild (`cargo build` in `connector/`) and a
  reconnect from the browser — if the old `ts-connector` binary is still
  running (an active browser connection), disconnect first or the build will
  fail to overwrite the binary.
