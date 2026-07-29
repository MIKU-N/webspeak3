import { useEffect, useRef, useState } from "react";
import "./App.css";
import {
  AudioPlayer,
  MicCapture,
  SAMPLE_RATE,
  hasNativeOutputPicker,
  listAudioOutputDevices,
  pickAudioOutputDevice,
} from "./voice";

const GATEWAY_URL = "ws://localhost:8080";

const LAST_HOST_KEY = "ts-web-client:last-host";
const LAST_NICKNAME_KEY = "ts-web-client:last-nickname";

type LogEntry = { text: string; kind: "info" | "error" };

interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

type SelectedItem = { type: "server" } | { type: "channel"; id: number };

interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  isChannelCommander: boolean;
}

function ChannelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 3.5c0-.55.45-1 1-1h3.4l1.2 1.4h6.4c.55 0 1 .45 1 1v7.1c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-8.5Z"
        fill="#e8c46a"
        stroke="#b8923f"
        strokeWidth="0.6"
      />
    </svg>
  );
}

function ClientIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5.2" r="3" fill="#6d8fb0" />
      <path d="M2 14c0-3.3 2.7-5.2 6-5.2s6 1.9 6 5.2v.3H2V14Z" fill="#6d8fb0" />
      <circle cx="12.3" cy="12.3" r="2.6" fill="#4caf50" stroke="#fff" strokeWidth="0.8" />
    </svg>
  );
}

function ClientStatusIcons({ client }: { client: ClientInfo }) {
  return (
    <span className="ts-status-icons">
      {client.isChannelCommander && <span title="Channel commander">⭐</span>}
      {client.away && <span title="Away">💤</span>}
      {(client.inputMuted || !client.inputHardwareEnabled) && <span title="Microphone muted">🔇</span>}
      {client.outputMuted && <span title="Sound muted (deafened)">🔕</span>}
    </span>
  );
}

function ServerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="4.2" rx="0.6" fill="#7a8a99" stroke="#5c6b78" strokeWidth="0.5" />
      <rect x="1.5" y="7" width="13" height="4.2" rx="0.6" fill="#8a9aab" stroke="#5c6b78" strokeWidth="0.5" />
      <circle cx="3.5" cy="4.1" r="0.6" fill="#4caf50" />
      <circle cx="3.5" cy="9.1" r="0.6" fill="#4caf50" />
    </svg>
  );
}

