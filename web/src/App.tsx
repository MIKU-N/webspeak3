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

type LogEntry = { text: string; kind: "info" | "error" };

interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
}

interface ClientInfo {
  id: number;
  channel: number;
  name: string;
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
  onSelectChannel,
  onOpenPrivateChat,
}: {
  channels: ChannelInfo[];
  clients: ClientInfo[];
  parent: number;
  ownClientId: number | null;
  talkers: Set<number>;
  onSelectChannel: (channelId: number) => void;
  onOpenPrivateChat: (clientId: number, clientName: string) => void;
}) {
  const children = channels.filter((c) => c.parent === parent).sort((a, b) => a.order - b.order);
  if (children.length === 0) return null;

  return (
    <ul className="ts-tree-list">
      {children.map((channel) => (
        <li key={channel.id}>
          <div className="ts-row ts-channel-row" onClick={() => onSelectChannel(channel.id)}>
            <ChannelIcon />
            <span>{channel.name}</span>
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
            onSelectChannel={onSelectChannel}
            onOpenPrivateChat={onOpenPrivateChat}
          />
        </li>
      ))}
    </ul>
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

function App() {
  const [host, setHost] = useState("localhost");
  const [nickname, setNickname] = useState("Claude Code");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serverChat, setServerChat] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [pmThreads, setPmThreads] = useState<Record<number, PmThread>>({});
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
  const socketRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  const activeTabRef = useRef<ActiveTab>("channel");

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

  const stopMic = () => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    setMicOn(false);
    setSelfActive(false);
  };

  const handleConnect = () => {
    const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioContextRef.current = audioContext;
    audioPlayerRef.current = new AudioPlayer(audioContext);

    const socket = new WebSocket(GATEWAY_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "connect", host, nickname }));
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "connected":
          setConnected(true);
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
        case "disconnected":
          setConnected(false);
          setChannels([]);
          setClients([]);
          setChat([]);
          setServerChat([]);
          setPmThreads({});
          setActiveTab("channel");
          setTalkers(new Set());
          stopMic();
          appendLog({ text: `Disconnected: ${data.reason}`, kind: "info" });
          break;
        case "error":
          appendLog({ text: data.message, kind: "error" });
          break;
      }
    };

    socket.onerror = () => appendLog({ text: "WebSocket error (is the gateway running?)", kind: "error" });
    socket.onclose = () => {
      setConnected(false);
      stopMic();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  };

  const handleDisconnect = () => socketRef.current?.close();

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

  const handleSelectChannel = (channelId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "switchChannel", channelId }));
  };

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
      <div className="ts-toolbar">
        <span className="ts-app-title">TS Web Client</span>
        <div className="ts-toolbar-fields">
          <label>
            Server
            <input value={host} onChange={(e) => setHost(e.target.value)} disabled={connected} />
          </label>
          <label>
            Nickname
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} disabled={connected} />
          </label>
          {!connected ? (
            <button onClick={handleConnect}>Connect</button>
          ) : (
            <button onClick={handleDisconnect}>Disconnect</button>
          )}
          <button
            className={micOn ? "ts-mic-on" : undefined}
            onClick={handleToggleMic}
            disabled={!connected}
            title={micOn ? "Voice activation on - click to mute" : "Enable microphone (voice activation)"}
          >
            {micOn ? "🎤" : "🔇"}
          </button>
          <label title="Voice activation sensitivity">
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
            <button onClick={handlePickOutputDevice} title="Choose output device">
              🔊 {outputDeviceLabel}
            </button>
          ) : (
            <label>
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
          <button
            className="ts-theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </div>

      <div className="ts-body">
        <div className="ts-tree-panel">
          {connected ? (
            <>
              <div className="ts-row ts-server-row">
                <ServerIcon />
                <span>{host}</span>
              </div>
              <ChannelTree
                channels={channels}
                clients={clients}
                parent={0}
                ownClientId={ownClient?.id ?? null}
                talkers={displayTalkers}
                onSelectChannel={handleSelectChannel}
                onOpenPrivateChat={handleOpenPrivateChat}
              />
            </>
          ) : (
            <div className="ts-tree-empty">Not connected</div>
          )}
        </div>

        <div className="ts-chat-panel">
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
