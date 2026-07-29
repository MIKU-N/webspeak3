import { useEffect, useRef, useState } from "react";
import "./App.css";
import {
  AudioPlayer,
  MicCapture,
  SAMPLE_RATE,
  hasNativeOutputPicker,
  listAudioInputDevices,
  listAudioOutputDevices,
  pickAudioOutputDevice,
} from "./voice";

// In dev, the gateway runs standalone on its own port. In production it's
// served from the same origin/port as the web app (single container behind a
// reverse proxy), so derive the WebSocket URL from the current location.
const GATEWAY_URL = import.meta.env.DEV
  ? "ws://localhost:8080"
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

const LAST_HOST_KEY = "ts-web-client:last-host";
const LAST_NICKNAME_KEY = "ts-web-client:last-nickname";
const FAVORITES_KEY = "ts-web-client:favorites";
const INPUT_DEVICE_KEY = "ts-web-client:input-device";
const PLAYBACK_VOLUME_KEY = "ts-web-client:playback-volume";
const NOISE_SUPPRESSION_KEY = "ts-web-client:noise-suppression";
const ECHO_CANCELLATION_KEY = "ts-web-client:echo-cancellation";
const VAD_HANGOVER_KEY = "ts-web-client:vad-hangover";

function loadBoolPref(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

function loadNumberPref(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Favorite {
  id: string;
  bookmarkName: string;
  nickname: string;
  host: string;
  serverPassword: string;
  defaultChannel: string;
  defaultChannelPassword: string;
}

function loadFavorites(): Favorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? (JSON.parse(raw) as Favorite[]) : [];
  } catch {
    return [];
  }
}

const AWAY_PRESETS_KEY = "ts-web-client:away-presets";

