import { WebSocketServer, type WebSocket } from "ws";
import { Ts3Connection, type Ts3ConnectOptions } from "./ts3/connection.js";

const PORT = Number(process.env.PORT ?? 8080);

const wss = new WebSocketServer({ port: PORT });

console.log(`Gateway listening on ws://localhost:${PORT}`);

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
      case "sendAudio": {
        await connection?.sendAudio(msg.pcm);
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
