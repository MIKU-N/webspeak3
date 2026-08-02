// Standalone frontend demo: no gateway, no real TeamSpeak server. Everything
// below simulates the WebSocket protocol the real gateway speaks (see
// gateway/src/index.ts) so App.tsx doesn't need to know it isn't talking to
// a real backend. Only enabled in the GitHub Pages build (VITE_DEMO_MODE=true)
// so the normal Docker image is completely unaffected.
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export const DEMO_HOST = "demo.webspeak3.example";

interface DemoChannel {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

interface DemoClient {
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
}

const DEMO_CHANNELS: DemoChannel[] = [
  { id: 1, parent: 0, order: 0, name: "Lobby", topic: "Welcome to the WebSpeak3 demo!", codec: "Opus Voice", maxClients: null, hasPassword: false },
  { id: 2, parent: 0, order: 1, name: "Gaming", topic: "", codec: "Opus Voice", maxClients: 10, hasPassword: false },
  { id: 3, parent: 0, order: 2, name: "AFK", topic: "", codec: "Opus Voice", maxClients: null, hasPassword: false },
];

const DEMO_NPCS: DemoClient[] = [
  { id: 102, channel: 1, name: "Alex", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: true, country: "US" },
  { id: 103, channel: 2, name: "Sam", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: false, country: "GB" },
  { id: 104, channel: 2, name: "Jordan", inputMuted: true, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: false, country: "CA" },
  { id: 105, channel: 3, name: "Riley", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: true, awayMessage: "brb, grabbing coffee", isChannelCommander: false, country: "DE" },
];

const SELF_ID = 101;

/**
 * Drop-in stand-in for a real WebSocket. Implements the subset of the
 * WebSocket interface App.tsx actually uses (onopen/onmessage/onerror/
 * onclose/send/close/readyState), so it can be assigned to the same
 * socketRef without any changes to the event-handling code.
 */
export class DemoSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;

  private closed = false;
  private timers: number[] = [];
  private selfChannel = 1;

  constructor() {
    this.after(400, () => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(raw: string) {
    if (this.closed) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.handle(msg);
  }

  close() {
    if (this.closed) return;
    // Mirrors the real gateway: a "disconnected" event arrives before the
    // socket itself finishes closing (see gateway's disconnected event vs.
    // the client-initiated WebSocket close in handleDisconnect).
    this.emit({ type: "disconnected", reason: "client requested" });
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
    this.onclose?.({} as CloseEvent);
  }

  private after(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      if (this.closed) return;
      fn();
    }, ms);
    this.timers.push(id);
  }

  private emit(data: unknown) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  private handle(msg: any) {
    switch (msg.type) {
      case "connect": {
        const nickname = String(msg.nickname || "Guest").trim() || "Guest";
        this.after(900, () => {
          this.emit({
            type: "connected",
            serverName: "WebSpeak3 Demo Server",
            serverMaxClients: 32,
            serverVersion: "3.13.7 [Build: demo]",
            serverLicense: "Demo License",
            serverBannerUrl: null,
            welcomeMessage: "This is a simulated demo - no real TeamSpeak server is involved. Connect with any name/address you like.",
          });
          this.after(150, () => this.sendChannels(nickname));
          this.scriptServerLog(nickname);
        });
        break;
      }
      case "switchChannel": {
        const fromChannel = this.channelName(this.selfChannel);
        this.selfChannel = msg.channelId;
        const toChannel = this.channelName(this.selfChannel);
        this.emit({
          type: "serverLog",
          kind: "clientChannelSwitch",
          client: this.lastNickname,
          fromChannel,
          toChannel,
        });
        this.after(120, () => this.sendChannels(this.lastNickname));
        break;
      }
      case "sendChatMessage":
        this.after(80, () => this.emit({ type: "chatMessage", from: this.lastNickname, message: msg.message }));
        break;
      case "sendServerMessage":
        this.after(80, () => this.emit({ type: "serverMessage", from: this.lastNickname, message: msg.message }));
        break;
      case "sendPrivateMessage": {
        const partner = DEMO_NPCS.find((c) => c.id === msg.clientId);
        this.after(80, () =>
          this.emit({
            type: "privateMessage",
            partnerId: msg.clientId,
            partnerName: partner?.name ?? "Unknown",
            message: msg.message,
            fromSelf: true,
          })
        );
        break;
      }
      case "sendPoke": {
        const partner = DEMO_NPCS.find((c) => c.id === msg.clientId);
        this.after(400, () =>
          this.emit({ type: "poke", from: partner?.name ?? "Someone", message: "(demo poke - no reply expected)" })
        );
        break;
      }
      // "disconnect" is intentionally unhandled here: handleDisconnect() in
      // App.tsx always calls socket.close() right after sending it, and
      // close() already emits the "disconnected" event below.
      // setAway, setInputMuted, setOutputMuted, sendAudio: no observable effect
      // in a simulated single-user session, intentionally no-ops.
      default:
        break;
    }
  }

  private lastNickname = "Guest";

  private channelName(id: number): string {
    return DEMO_CHANNELS.find((c) => c.id === id)?.name ?? "";
  }

  /** A short, scripted burst of Server-tab log lines so the feature is visible
   *  in the demo without needing a second real user to trigger them. */
  private scriptServerLog(nickname: string) {
    this.after(2500, () =>
      this.emit({ type: "serverLog", kind: "clientJoin", client: "Sam", channel: this.channelName(2) })
    );
    this.after(5000, () =>
      this.emit({
        type: "serverLog",
        kind: "clientChannelSwitch",
        client: "Jordan",
        fromChannel: this.channelName(2),
        toChannel: this.channelName(1),
      })
    );
    this.after(7500, () =>
      this.emit({
        type: "serverLog",
        kind: "clientChannelGroupAssigned",
        client: nickname,
        group: "Guest",
      })
    );
  }

  private sendChannels(nickname: string) {
    this.lastNickname = nickname;
    const self: DemoClient = {
      id: SELF_ID,
      channel: this.selfChannel,
      name: nickname,
      inputMuted: false,
      outputMuted: false,
      inputHardwareEnabled: true,
      away: false,
      awayMessage: "",
      isChannelCommander: false,
      country: "",
    };
    this.emit({ type: "channels", channels: DEMO_CHANNELS, clients: [self, ...DEMO_NPCS] });
  }
}
