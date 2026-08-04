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
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

export interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  awayMessage: string;
  isChannelCommander: boolean;
  country: string;
  uid: string;
}

export type ServerLogEntry =
  | { kind: "clientJoin"; client: string; channel: string }
  | { kind: "clientLeave"; client: string }
  | { kind: "clientChannelSwitch"; client: string; fromChannel: string; toChannel: string }
  | { kind: "clientChannelGroupAssigned"; client: string; group: string }
  | { kind: "channelCreated"; channel: string }
  | { kind: "channelDeleted"; channel: string }
  | { kind: "channelEdited"; channel: string }
  | { kind: "serverEdited" }
  | { kind: "permissionError"; action: string };

export type Ts3ConnectionEvent =
  | {
      type: "connected";
      welcomeMessage: string;
      serverName: string;
      serverMaxClients: number;
      serverVersion: string;
      serverLicense: string;
      serverBannerUrl: string;
      identity: string;
    }
  | { type: "channels"; channels: ChannelInfo[]; clients: ClientInfo[] }
  | { type: "chatMessage"; from: string; message: string }
  | { type: "serverMessage"; from: string; message: string }
  | { type: "privateMessage"; partnerId: number; partnerName: string; fromSelf: boolean; message: string }
  | { type: "poke"; from: string; message: string }
  | { type: "audioOut"; pcm: string }
  | { type: "talkers"; clients: number[] }
  | { type: "disconnected"; reason: string }
  | { type: "error"; message: string }
  | ({ type: "serverLog" } & ServerLogEntry)
  | {
      type: "clientConnectionInfo";
      clientId: number;
      pingMs: number | null;
      connectedSecs: number | null;
      ip: string | null;
      packetsSent: number;
      bytesSent: number;
      packetsReceived: number;
      bytesReceived: number;
      packetLossPercent: number;
    }
  | {
      type: "serverConnectionInfo";
      pingMs: number;
      connectedSecs: number;
      packetLossPercent: number;
      packetsSentTotal: number;
      bytesSentTotal: number;
      packetsReceivedTotal: number;
      bytesReceivedTotal: number;
      bandwidthSentLastSecond: number;
      bandwidthReceivedLastSecond: number;
    };

