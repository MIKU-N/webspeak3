import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bridges to the real TeamSpeak client protocol via the `ts-connector` Rust
 * binary (built on top of tsclientlib), since that protocol can't be spoken
 * from Node/the browser directly. This process is spawned per connection and
 * emits newline-delimited JSON events on stdout.
 */

export interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
}

export interface ClientInfo {
  id: number;
  channel: number;
  name: string;
}

export type Ts3ConnectionEvent =
  | { type: "connected"; welcomeMessage: string }
  | { type: "channels"; channels: ChannelInfo[]; clients: ClientInfo[] }
  | { type: "chatMessage"; from: string; message: string }
  | { type: "serverMessage"; from: string; message: string }
  | { type: "privateMessage"; partnerId: number; partnerName: string; fromSelf: boolean; message: string }
  | { type: "audioOut"; pcm: string }
  | { type: "talkers"; clients: number[] }
  | { type: "disconnected"; reason: string }
  | { type: "error"; message: string };

export interface Ts3ConnectOptions {
  host: string;
  nickname: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_BIN = path.resolve(
  __dirname,
  "../../../connector/target/debug",
  process.platform === "win32" ? "ts-connector.exe" : "ts-connector"
);

export class Ts3Connection {
  private listeners = new Set<(event: Ts3ConnectionEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;

  constructor(private options: Ts3ConnectOptions) {}

  onEvent(listener: (event: Ts3ConnectionEvent) => void): void {
    this.listeners.add(listener);
  }

  private emit(event: Ts3ConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async connect(): Promise<void> {
    this.child = spawn(CONNECTOR_BIN, [
      "--address",
      this.options.host,
      "--nickname",
      this.options.nickname,
    ]);

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line) as
          | { type: "connected"; welcome_message: string }
          | { type: "channels"; channels: ChannelInfo[]; clients: ClientInfo[] }
          | { type: "chatMessage"; from: string; message: string }
          | { type: "serverMessage"; from: string; message: string }
          | { type: "privateMessage"; partner_id: number; partner_name: string; from_self: boolean; message: string }
          | { type: "audioOut"; pcm: string }
          | { type: "talkers"; clients: number[] }
          | { type: "disconnected"; reason: string }
          | { type: "error"; message: string };

        if (event.type === "connected") {
          this.emit({ type: "connected", welcomeMessage: event.welcome_message });
        } else if (event.type === "privateMessage") {
          this.emit({
            type: "privateMessage",
            partnerId: event.partner_id,
            partnerName: event.partner_name,
            fromSelf: event.from_self,
            message: event.message,
          });
        } else {
          this.emit(event);
        }
      } catch {
        this.emit({ type: "error", message: `Unparseable connector output: ${line}` });
      }
    });

    // stderr carries diagnostic tracing output from the connector (e.g. protocol
    // schema warnings), not application-level errors - keep it server-side only.
    this.child.stderr.on("data", (data) => {
      console.error(`[ts-connector] ${data.toString()}`);
    });

    this.child.on("exit", (code) => {
      if (code !== 0) {
        this.emit({ type: "error", message: `Connector exited with code ${code}` });
      }
    });
  }

  async switchChannel(channelId: number): Promise<void> {
    this.child?.stdin.write(`switch ${channelId}\n`);
  }

  async sendChatMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`chat ${sanitized}\n`);
  }

  async sendServerMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`serverchat ${sanitized}\n`);
  }

  async sendPrivateMessage(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`pm ${clientId} ${sanitized}\n`);
  }

  async sendAudio(pcmBase64: string): Promise<void> {
    this.child?.stdin.write(`audio ${pcmBase64}\n`);
  }

  async disconnect(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.stdin.write("disconnect\n");
      this.child.stdin.end();
    }
    this.listeners.clear();
  }
}
