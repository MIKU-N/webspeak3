import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Ts3Connection, type Ts3ConnectOptions } from "./ts3/connection.js";

const PORT = Number(process.env.PORT ?? 8080);

// In production (Docker), the built web app lives alongside the gateway and
// is served from the same port as the WebSocket endpoint, so a single
// reverse-proxied origin (e.g. a Zoraxy subdomain) is enough for everything.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST ?? path.resolve(__dirname, "../../web/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let filePath = path.join(WEB_DIST, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(WEB_DIST)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        // SPA fallback: unknown paths (client-side routes, or "/") serve index.html.
        filePath = path.join(WEB_DIST, "index.html");
        body = await readFile(filePath);
      }
      res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })();
});

const wss = new WebSocketServer({ server, path: "/ws" });

server.listen(PORT, () => {
  console.log(`WebSpeak3 gateway listening on http://localhost:${PORT} (WebSocket at /ws)`);
});

wss.on("connection", (socket: WebSocket) => {
  let connection: Ts3Connection | undefined;

  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "connect": {
        const options: Ts3ConnectOptions = {
          host: msg.host,
          nickname: msg.nickname,
          serverPassword: msg.serverPassword,
          channelPassword: msg.channelPassword,
          defaultChannel: msg.defaultChannel,
          identity: msg.identity,
        };
        connection = new Ts3Connection(options);
        connection.onEvent((event) => socket.send(JSON.stringify(event)));
        await connection.connect();
        break;
      }
      case "switchChannel": {
        await connection?.switchChannel(msg.channelId);
        break;
      }
      case "sendChatMessage": {
        await connection?.sendChatMessage(msg.message);
        break;
      }
      case "sendServerMessage": {
        await connection?.sendServerMessage(msg.message);
        break;
      }
      case "sendPrivateMessage": {
        await connection?.sendPrivateMessage(msg.clientId, msg.message);
        break;
      }
      case "sendPoke": {
        await connection?.sendPoke(msg.clientId, msg.message ?? "");
        break;
      }
      case "sendAudio": {
        await connection?.sendAudio(msg.pcm);
        break;
      }
      case "setAway": {
        await connection?.setAway(msg.away, msg.message ?? "");
        break;
      }
      case "setInputMuted": {
        await connection?.setInputMuted(msg.muted);
        break;
      }
      case "setOutputMuted": {
        await connection?.setOutputMuted(msg.muted);
        break;
      }
      case "setNickname": {
        await connection?.setNickname(msg.nickname);
        break;
      }
      case "setWhisperTargets": {
        await connection?.setWhisperTargets(msg.channelIds ?? [], msg.clientIds ?? []);
        break;
      }
      case "getClientConnectionInfo": {
        await connection?.getClientConnectionInfo(msg.clientId);
        break;
      }
      case "getServerConnectionInfo": {
        await connection?.getServerConnectionInfo();
        break;
      }
      case "disconnect": {
        await connection?.disconnect(msg.message ?? "");
        break;
      }
      default:
        socket.send(
          JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` })
        );
    }
  });

  socket.on("close", () => {
    connection?.disconnect();
  });
});