function loadAwayPresets(): string[] {
  try {
    const raw = localStorage.getItem(AWAY_PRESETS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

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
  awayMessage: string;
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
                    {c.away && c.awayMessage && (
                      <span className="ts-client-away-message">({c.awayMessage})</span>
                    )}
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

function FavoritesDialog({
  favorites,
  prefillNew,
  onSave,
  onClose,
}: {
  favorites: Favorite[];
  prefillNew?: Omit<Favorite, "id" | "bookmarkName">;
  onSave: (favorites: Favorite[]) => void;
  onClose: () => void;
}) {
  const pendingNewRef = useRef<Favorite | null>(
    prefillNew
      ? {
          id: crypto.randomUUID(),
          bookmarkName: prefillNew.host || "Neuer Favorit",
          ...prefillNew,
        }
      : null
  );
  const [draft, setDraft] = useState<Favorite[]>(() =>
    pendingNewRef.current ? [...favorites, pendingNewRef.current] : favorites.map((f) => ({ ...f }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    pendingNewRef.current ? pendingNewRef.current.id : (favorites[0]?.id ?? null)
  );

  const selected = draft.find((f) => f.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<Favorite>) => {
    if (!selectedId) return;
    setDraft((prev) => prev.map((f) => (f.id === selectedId ? { ...f, ...patch } : f)));
  };

  const handleNewFavorite = () => {
    const nf: Favorite = {
      id: crypto.randomUUID(),
      bookmarkName: "Neuer Favorit",
      nickname: "",
      host: "",
      serverPassword: "",
      defaultChannel: "",
      defaultChannelPassword: "",
    };
    setDraft((prev) => [...prev, nf]);
    setSelectedId(nf.id);
  };

  const handleRemove = () => {
    if (!selectedId) return;
    setDraft((prev) => prev.filter((f) => f.id !== selectedId));
    setSelectedId(null);
  };

  return (
    <div className="ts-dialog-backdrop" onClick={onClose}>
      <div className="ts-dialog ts-favorites-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>🔖 myTeamSpeak Favoriten</span>
          <button onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="ts-favorites-body">
          <div className="ts-favorites-list-col">
            <div className="ts-favorites-list-group-title">Synchronisierte Favoriten</div>
            <div className="ts-favorites-list-empty">Nicht angemeldet</div>
            <div className="ts-favorites-list-group-title">Lokale Favoriten</div>
            <ul className="ts-favorites-list">
              {draft.map((f) => (
                <li
                  key={f.id}
                  className={`ts-favorites-list-item${f.id === selectedId ? " ts-favorites-list-item-selected" : ""}`}
                  onClick={() => setSelectedId(f.id)}
                >
                  {f.bookmarkName || "(unbenannt)"}
                </li>
              ))}
            </ul>
          </div>

          <div className="ts-favorites-fields-col">
            <label className="ts-dialog-field">
              Bookmark Name:
              <input
                disabled={!selected}
                value={selected?.bookmarkName ?? ""}
                onChange={(e) => updateSelected({ bookmarkName: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              Nickname:
              <input
                disabled={!selected}
                value={selected?.nickname ?? ""}
                onChange={(e) => updateSelected({ nickname: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              Phonetischer Nickname:
              <input disabled title="Not supported yet" />
            </label>
            <label className="ts-dialog-field">
              Server Nickname oder Adresse:
              <input
                disabled={!selected}
                value={selected?.host ?? ""}
                onChange={(e) => updateSelected({ host: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              Server Passwort:
              <input
                type="password"
                disabled={!selected}
                value={selected?.serverPassword ?? ""}
                onChange={(e) => updateSelected({ serverPassword: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              Standard Channel:
              <input
                disabled={!selected}
                value={selected?.defaultChannel ?? ""}
                onChange={(e) => updateSelected({ defaultChannel: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              Standard Channel Passwort:
              <input
                type="password"
                disabled={!selected}
                value={selected?.defaultChannelPassword ?? ""}
                onChange={(e) => updateSelected({ defaultChannelPassword: e.target.value })}
              />
            </label>
          </div>

          <div className="ts-favorites-profile-col">
            <label className="ts-dialog-field">
              Identität:
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              Aufnahmeprofil:
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              Wiedergabeprofil:
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              Hotkeyprofil:
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              Sound Pack:
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled defaultChecked title="Not supported yet" />
              ServerQuery Clients anzeigen
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title="Not supported yet" />
              Beim Start verbinden
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title="Not supported yet" />
              Aktiviere myTeamSpeak Funktionen
            </label>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleNewFavorite}>Neuer Favorit</button>
            <button disabled title="Not supported in the web client">
              Neuer Ordner
            </button>
            <button onClick={handleRemove} disabled={!selected}>
              Entfernen
            </button>
          </div>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              OK
            </button>
            <button onClick={onClose}>Abbrechen</button>
            <button onClick={() => onSave(draft)}>Anwenden</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AwayDialog({
  message,
  presets,
  onMessageChange,
  onOk,
  onSaveTemplate,
  onCancel,
}: {
  message: string;
  presets: string[];
  onMessageChange: (v: string) => void;
  onOk: () => void;
  onSaveTemplate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ts-dialog-backdrop" onClick={onCancel}>
      <div className="ts-dialog ts-away-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>Abwesenheit-Nachricht setzen</span>
          <button onClick={onCancel} title="Close">
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <span className="ts-dialog-away-label">Nachricht:</span>
            <label className="ts-dialog-field">
              Vorlage:
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onMessageChange(e.target.value);
                }}
              >
                <option value="">&lt;None&gt;</option>
                {presets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            autoFocus
            className="ts-away-message-input"
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onOk()}
          />
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onOk}>OK</button>
            <button onClick={onSaveTemplate} disabled={!message.trim()}>
              Speichern
            </button>
            <button onClick={onCancel}>Abbrechen</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const OPTIONS_SECTIONS = [
  { id: "anwendung", icon: "🎧", label: "Anwendung" },
  { id: "wiedergabe", icon: "🔊", label: "Wiedergabe" },
  { id: "aufnahme", icon: "🎙️", label: "Aufnahme" },
  { id: "design", icon: "🖌️", label: "Design" },
  { id: "erweiterungen", icon: "🧩", label: "Erweiterungen" },
  { id: "hotkeys", icon: "⌨️", label: "Hotkeys" },
  { id: "whispern", icon: "🤫", label: "Whispern" },
  { id: "downloads", icon: "⬇️", label: "Downloads" },
  { id: "chat", icon: "💬", label: "Chat" },
  { id: "sicherheit", icon: "🛡️", label: "Sicherheit" },
  { id: "nachrichten", icon: "🔤", label: "Nachrichten" },
  { id: "meldungen", icon: "ℹ️", label: "Meldungen" },
] as const;

interface AudioSettings {
  outputDevices: MediaDeviceInfo[];
  outputDeviceId: string;
  onOutputDeviceChange: (id: string, label?: string) => void;
  onRefreshOutputDevices: () => void;
  playbackVolume: number;
  onPlaybackVolumeChange: (v: number) => void;
  onPlayTestTone: () => void;
  inputDevices: MediaDeviceInfo[];
  inputDeviceId: string;
  onInputDeviceChange: (id: string) => void;
  onRefreshInputDevices: () => void;
  micOn: boolean;
  micLevelRef: React.MutableRefObject<number>;
  micTestOn: boolean;
  onToggleMicTest: () => void;
  vadThreshold: number;
  onVadThresholdChange: (v: number) => void;
  vadHangover: number;
  onVadHangoverChange: (v: number) => void;
  noiseSuppressionEnabled: boolean;
  onToggleNoiseSuppression: () => void;
  echoCancellationEnabled: boolean;
  onToggleEchoCancellation: () => void;
}

function MicLevelBar({ levelRef, active }: { levelRef: React.MutableRefObject<number>; active: boolean }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      setLevel(levelRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelRef]);
  const pct = Math.min(100, Math.round((level / 0.2) * 100));
  return (
    <div className="ts-options-level-track">
      <div className="ts-options-level-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function WiedergabePanel({ audio }: { audio: AudioSettings }) {
  const volumeDb = Math.round(20 * Math.log10(audio.playbackVolume || 0.001) * 10) / 10;
  return (
    <>
      <h3>Wiedergabe</h3>
      <p className="ts-options-subtitle">Ändern der Wiedergabeeinstellungen</p>
      <div className="ts-options-field-row">
        <label>Profile</label>
      </div>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">Standard</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            Wiedergabegerät:
            <select
              value={audio.outputDeviceId}
              onFocus={audio.onRefreshOutputDevices}
              onChange={(e) => audio.onOutputDeviceChange(e.target.value)}
            >
              <option value="">System default</option>
              {audio.outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <div className="ts-options-slider-row">
            <span>Leise</span>
            <span className="ts-options-slider-label">Sprachlautstärke</span>
            <span>Laut</span>
          </div>
          <div className="ts-options-slider-with-value">
            <input
              type="range"
              min={0}
              max={2}
              step={0.02}
              value={audio.playbackVolume}
              onChange={(e) => audio.onPlaybackVolumeChange(Number(e.target.value))}
            />
            <span className="ts-options-db-value">
              {volumeDb > 0 ? "+" : ""}
              {volumeDb} dB
            </span>
          </div>
          <button onClick={audio.onPlayTestTone}>▶ Test Ton abspielen</button>
          <fieldset className="ts-options-fieldset">
            <legend>Optionen</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              Automatische Lautstärkeanpassung
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              Eigener Client spielt Mikro Klicks
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" disabled readOnly />
              Andere Clients spielen Mikro Klicks
            </label>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AufnahmePanel({ audio }: { audio: AudioSettings }) {
  return (
    <>
      <h3>Aufnahme</h3>
      <p className="ts-options-subtitle">Ändern der Aufnahmeeinstellungen</p>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">Standard</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            Aufnahmegerät:
            <select
              value={audio.inputDeviceId}
              onFocus={audio.onRefreshInputDevices}
              onChange={(e) => audio.onInputDeviceChange(e.target.value)}
            >
              <option value="">System default</option>
              {audio.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ts-options-fieldset">
            <legend>Activation</legend>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              Push-To-Talk
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              Dauersenden
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" checked readOnly />
              Automatische Spracherkennung
            </label>
            <div className="ts-options-level-wrap">
              <MicLevelBar levelRef={audio.micLevelRef} active={audio.micOn} />
              <input
                className="ts-options-level-threshold"
                type="range"
                min={0.002}
                max={0.15}
                step={0.002}
                value={audio.vadThreshold}
                onChange={(e) => audio.onVadThresholdChange(Number(e.target.value))}
              />
            </div>
            <div className="ts-options-field-row">
              <button onClick={audio.onToggleMicTest} disabled={!audio.micOn}>
                {audio.micTestOn ? "Test beenden" : "Test starten"}
              </button>
              <span className={`ts-options-test-dot${audio.micTestOn ? " ts-options-test-dot-on" : ""}`} />
              <label className="ts-options-field-inline">
                Abschaltverzögerung:
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={audio.vadHangover}
                  onChange={(e) => audio.onVadHangoverChange(Number(e.target.value))}
                />
                Sek
              </label>
            </div>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>Digital Signal Processing</legend>
            <div className="ts-options-dsp-grid">
              <label className="ts-options-checkbox">
                <input type="checkbox" disabled readOnly />
                Typing attenuation
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.echoCancellationEnabled}
                  onChange={audio.onToggleEchoCancellation}
                />
                Echo Dämpfung
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.noiseSuppressionEnabled}
                  onChange={audio.onToggleNoiseSuppression}
                />
                Hintergrundgeräusche entfernen
              </label>
            </div>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function OptionsDialog({
  section,
  onSectionChange,
  onClose,
  audio,
}: {
  section: string;
  onSectionChange: (id: string) => void;
  onClose: () => void;
  audio: AudioSettings;
}) {
  const active = OPTIONS_SECTIONS.find((s) => s.id === section) ?? OPTIONS_SECTIONS[0];
  return (
    <div className="ts-dialog-backdrop" onClick={onClose}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>Optionen</span>
          <button onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="ts-options-body">
          <div className="ts-options-sidebar">
            {OPTIONS_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`ts-options-sidebar-item${s.id === active.id ? " ts-options-sidebar-item-active" : ""}`}
                onClick={() => onSectionChange(s.id)}
              >
                <span className="ts-options-sidebar-icon">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {active.id === "wiedergabe" ? (
              <WiedergabePanel audio={audio} />
            ) : active.id === "aufnahme" ? (
              <AufnahmePanel audio={audio} />
            ) : (
              <>
                <h3>{active.label}</h3>
                <p className="ts-options-placeholder">Diese Einstellungen sind noch nicht implementiert.</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>OK</button>
            <button onClick={onClose}>Abbrechen</button>
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
  const [vadHangover, setVadHangover] = useState(() => loadNumberPref(VAD_HANGOVER_KEY, 0.3));
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [outputDeviceLabel, setOutputDeviceLabel] = useState("System default");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState(() => localStorage.getItem(INPUT_DEVICE_KEY) ?? "");
  const [playbackVolume, setPlaybackVolume] = useState(() => loadNumberPref(PLAYBACK_VOLUME_KEY, 1));
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(() =>
    loadBoolPref(NOISE_SUPPRESSION_KEY, true)
  );
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(() =>
    loadBoolPref(ECHO_CANCELLATION_KEY, true)
  );
  const [micTestOn, setMicTestOn] = useState(false);
  const [connectionsMenuOpen, setConnectionsMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites());
  const [favoritesMenuOpen, setFavoritesMenuOpen] = useState(false);
  const [favoritesDialogMode, setFavoritesDialogMode] = useState<
    { kind: "add"; prefill: Omit<Favorite, "id" | "bookmarkName"> } | { kind: "manage" } | null
  >(null);
  const [awayMenuOpen, setAwayMenuOpen] = useState(false);
  const [awayDialogOpen, setAwayDialogOpen] = useState(false);
  const [awayDialogMessage, setAwayDialogMessage] = useState("");
  const [awayPresets, setAwayPresets] = useState<string[]>(() => loadAwayPresets());
  const [extrasMenuOpen, setExtrasMenuOpen] = useState(false);
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(false);
  const [optionsSection, setOptionsSection] = useState<string>(OPTIONS_SECTIONS[0].id);
  const socketRef = useRef<WebSocket | null>(null);
  const connectionsMenuRef = useRef<HTMLDivElement | null>(null);
  const favoritesMenuRef = useRef<HTMLDivElement | null>(null);
  const awayMenuRef = useRef<HTMLDivElement | null>(null);
  const extrasMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  const activeTabRef = useRef<ActiveTab>("channel");
  const hasConnectedRef = useRef(false);
  const pokeIdRef = useRef(0);
  const inputMutedRef = useRef(false);
  const outputMutedRef = useRef(false);
  const micLevelRef = useRef(0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat, serverChat, pmThreads, activeTab]);

  useEffect(() => {
    const own = clients.find((c) => c.name === nickname) ?? null;
    inputMutedRef.current = own?.inputMuted ?? false;
    outputMutedRef.current = own?.outputMuted ?? false;
  }, [clients, nickname]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.threshold = vadThreshold;
  }, [vadThreshold]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.hangoverSeconds = vadHangover;
    localStorage.setItem(VAD_HANGOVER_KEY, String(vadHangover));
  }, [vadHangover]);

  useEffect(() => {
    audioPlayerRef.current?.setVolume(playbackVolume);
    localStorage.setItem(PLAYBACK_VOLUME_KEY, String(playbackVolume));
  }, [playbackVolume]);

  useEffect(() => {
    localStorage.setItem(NOISE_SUPPRESSION_KEY, noiseSuppressionEnabled ? "1" : "0");
  }, [noiseSuppressionEnabled]);

  useEffect(() => {
    localStorage.setItem(ECHO_CANCELLATION_KEY, echoCancellationEnabled ? "1" : "0");
  }, [echoCancellationEnabled]);

  useEffect(() => {
    if (inputDeviceId) localStorage.setItem(INPUT_DEVICE_KEY, inputDeviceId);
  }, [inputDeviceId]);

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

  const refreshInputDevices = async () => {
    try {
      const devices = await listAudioInputDevices();
      setInputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  useEffect(() => {
    const refreshBoth = () => {
      void refreshOutputDevices();
      void refreshInputDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshBoth);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshBoth);
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

  // Mic/output-device setup shouldn't require an active server connection (like
  // the real TS3 client, where you can test your devices before connecting) -
  // lazily create the audio context on first use instead of tying it to connect.
  const ensureAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      audioPlayerRef.current = new AudioPlayer(audioContext);
    }
    return audioContextRef.current;
  };

  const handleConnect = (overrides?: {
    host?: string;
    nickname?: string;
    serverPassword?: string;
    channelPassword?: string;
    defaultChannel?: string;
  }) => {
    const connectHost = overrides?.host ?? host;
    const connectNickname = overrides?.nickname ?? nickname;
    const connectServerPassword = overrides?.serverPassword ?? serverPassword;
    const connectChannelPassword = overrides?.channelPassword ?? channelPassword;
    const connectDefaultChannel = overrides?.defaultChannel ?? defaultChannel;

    hasConnectedRef.current = false;
    setConnecting(true);
    setConnectError(null);
    setConnectDialogOpen(false);

    ensureAudioContext();

    const socket = new WebSocket(GATEWAY_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "connect",
          host: connectHost,
          nickname: connectNickname,
          serverPassword: connectServerPassword || undefined,
          channelPassword: connectChannelPassword || undefined,
          defaultChannel: connectDefaultChannel || undefined,
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
          localStorage.setItem(LAST_HOST_KEY, connectHost);
          localStorage.setItem(LAST_NICKNAME_KEY, connectNickname);
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
          if (!outputMutedRef.current) audioPlayerRef.current?.playFrame(data.pcm);
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

  const connectToFavorite = (f: Favorite) => {
    setHost(f.host);
    setNickname(f.nickname);
    setServerPassword(f.serverPassword);
    setChannelPassword(f.defaultChannelPassword);
    setDefaultChannel(f.defaultChannel);
    handleConnect({
      host: f.host,
      nickname: f.nickname,
      serverPassword: f.serverPassword,
      channelPassword: f.defaultChannelPassword,
      defaultChannel: f.defaultChannel,
    });
  };

  const saveFavorites = (next: Favorite[]) => {
    setFavorites(next);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  };

  const openAddFavorite = () => {
    setFavoritesDialogMode({
      kind: "add",
      prefill: {
        host,
        nickname,
        serverPassword,
        defaultChannel,
        defaultChannelPassword: channelPassword,
      },
    });
    setFavoritesMenuOpen(false);
  };

  const openManageFavorites = () => {
    setFavoritesDialogMode({ kind: "manage" });
    setFavoritesMenuOpen(false);
  };

  const sendAway = (away: boolean, message: string) => {
    socketRef.current?.send(JSON.stringify({ type: "setAway", away, message }));
  };

  const handleSaveAwayTemplate = () => {
    const trimmed = awayDialogMessage.trim();
    if (!trimmed) return;
    setAwayPresets((prev) => {
      if (prev.includes(trimmed)) return prev;
      const next = [...prev, trimmed];
      localStorage.setItem(AWAY_PRESETS_KEY, JSON.stringify(next));
      return next;
    });
    setAwayDialogOpen(false);
  };

  const handleConfirmAway = () => {
    sendAway(true, awayDialogMessage);
    setAwayDialogOpen(false);
  };

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
    if (!favoritesMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!favoritesMenuRef.current?.contains(e.target as Node)) setFavoritesMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFavoritesMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [favoritesMenuOpen]);

  useEffect(() => {
    if (!awayMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!awayMenuRef.current?.contains(e.target as Node)) setAwayMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAwayMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [awayMenuOpen]);

  useEffect(() => {
    if (!extrasMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!extrasMenuRef.current?.contains(e.target as Node)) setExtrasMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExtrasMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [extrasMenuOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key.toLowerCase() === "s" && !connected && !connecting) {
        e.preventDefault();
        setConnectDialogOpen(true);
      } else if (e.key.toLowerCase() === "d" && connected) {
        e.preventDefault();
        handleDisconnect();
      } else if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        openAddFavorite();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connected, connecting, host, nickname, serverPassword, defaultChannel, channelPassword]);

  // Overrides let a device/DSP-setting change take effect immediately, without
  // waiting for the next render's (possibly still-stale) state closure.
  const startMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
  }) => {
    const audioContext = ensureAudioContext();
    try {
      const mic = new MicCapture(audioContext, {
        onFrame: (pcm) => {
          if (!inputMutedRef.current) socketRef.current?.send(JSON.stringify({ type: "sendAudio", pcm }));
        },
        onActivity: (active) => setSelfActive(active),
        onLevel: (rms) => {
          micLevelRef.current = rms;
        },
        threshold: vadThreshold,
        hangoverSeconds: vadHangover,
        deviceId: overrides?.deviceId ?? (inputDeviceId || undefined),
        echoCancellation: overrides?.echoCancellation ?? echoCancellationEnabled,
        noiseSuppression: overrides?.noiseSuppression ?? noiseSuppressionEnabled,
      });
      await mic.start();
      micCaptureRef.current = mic;
      setMicOn(true);
      refreshOutputDevices();
      refreshInputDevices();
    } catch (error) {
      appendLog({ text: `Microphone error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const restartMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
  }) => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    await startMic(overrides);
  };

  const handleToggleMic = async () => {
    if (!micOn) {
      await startMic();
      return;
    }
    socketRef.current?.send(JSON.stringify({ type: "setInputMuted", muted: !inputMutedRef.current }));
  };

  // Enable the mic automatically on page load (voice activation still gates
  // what's actually sent) instead of requiring an explicit click every time.
  const autoMicAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoMicAttemptedRef.current) return;
    autoMicAttemptedRef.current = true;
    void handleToggleMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputDeviceChange = (deviceId: string) => {
    setInputDeviceId(deviceId);
    if (micCaptureRef.current) void restartMic({ deviceId });
  };

  const handleToggleNoiseSuppression = () => {
    const next = !noiseSuppressionEnabled;
    setNoiseSuppressionEnabled(next);
    if (micCaptureRef.current) void restartMic({ noiseSuppression: next });
  };

  const handleToggleEchoCancellation = () => {
    const next = !echoCancellationEnabled;
    setEchoCancellationEnabled(next);
    if (micCaptureRef.current) void restartMic({ echoCancellation: next });
  };

  const handleToggleMicTest = () => {
    const next = !micTestOn;
    setMicTestOn(next);
    const inputNode = audioPlayerRef.current?.getInputNode();
    if (inputNode) micCaptureRef.current?.setMonitoring(next, inputNode);
  };

  const handleToggleOutputMuted = () => {
    socketRef.current?.send(JSON.stringify({ type: "setOutputMuted", muted: !outputMutedRef.current }));
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

  const handlePlayTestTone = () => {
    ensureAudioContext();
    audioPlayerRef.current?.playTestTone();
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
  const isAway = ownClient?.away ?? false;
  const inputMuted = ownClient?.inputMuted ?? false;
  const outputMuted = ownClient?.outputMuted ?? false;
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
        <div className="ts-menubar-dropdown" ref={favoritesMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setFavoritesMenuOpen((v) => !v)}
          >
            Favoriten
          </span>
          {favoritesMenuOpen && (
            <div className="ts-menu">
              <button className="ts-menu-item" onClick={openAddFavorite}>
                <span className="ts-menu-item-icon">⭐</span>
                <span className="ts-menu-item-label">Zu Favoriten hinzufügen</span>
                <span className="ts-menu-item-shortcut">Strg+B</span>
              </button>
              <button className="ts-menu-item" onClick={openManageFavorites}>
                <span className="ts-menu-item-icon">🗂️</span>
                <span className="ts-menu-item-label">Favoriten verwalten</span>
              </button>
              {favorites.length > 0 && <div className="ts-menu-separator" />}
              {favorites.map((f) => (
                <button
                  key={f.id}
                  className="ts-menu-item"
                  disabled={connected || connecting}
                  onClick={() => {
                    connectToFavorite(f);
                    setFavoritesMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">🔖</span>
                  <span className="ts-menu-item-label">{f.bookmarkName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {["Selbst", "Rechte"].map((item) => (
          <span key={item} className="ts-menubar-item">
            {item}
          </span>
        ))}
        <div className="ts-menubar-dropdown" ref={extrasMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setExtrasMenuOpen((v) => !v)}
          >
            Extras
          </span>
          {extrasMenuOpen && (
            <div className="ts-menu">
              {[
                { icon: "🪪", label: "Identitäten", shortcut: "Strg+I" },
                { icon: "📇", label: "Kontakte", shortcut: "Strg+Umschalt+O" },
                { icon: "🔗", label: "Gesammelte URLs", shortcut: "Strg+U" },
                { icon: "📁", label: "Dateitransfers", shortcut: "Strg+T" },
                { icon: "🧑‍🤝‍🧑", label: "Freund einladen" },
                { icon: "✉️", label: "Offline Nachrichten", shortcut: "Strg+O" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="ts-menu-item-shortcut">{item.shortcut}</span>}
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🗒️", label: "Whisperlisten", shortcut: "Strg+Umschalt+W" },
                { icon: "🕓", label: "Whisper Verlauf", shortcut: "Strg+Umschalt+H" },
                { icon: "📜", label: "Client Protokoll", shortcut: "Strg+L" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  <span className="ts-menu-item-shortcut">{item.shortcut}</span>
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🚫", label: "Bannliste", shortcut: "Strg+Umschalt+B" },
                { icon: "⚠️", label: "Beschwerdeliste", shortcut: "Strg+Umschalt+C" },
                { icon: "🔑", label: "ServerQuery Login" },
                { icon: "📄", label: "Server Protokoll", shortcut: "Strg+Umschalt+L" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="ts-menu-item-shortcut">{item.shortcut}</span>}
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🔴", label: "Aufnahme starten", shortcut: "Strg+Umschalt+R" },
                { icon: "🔴", label: "Start Multitrack Recording" },
                { icon: "⏹️", label: "Aufnahme beenden", shortcut: "Strg+Umschalt+T" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="ts-menu-item-shortcut">{item.shortcut}</span>}
                </button>
              ))}
              <div className="ts-menu-separator" />
              <button className="ts-menu-item" disabled>
                <span className="ts-menu-item-icon">🟠</span>
                <span className="ts-menu-item-label">Overwolf installieren</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setOptionsDialogOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⚙️</span>
                <span className="ts-menu-item-label">Optionen</span>
                <span className="ts-menu-item-shortcut">Alt+P</span>
              </button>
            </div>
          )}
        </div>
        <span className="ts-menubar-item">Hilfe</span>
      </div>

      <div className="ts-toolbar">
        <div className="ts-toolbar-icons">
          <div className="ts-toolbar-away" ref={awayMenuRef}>
            <button
              className={`ts-icon-button${isAway ? " ts-away-on" : ""}`}
              onClick={() => sendAway(!isAway, "")}
              disabled={!connected}
              title={isAway ? "Back online" : "Set away"}
            >
              💤
            </button>
            <button
              className="ts-icon-caret"
              onClick={() => setAwayMenuOpen((v) => !v)}
              disabled={!connected}
              title="Away options"
            >
              ▾
            </button>
            {awayMenuOpen && (
              <div className="ts-menu ts-menu-away">
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    sendAway(true, "");
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">💤</span>
                  <span className="ts-menu-item-label">Global abwesend setzen</span>
                </button>
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    setAwayDialogMessage("");
                    setAwayDialogOpen(true);
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">✎</span>
                  <span className="ts-menu-item-label">Abwesenheit-Status global setzen</span>
                </button>
                {awayPresets.length > 0 && <div className="ts-menu-separator" />}
                {awayPresets.map((preset) => (
                  <button
                    key={preset}
                    className="ts-menu-item"
                    onClick={() => {
                      sendAway(true, preset);
                      setAwayMenuOpen(false);
                    }}
                  >
                    <span className="ts-menu-item-label">{preset}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${micOn && !inputMuted ? " ts-mic-on" : ""}${micOn && inputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleMic}
            title={
              !micOn
                ? "Enable microphone"
                : inputMuted
                  ? "Unmute microphone"
                  : "Mute microphone"
            }
          >
            {micOn && !inputMuted ? "🎤" : "🔇"}
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
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${outputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleOutputMuted}
            disabled={!connected}
            title={outputMuted ? "Unmute sound (undeafen)" : "Mute sound (deafen)"}
          >
            {outputMuted ? "🔇" : "🔊"}
          </button>
          {hasNativeOutputPicker() ? (
            <button className="ts-icon-button" onClick={handlePickOutputDevice} title="Choose output device">
              🎧
            </button>
          ) : (
            <label className="ts-icon-select">
              🎧
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

      {favoritesDialogMode && (
        <FavoritesDialog
          favorites={favorites}
          prefillNew={favoritesDialogMode.kind === "add" ? favoritesDialogMode.prefill : undefined}
          onSave={saveFavorites}
          onClose={() => setFavoritesDialogMode(null)}
        />
      )}

      {awayDialogOpen && (
        <AwayDialog
          message={awayDialogMessage}
          presets={awayPresets}
          onMessageChange={setAwayDialogMessage}
          onOk={handleConfirmAway}
          onSaveTemplate={handleSaveAwayTemplate}
          onCancel={() => setAwayDialogOpen(false)}
        />
      )}

      {optionsDialogOpen && (
        <OptionsDialog
          section={optionsSection}
          onSectionChange={setOptionsSection}
          onClose={() => setOptionsDialogOpen(false)}
          audio={{
            outputDevices,
            outputDeviceId,
            onOutputDeviceChange: handleOutputDeviceChange,
            onRefreshOutputDevices: refreshOutputDevices,
            playbackVolume,
            onPlaybackVolumeChange: setPlaybackVolume,
            onPlayTestTone: handlePlayTestTone,
            inputDevices,
            inputDeviceId,
            onInputDeviceChange: handleInputDeviceChange,
            onRefreshInputDevices: refreshInputDevices,
            micOn,
            micLevelRef,
            micTestOn,
            onToggleMicTest: handleToggleMicTest,
            vadThreshold,
            onVadThresholdChange: setVadThreshold,
            vadHangover,
            onVadHangoverChange: setVadHangover,
            noiseSuppressionEnabled,
            onToggleNoiseSuppression: handleToggleNoiseSuppression,
            echoCancellationEnabled,
            onToggleEchoCancellation: handleToggleEchoCancellation,
          }}
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