export interface Ts3ConnectOptions {
  host: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  /** Previously-issued identity (from a prior "connected" event) to keep
   *  the same client UID across sessions. Omit to get a freshly generated one. */
  identity?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_BIN =
  process.env.CONNECTOR_BIN ??
  path.resolve(
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
    const args = ["--address", this.options.host, "--nickname", this.options.nickname];
    if (this.options.serverPassword) args.push("--server-password", this.options.serverPassword);
    if (this.options.channelPassword) args.push("--channel-password", this.options.channelPassword);
    if (this.options.defaultChannel) args.push("--default-channel", this.options.defaultChannel);
    if (this.options.identity) args.push("--identity", this.options.identity);
    this.child = spawn(CONNECTOR_BIN, args);

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        interface RawClientInfo {
          id: number;
          channel: number;
          name: string;
          input_muted: boolean;
          output_muted: boolean;
          input_hardware_enabled: boolean;
          away: boolean;
          away_message: string;
          is_channel_commander: boolean;
          country: string;
          uid: string;
        }

        interface RawChannelInfo {
          id: number;
          parent: number;
          order: number;
          name: string;
          topic: string;
          codec: string;
          max_clients: number | null;
          has_password: boolean;
        }

        const event = JSON.parse(line) as
          | {
              type: "connected";
              welcome_message: string;
              server_name: string;
              server_max_clients: number;
              server_version: string;
              server_license: string;
              server_banner_url: string;
              identity: string;
            }
          | { type: "channels"; channels: RawChannelInfo[]; clients: RawClientInfo[] }
          | { type: "chatMessage"; from: string; message: string }
          | { type: "serverMessage"; from: string; message: string }
          | { type: "privateMessage"; partner_id: number; partner_name: string; from_self: boolean; message: string }
          | { type: "poke"; from: string; message: string }
          | { type: "audioOut"; pcm: string }
          | { type: "talkers"; clients: number[] }
          | { type: "disconnected"; reason: string }
          | { type: "error"; message: string }
          | ({ type: "serverLog" } & ServerLogEntry)
          | {
              type: "clientConnectionInfo";
              client_id: number;
              ping_ms: number | null;
              connected_secs: number | null;
              ip: string | null;
              packets_sent: number;
              bytes_sent: number;
              packets_received: number;
              bytes_received: number;
              packet_loss_percent: number;
            }
          | {
              type: "serverConnectionInfo";
              ping_ms: number;
              connected_secs: number;
              packet_loss_percent: number;
              packets_sent_total: number;
              bytes_sent_total: number;
              packets_received_total: number;
              bytes_received_total: number;
              bandwidth_sent_last_second: number;
              bandwidth_received_last_second: number;
            };

        if (event.type === "connected") {
          this.emit({
            type: "connected",
            welcomeMessage: event.welcome_message,
            serverName: event.server_name,
            serverMaxClients: event.server_max_clients,
            serverVersion: event.server_version,
            serverLicense: event.server_license,
            serverBannerUrl: event.server_banner_url,
            identity: event.identity,
          });
        } else if (event.type === "channels") {
          this.emit({
            type: "channels",
            channels: event.channels.map((ch) => ({
              id: ch.id,
              parent: ch.parent,
              order: ch.order,
              name: ch.name,
              topic: ch.topic,
              codec: ch.codec,
              maxClients: ch.max_clients,
              hasPassword: ch.has_password,
            })),
            clients: event.clients.map((c) => ({
              id: c.id,
              channel: c.channel,
              name: c.name,
              inputMuted: c.input_muted,
              outputMuted: c.output_muted,
              inputHardwareEnabled: c.input_hardware_enabled,
              away: c.away,
              awayMessage: c.away_message,
              isChannelCommander: c.is_channel_commander,
              country: c.country,
              uid: c.uid,
            })),
          });
        } else if (event.type === "privateMessage") {
          this.emit({
            type: "privateMessage",
            partnerId: event.partner_id,
            partnerName: event.partner_name,
            fromSelf: event.from_self,
            message: event.message,
          });
        } else if (event.type === "clientConnectionInfo") {
          this.emit({
            type: "clientConnectionInfo",
            clientId: event.client_id,
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            ip: event.ip,
            packetsSent: event.packets_sent,
            bytesSent: event.bytes_sent,
            packetsReceived: event.packets_received,
            bytesReceived: event.bytes_received,
            packetLossPercent: event.packet_loss_percent,
          });
        } else if (event.type === "serverConnectionInfo") {
          this.emit({
            type: "serverConnectionInfo",
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            packetLossPercent: event.packet_loss_percent,
            packetsSentTotal: event.packets_sent_total,
            bytesSentTotal: event.bytes_sent_total,
            packetsReceivedTotal: event.packets_received_total,
            bytesReceivedTotal: event.bytes_received_total,
            bandwidthSentLastSecond: event.bandwidth_sent_last_second,
            bandwidthReceivedLastSecond: event.bandwidth_received_last_second,
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

  async getClientConnectionInfo(clientId: number): Promise<void> {
    this.child?.stdin.write(`clientconninfo ${clientId}\n`);
  }

  async getServerConnectionInfo(): Promise<void> {
    this.child?.stdin.write(`serverconninfo\n`);
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

  async sendPoke(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    this.child?.stdin.write(`poke ${clientId} ${sanitized}\n`);
  }

  async sendAudio(pcmBase64: string): Promise<void> {
    this.child?.stdin.write(`audio ${pcmBase64}\n`);
  }

  async setAway(away: boolean, message: string): Promise<void> {
    if (away) {
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      this.child?.stdin.write(`away ${sanitized}\n`);
    } else {
      this.child?.stdin.write("unaway\n");
    }
  }

  async setInputMuted(muted: boolean): Promise<void> {
    this.child?.stdin.write(`muteinput ${muted ? "1" : "0"}\n`);
  }

  async setOutputMuted(muted: boolean): Promise<void> {
    this.child?.stdin.write(`muteoutput ${muted ? "1" : "0"}\n`);
  }

  async setNickname(nickname: string): Promise<void> {
    const sanitized = nickname.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`nickname ${sanitized}\n`);
  }

  /** Empty channelIds/clientIds clears whisper mode, returning outgoing
   *  voice to the normal current-channel broadcast. */
  async setWhisperTargets(channelIds: number[], clientIds: number[]): Promise<void> {
    if (channelIds.length === 0 && clientIds.length === 0) {
      this.child?.stdin.write("unwhisper\n");
    } else {
      this.child?.stdin.write(`whisper ${channelIds.join(",")};${clientIds.join(",")}\n`);
    }
  }

  async disconnect(message = ""): Promise<void> {
    if (this.child && !this.child.killed) {
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      this.child.stdin.write(`disconnect ${sanitized}\n`);
      this.child.stdin.end();
    }
    this.listeners.clear();
  }
}