function ChannelTree({
  channels,
  clients,
  parent,
  ownClientId,
  talkers,
  selected,
  onSelectItem,
  onSwitchChannel,
  onOpenPrivateChat,
  onPokeClient,
}: {
  channels: ChannelInfo[];
  clients: ClientInfo[];
  parent: number;
  ownClientId: number | null;
  talkers: Set<number>;
  selected: SelectedItem | null;
  onSelectItem: (item: SelectedItem) => void;
  onSwitchChannel: (channelId: number) => void;
  onOpenPrivateChat: (clientId: number, clientName: string) => void;
  onPokeClient: (clientId: number, clientName: string) => void;
}) {
  const children = channels.filter((c) => c.parent === parent).sort((a, b) => a.order - b.order);
  if (children.length === 0) return null;

  return (
    <ul className="ts-tree-list">
      {children.map((channel) => (
        <li key={channel.id}>
          <div
            className={`ts-row ts-channel-row${
              selected?.type === "channel" && selected.id === channel.id ? " ts-row-selected" : ""
            }`}
            onClick={() => onSelectItem({ type: "channel", id: channel.id })}
            onDoubleClick={() => onSwitchChannel(channel.id)}
            title="Click to select, double-click to join"
          >
            <ChannelIcon />
            <span>{channel.name}</span>
            {channel.hasPassword && <span title="Password protected">🔒</span>}
          </div>
          <ul className="ts-tree-list">
            {clients
              .filter((c) => c.channel === channel.id)
              .map((c) => (
                <li key={c.id}>
                  <div
                    className={`ts-row ts-client-row${c.id === ownClientId ? " ts-self" : ""}${
                      talkers.has(c.id) ? " ts-talking" : ""
                    }`}
                    onClick={c.id === ownClientId ? undefined : () => onOpenPrivateChat(c.id, c.name)}
                    title={c.id === ownClientId ? undefined : `Private chat with ${c.name}`}
                  >
                    <ClientIcon />
                    <span>{c.name}</span>
                    <ClientStatusIcons client={c} />
                    {c.id !== ownClientId && (
                      <button
                        className="ts-poke-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPokeClient(c.id, c.name);
                        }}
                        title={`Poke ${c.name}`}
                      >
                        👉
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
          <ChannelTree
            channels={channels}
            clients={clients}
            parent={channel.id}
            ownClientId={ownClientId}
            talkers={talkers}
            selected={selected}
            onSelectItem={onSelectItem}
            onSwitchChannel={onSwitchChannel}
            onOpenPrivateChat={onOpenPrivateChat}
            onPokeClient={onPokeClient}
          />
        </li>
      ))}
    </ul>
  );
}

function InfoPanel({
  selected,
  host,
  serverName,
  serverMaxClients,
  serverVersion,
  serverLicense,
  totalClientCount,
  channels,
  clients,
}: {
  selected: SelectedItem | null;
  host: string;
  serverName: string;
  serverMaxClients: number;
  serverVersion: string;
  serverLicense: string;
  totalClientCount: number;
  channels: ChannelInfo[];
  clients: ClientInfo[];
}) {
  if (!selected || selected.type === "server") {
    return (
      <div className="ts-info-panel">
        <div className="ts-info-title">
          <ServerIcon />
          <span>{serverName || host}</span>
        </div>
        <div className="ts-info-row">
          <span>Adresse:</span> <span>{host}</span>
        </div>
        {serverVersion && (
          <div className="ts-info-row">
            <span>Version:</span> <span>{serverVersion}</span>
          </div>
        )}
        {serverLicense && (
          <div className="ts-info-row">
            <span>Lizenz:</span> <span>{serverLicense}</span>
          </div>
        )}
        <div className="ts-info-row">
          <span>Aktuelle Clients:</span> <span>{totalClientCount} / {serverMaxClients || "∞"}</span>
        </div>
        <div className="ts-info-row">
          <span>Aktuelle Channel:</span> <span>{channels.length}</span>
        </div>
      </div>
    );
  }

  const channel = channels.find((c) => c.id === selected.id);
  if (!channel) return <div className="ts-info-panel" />;
  const clientCount = clients.filter((c) => c.channel === channel.id).length;

  return (
    <div className="ts-info-panel">
      <div className="ts-info-title">
        <ChannelIcon />
        <span>{channel.name}</span>
      </div>
      {channel.topic && (
        <div className="ts-info-row">
          <span>Topic:</span> <span>{channel.topic}</span>
        </div>
      )}
      <div className="ts-info-row">
        <span>Audio Codec:</span> <span>{channel.codec}</span>
      </div>
      <div className="ts-info-row">
        <span>Password protected:</span> <span>{channel.hasPassword ? "Yes" : "No"}</span>
      </div>
      <div className="ts-info-row">
        <span>Clients:</span> <span>{clientCount} / {channel.maxClients ?? "∞"}</span>
      </div>
    </div>
  );
}

interface ChatEntry {
  from: string;
  message: string;
}

interface PmMessage {
  fromSelf: boolean;
  message: string;
}

interface PmThread {
  partnerId: number;
  partnerName: string;
  messages: PmMessage[];
  unread: boolean;
}

type ActiveTab = "channel" | "server" | number;

interface PokeNotice {
  id: number;
  from: string;
  message: string;
}

function ConnectDialog({
  host,
  nickname,
  serverPassword,
  channelPassword,
  defaultChannel,
  expanded,
  connecting,
  onHostChange,
  onNicknameChange,
  onServerPasswordChange,
  onChannelPasswordChange,
  onDefaultChannelChange,
  onToggleExpanded,
  onConnect,
  onCancel,
}: {
  host: string;
  nickname: string;
  serverPassword: string;
  channelPassword: string;
  defaultChannel: string;
  expanded: boolean;
  connecting: boolean;
  onHostChange: (v: string) => void;
  onNicknameChange: (v: string) => void;
  onServerPasswordChange: (v: string) => void;
  onChannelPasswordChange: (v: string) => void;
  onDefaultChannelChange: (v: string) => void;
  onToggleExpanded: () => void;
  onConnect: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ts-dialog-backdrop" onClick={onCancel}>
      <div className="ts-dialog ts-connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>Verbinden</span>
          <button onClick={onCancel} title="Close">
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              Server Nickname oder Adresse:
              <input autoFocus value={host} onChange={(e) => onHostChange(e.target.value)} />
            </label>
            <label className="ts-dialog-field">
              Server Passwort:
              <input
                type="password"
                value={serverPassword}
                onChange={(e) => onServerPasswordChange(e.target.value)}
              />
            </label>
          </div>
          <label className="ts-dialog-field">
            Nickname:
            <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} />
          </label>

          {expanded && (
            <div className="ts-dialog-grid">
              <label className="ts-dialog-field">
                Phonetischer Nickname:
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                Identität:
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                Standard Channel:
                <input value={defaultChannel} onChange={(e) => onDefaultChannelChange(e.target.value)} />
              </label>
              <label className="ts-dialog-field">
                Aufnahmeprofil:
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                Channel Passwort:
                <input
                  type="password"
                  value={channelPassword}
                  onChange={(e) => onChannelPasswordChange(e.target.value)}
                />
              </label>
              <label className="ts-dialog-field">
                Wiedergabeprofil:
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                Einmalige Berechtigung:
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                Hotkeyprofil:
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-checkbox">
                <input type="checkbox" disabled title="Not supported yet" />
                myTeamSpeak ID senden
              </label>
              <label className="ts-dialog-field">
                Sound Pack:
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onToggleExpanded}>{expanded ? "Weniger" : "Mehr"}</button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onConnect} disabled={connecting || !host || !nickname}>
              {connecting ? "Connecting…" : "Verbinden"}
            </button>
            <button disabled title="Not supported in the web client">
              In neuem Tab
            </button>
            <button onClick={onCancel}>Abbrechen</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [host, setHost] = useState(() => localStorage.getItem(LAST_HOST_KEY) ?? "localhost");
  const [nickname, setNickname] = useState(() => localStorage.getItem(LAST_NICKNAME_KEY) ?? "Claude Code");
  const [serverPassword, setServerPassword] = useState("");
  const [channelPassword, setChannelPassword] = useState("");
  const [defaultChannel, setDefaultChannel] = useState("");
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectDialogExpanded, setConnectDialogExpanded] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [serverName, setServerName] = useState("");
  const [serverMaxClients, setServerMaxClients] = useState(0);
  const [serverVersion, setServerVersion] = useState("");
  const [serverLicense, setServerLicense] = useState("");
  const [serverBannerUrl, setServerBannerUrl] = useState("");
  const [treeWidth, setTreeWidth] = useState(260);
  const [upperHeight, setUpperHeight] = useState(340);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serverChat, setServerChat] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [pmThreads, setPmThreads] = useState<Record<number, PmThread>>({});
  const [pokes, setPokes] = useState<PokeNotice[]>([]);
  const [pokeTarget, setPokeTarget] = useState<{ id: number; name: string } | null>(null);
  const [pokeMessage, setPokeMessage] = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("channel");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [micOn, setMicOn] = useState(false);
  const [talkers, setTalkers] = useState<Set<number>>(new Set());
  const [selfActive, setSelfActive] = useState(false);
  const [vadThreshold, setVadThreshold] = useState(0.02);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [outputDeviceLabel, setOutputDeviceLabel] = useState("System default");
  const [connectionsMenuOpen, setConnectionsMenuOpen] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const connectionsMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  const activeTabRef = useRef<ActiveTab>("channel");
  const hasConnectedRef = useRef(false);
  const pokeIdRef = useRef(0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat, serverChat, pmThreads, activeTab]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.threshold = vadThreshold;
  }, [vadThreshold]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab !== "channel") {
      setPmThreads((prev) => {
        const thread = prev[activeTab];
        if (!thread || !thread.unread) return prev;
        return { ...prev, [activeTab]: { ...thread, unread: false } };
      });
    }
  }, [activeTab]);

  const refreshOutputDevices = async () => {
    try {
      const devices = await listAudioOutputDevices();
      setOutputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  useEffect(() => {
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshOutputDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshOutputDevices);
  }, []);

  useEffect(() => {
    return () => socketRef.current?.close();
  }, []);

  const appendLog = (entry: LogEntry) => setLog((prev) => [...prev, entry]);

  const startTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.min(500, Math.max(150, startWidth + (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startUpperResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = upperHeight;
    const onMove = (ev: MouseEvent) => {
      setUpperHeight(Math.min(700, Math.max(120, startHeight + (ev.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const stopMic = () => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    setMicOn(false);
    setSelfActive(false);
  };

  const handleConnect = () => {
    hasConnectedRef.current = false;
    setConnecting(true);
    setConnectError(null);
    setConnectDialogOpen(false);

    const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioContextRef.current = audioContext;
    audioPlayerRef.current = new AudioPlayer(audioContext);

    const socket = new WebSocket(GATEWAY_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "connect",
          host,
          nickname,
          serverPassword: serverPassword || undefined,
          channelPassword: channelPassword || undefined,
          defaultChannel: defaultChannel || undefined,
        })
      );
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "connected":
          hasConnectedRef.current = true;
          setConnecting(false);
          setConnectError(null);
          setConnected(true);
          localStorage.setItem(LAST_HOST_KEY, host);
          localStorage.setItem(LAST_NICKNAME_KEY, nickname);
          setServerName(data.serverName);
          setServerMaxClients(data.serverMaxClients);
          setServerVersion(data.serverVersion);
          setServerLicense(data.serverLicense);
          setServerBannerUrl(data.serverBannerUrl);
          setSelected({ type: "server" });
          setServerChat((prev) => [...prev, { from: "Server", message: data.welcomeMessage }]);
          break;
        case "channels":
          setChannels(data.channels);
          setClients(data.clients);
          break;
        case "chatMessage":
          setChat((prev) => [...prev, { from: data.from, message: data.message }]);
          break;
        case "serverMessage":
          setServerChat((prev) => [...prev, { from: data.from, message: data.message }]);
          break;
        case "privateMessage":
          setPmThreads((prev) => {
            const existing = prev[data.partnerId];
            const thread: PmThread = existing ?? {
              partnerId: data.partnerId,
              partnerName: data.partnerName,
              messages: [],
              unread: false,
            };
            return {
              ...prev,
              [data.partnerId]: {
                ...thread,
                partnerName: data.partnerName,
                messages: [...thread.messages, { fromSelf: data.fromSelf, message: data.message }],
                unread: thread.unread || (!data.fromSelf && activeTabRef.current !== data.partnerId),
              },
            };
          });
          break;
        case "audioOut":
          audioPlayerRef.current?.playFrame(data.pcm);
          break;
        case "talkers":
          setTalkers(new Set<number>(data.clients));
          break;
        case "poke": {
          const id = ++pokeIdRef.current;
          setPokes((prev) => [...prev, { id, from: data.from, message: data.message }]);
          setTimeout(() => setPokes((prev) => prev.filter((p) => p.id !== id)), 10000);
          break;
        }
        case "disconnected":
          hasConnectedRef.current = false;
          setConnecting(false);
          setConnected(false);
          setChannels([]);
          setClients([]);
          setSelected(null);
          setChat([]);
          setServerChat([]);
          setPmThreads({});
          setPokes([]);
          setActiveTab("channel");
          setTalkers(new Set());
          stopMic();
          appendLog({ text: `Disconnected: ${data.reason}`, kind: "info" });
          break;
        case "error":
          if (hasConnectedRef.current) {
            appendLog({ text: data.message, kind: "error" });
          } else {
            setConnecting(false);
            setConnectError(data.message);
          }
          break;
      }
    };

    socket.onerror = () => {
      if (!hasConnectedRef.current) {
        setConnecting(false);
        setConnectError("Could not reach the gateway - is it running?");
      } else {
        appendLog({ text: "WebSocket error (is the gateway running?)", kind: "error" });
      }
    };
    socket.onclose = () => {
      if (!hasConnectedRef.current) {
        setConnecting(false);
        setConnectError((prev) => prev ?? "Connection closed before the server responded");
      }
      setConnected(false);
      stopMic();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  };

  const handleDisconnect = () => socketRef.current?.close();

  useEffect(() => {
    if (!connectionsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!connectionsMenuRef.current?.contains(e.target as Node)) setConnectionsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectionsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [connectionsMenuOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key.toLowerCase() === "s" && !connected && !connecting) {
        e.preventDefault();
        setConnectDialogOpen(true);
      } else if (e.key.toLowerCase() === "d" && connected) {
        e.preventDefault();
        handleDisconnect();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connected, connecting]);

  const handleToggleMic = async () => {
    if (micOn) {
      stopMic();
      return;
    }
    const audioContext = audioContextRef.current;
    if (!audioContext) return;
    try {
      const mic = new MicCapture(
        audioContext,
        (pcm) => socketRef.current?.send(JSON.stringify({ type: "sendAudio", pcm })),
        (active) => setSelfActive(active),
        vadThreshold
      );
      await mic.start();
      micCaptureRef.current = mic;
      setMicOn(true);
      refreshOutputDevices();
    } catch (error) {
      appendLog({ text: `Microphone error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const handleOutputDeviceChange = async (deviceId: string, label?: string) => {
    setOutputDeviceId(deviceId);
    setOutputDeviceLabel(label || (deviceId ? `Output ${deviceId.slice(0, 6)}` : "System default"));
    await audioPlayerRef.current?.setOutputDevice(deviceId);
  };

  const handlePickOutputDevice = async () => {
    try {
      const device = await pickAudioOutputDevice();
      if (device) await handleOutputDeviceChange(device.deviceId, device.label);
    } catch (error) {
      appendLog({ text: `Output device error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const handleSwitchChannel = (channelId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "switchChannel", channelId }));
  };

  const handleSelectItem = (item: SelectedItem) => setSelected(item);

  const handleSendChat = () => {
    const message = chatInput.trim();
    if (!message) return;
    if (activeTab === "channel") {
      socketRef.current?.send(JSON.stringify({ type: "sendChatMessage", message }));
    } else if (activeTab === "server") {
      socketRef.current?.send(JSON.stringify({ type: "sendServerMessage", message }));
    } else {
      socketRef.current?.send(JSON.stringify({ type: "sendPrivateMessage", clientId: activeTab, message }));
    }
    setChatInput("");
  };

  const handleOpenPrivateChat = (clientId: number, clientName: string) => {
    setPmThreads((prev) => ({
      ...prev,
      [clientId]: prev[clientId] ?? { partnerId: clientId, partnerName: clientName, messages: [], unread: false },
    }));
    setActiveTab(clientId);
  };

  const handlePokeClient = (clientId: number, clientName: string) => {
    setPokeTarget({ id: clientId, name: clientName });
    setPokeMessage("");
  };

  const handleSendPoke = () => {
    if (!pokeTarget) return;
    socketRef.current?.send(
      JSON.stringify({ type: "sendPoke", clientId: pokeTarget.id, message: pokeMessage })
    );
    setPokeTarget(null);
    setPokeMessage("");
  };

  const handleClosePrivateChat = (clientId: number) => {
    setPmThreads((prev) => {
      const next = { ...prev };
      delete next[clientId];
      return next;
    });
    setActiveTab((current) => (current === clientId ? "channel" : current));
  };

  const ownClient = clients.find((c) => c.name === nickname) ?? null;
  const displayTalkers =
    selfActive && ownClient ? new Set(talkers).add(ownClient.id) : talkers;

  return (
    <div className={`ts-app ts-theme-${theme}`}>
      <div className="ts-menubar">
        <div className="ts-menubar-dropdown" ref={connectionsMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setConnectionsMenuOpen((v) => !v)}
          >
            Verbindungen
          </span>
          {connectionsMenuOpen && (
            <div className="ts-menu">
              <button
                className="ts-menu-item"
                disabled={connected || connecting}
                onClick={() => {
                  setConnectDialogOpen(true);
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🟢</span>
                <span className="ts-menu-item-label">Verbinden</span>
                <span className="ts-menu-item-shortcut">Strg+S</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleDisconnect();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">Aktuelle Verbindung trennen</span>
                <span className="ts-menu-item-shortcut">Strg+D</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleDisconnect();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">❌</span>
                <span className="ts-menu-item-label">Alle Verbindungen trennen</span>
              </button>
            </div>
          )}
        </div>
        {["Favoriten", "Selbst", "Rechte", "Extras", "Hilfe"].map((item) => (
          <span key={item} className="ts-menubar-item">
            {item}
          </span>
        ))}
      </div>

      <div className="ts-toolbar">
        <div className="ts-toolbar-icons">
          {!connected ? (
            <button
              className="ts-icon-button"
              onClick={() => setConnectDialogOpen(true)}
              disabled={connecting}
              title={connecting ? "Connecting…" : "Connect"}
            >
              🟢
            </button>
          ) : (
            <button className="ts-icon-button" onClick={handleDisconnect} title="Disconnect">
              🔴
            </button>
          )}
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${micOn ? " ts-mic-on" : ""}`}
            onClick={handleToggleMic}
            disabled={!connected}
            title={micOn ? "Voice activation on - click to mute" : "Enable microphone (voice activation)"}
          >
            {micOn ? "🎤" : "🔇"}
          </button>
          <label className="ts-icon-slider" title="Voice activation sensitivity">
            🎚️
            <input
              type="range"
              min={0.002}
              max={0.15}
              step={0.002}
              value={vadThreshold}
              onChange={(e) => setVadThreshold(Number(e.target.value))}
            />
          </label>
          {hasNativeOutputPicker() ? (
            <button className="ts-icon-button" onClick={handlePickOutputDevice} title="Choose output device">
              🔊
            </button>
          ) : (
            <label className="ts-icon-select">
              🔊
              <select
                value={outputDeviceId}
                onChange={(e) => handleOutputDeviceChange(e.target.value)}
                onFocus={refreshOutputDevices}
              >
                <option value="">System default</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="ts-toolbar-sep" />
          <button
            className="ts-icon-button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <span className="ts-app-title">TS Web Client</span>
        </div>

      </div>

      {connectDialogOpen && (
        <ConnectDialog
          host={host}
          nickname={nickname}
          serverPassword={serverPassword}
          channelPassword={channelPassword}
          defaultChannel={defaultChannel}
          expanded={connectDialogExpanded}
          connecting={connecting}
          onHostChange={setHost}
          onNicknameChange={setNickname}
          onServerPasswordChange={setServerPassword}
          onChannelPasswordChange={setChannelPassword}
          onDefaultChannelChange={setDefaultChannel}
          onToggleExpanded={() => setConnectDialogExpanded((v) => !v)}
          onConnect={handleConnect}
          onCancel={() => setConnectDialogOpen(false)}
        />
      )}

      {connectError && (
        <div className="ts-connect-error">
          <span>⚠️ {connectError}</span>
          <button onClick={() => setConnectError(null)} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {pokeTarget && (
        <div className="ts-poke-compose-backdrop" onClick={() => setPokeTarget(null)}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👉 Poke <strong>{pokeTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={pokeMessage}
              onChange={(e) => setPokeMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendPoke();
                if (e.key === "Escape") setPokeTarget(null);
              }}
              placeholder="Optional message..."
            />
            <button onClick={handleSendPoke}>Poke</button>
            <button onClick={() => setPokeTarget(null)}>Cancel</button>
          </div>
        </div>
      )}

      {pokes.map((poke) => (
        <div key={poke.id} className="ts-poke-notice">
          <span>
            👉 <strong>{poke.from}</strong> poked you{poke.message ? `: ${poke.message}` : ""}
          </span>
          <button onClick={() => setPokes((prev) => prev.filter((p) => p.id !== poke.id))} title="Dismiss">
            ✕
          </button>
        </div>
      ))}

      <div className="ts-body">
        <div className="ts-upper" style={{ height: upperHeight }}>
          <div className="ts-tree-panel" style={{ width: treeWidth }}>
            {connected ? (
              <>
                <div
                  className={`ts-row ts-server-row${selected?.type === "server" ? " ts-row-selected" : ""}`}
                  onClick={() => handleSelectItem({ type: "server" })}
                >
                  <ServerIcon />
                  <span>{serverName || host}</span>
                </div>
                <ChannelTree
                  channels={channels}
                  clients={clients}
                  parent={0}
                  ownClientId={ownClient?.id ?? null}
                  talkers={displayTalkers}
                  selected={selected}
                  onSelectItem={handleSelectItem}
                  onSwitchChannel={handleSwitchChannel}
                  onOpenPrivateChat={handleOpenPrivateChat}
                  onPokeClient={handlePokeClient}
                />
              </>
            ) : (
              <div className="ts-tree-empty">Not connected</div>
            )}
          </div>

          <div className="ts-resize-handle-vertical" onMouseDown={startTreeResize} />

          <div className="ts-side-panel">
            {connected && serverBannerUrl && (
              <div className="ts-banner-panel">
                <img className="ts-server-banner" src={serverBannerUrl} alt="" />
              </div>
            )}
            {connected && (
              <InfoPanel
                selected={selected}
                host={host}
                serverName={serverName}
                serverMaxClients={serverMaxClients}
                serverVersion={serverVersion}
                serverLicense={serverLicense}
                totalClientCount={clients.length}
                channels={channels}
                clients={clients}
              />
            )}
          </div>
        </div>

        <div className="ts-resize-handle-horizontal" onMouseDown={startUpperResize} />

        <div className="ts-chat-panel">
          <div className="ts-chat-messages">
            {activeTab === "channel"
              ? chat.map((entry, i) => (
                  <div key={i} className="ts-chat-line">
                    <span className="ts-chat-from">{entry.from}:</span> <span>{entry.message}</span>
                  </div>
                ))
              : activeTab === "server"
                ? serverChat.map((entry, i) => (
                    <div key={i} className="ts-chat-line">
                      <span className="ts-chat-from">{entry.from}:</span> <span>{entry.message}</span>
                    </div>
                  ))
                : pmThreads[activeTab]?.messages.map((entry, i) => (
                    <div key={i} className="ts-chat-line">
                      <span className="ts-chat-from">
                        {entry.fromSelf ? "You" : pmThreads[activeTab].partnerName}:
                      </span>{" "}
                      <span>{entry.message}</span>
                    </div>
                  ))}
            <div ref={chatEndRef} />
          </div>
          <div className="ts-chat-tabs">
            <button
              className={`ts-chat-tab${activeTab === "server" ? " ts-chat-tab-active" : ""}`}
              onClick={() => setActiveTab("server")}
            >
              Server
            </button>
            <button
              className={`ts-chat-tab${activeTab === "channel" ? " ts-chat-tab-active" : ""}`}
              onClick={() => setActiveTab("channel")}
            >
              Channel
            </button>
            {Object.values(pmThreads).map((thread) => (
              <button
                key={thread.partnerId}
                className={`ts-chat-tab${activeTab === thread.partnerId ? " ts-chat-tab-active" : ""}${
                  thread.unread ? " ts-chat-tab-unread" : ""
                }`}
                onClick={() => setActiveTab(thread.partnerId)}
              >
                {thread.partnerName}
                <span
                  className="ts-chat-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClosePrivateChat(thread.partnerId);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="ts-chat-input-row">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
              disabled={!connected}
              placeholder={
                !connected
                  ? "Not connected"
                  : activeTab === "channel"
                    ? "Message channel..."
                    : activeTab === "server"
                      ? "Message server..."
                      : `Message ${pmThreads[activeTab]?.partnerName}...`
              }
            />
            <button onClick={handleSendChat} disabled={!connected}>
              Send
            </button>
          </div>
        </div>
      </div>

      <div className="ts-log">
        {log.map((entry, i) => (
          <div key={i} className={entry.kind === "error" ? "ts-log-error" : "ts-log-info"}>
            {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
