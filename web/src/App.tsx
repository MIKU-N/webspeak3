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
import { LanguageProvider, useLanguage, useT, type LangPref } from "./i18n";
import { DEMO_HOST, DEMO_MODE, DemoSocket } from "./demoMode";
import {
  SOUND_EVENTS,
  clearCustomSound,
  loadCustomSound,
  loadEventSoundEnabled,
  loadSoundsEnabled,
  loadSoundsVolume,
  playSound,
  saveCustomSound,
  saveEventSoundEnabled,
  saveSoundsEnabled,
  saveSoundsVolume,
  setSoundsOutputDevice,
  type SoundEventId,
} from "./sounds";

// In dev, the gateway runs standalone on its own port. In production it's
// served from the same origin/port as the web app (single container behind a
// reverse proxy), so derive the WebSocket URL from the current location.
const GATEWAY_URL = import.meta.env.DEV
  ? "ws://localhost:8080"
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

// One-time migration from the pre-rename "ts-web-client:*" localStorage
// namespace so existing users don't lose their favorites/preferences.
(function migrateLegacyStorageKeys() {
  const oldPrefix = "ts-web-client:";
  const newPrefix = "webspeak3:";
  for (const oldKey of Object.keys(localStorage).filter((k) => k.startsWith(oldPrefix))) {
    const newKey = newPrefix + oldKey.slice(oldPrefix.length);
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
    }
    localStorage.removeItem(oldKey);
  }
})();

const LAST_HOST_KEY = "webspeak3:last-host";
const LAST_NICKNAME_KEY = "webspeak3:last-nickname";
const FAVORITES_KEY = "webspeak3:favorites";
const INPUT_DEVICE_KEY = "webspeak3:input-device";
const PLAYBACK_VOLUME_KEY = "webspeak3:playback-volume";
const NOISE_SUPPRESSION_KEY = "webspeak3:noise-suppression";
const ECHO_CANCELLATION_KEY = "webspeak3:echo-cancellation";
const VAD_HANGOVER_KEY = "webspeak3:vad-hangover";

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

const AWAY_PRESETS_KEY = "webspeak3:away-presets";
const DISCONNECT_MESSAGE_KEY = "webspeak3:disconnect-message";

interface MessagePreset {
  name: string;
  message: string;
}

function loadAwayPresets(): MessagePreset[] {
  try {
    const raw = localStorage.getItem(AWAY_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Older versions stored presets as plain strings (name == message) - migrate on read.
    return parsed.map((p) => (typeof p === "string" ? { name: p, message: p } : (p as MessagePreset)));
  } catch {
    return [];
  }
}

function saveAwayPresets(presets: MessagePreset[]): void {
  localStorage.setItem(AWAY_PRESETS_KEY, JSON.stringify(presets));
}

function loadDisconnectMessage(): string {
  return localStorage.getItem(DISCONNECT_MESSAGE_KEY) ?? "";
}

function saveDisconnectMessage(message: string): void {
  localStorage.setItem(DISCONNECT_MESSAGE_KEY, message);
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
  const t = useT();
  return (
    <span className="ts-status-icons">
      {client.isChannelCommander && <span title={t("tree.channelCommander")}>⭐</span>}
      {client.away && <span title={t("tree.away")}>💤</span>}
      {(client.inputMuted || !client.inputHardwareEnabled) && <span title={t("tree.micMuted")}>🔇</span>}
      {client.outputMuted && <span title={t("tree.soundMuted")}>🔕</span>}
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
  const t = useT();
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
            title={t("tree.clickToSelect")}
          >
            <ChannelIcon />
            <span>{channel.name}</span>
            {channel.hasPassword && <span title={t("tree.passwordProtected")}>🔒</span>}
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
                    title={c.id === ownClientId ? undefined : `${t("tree.privateChatWith")} ${c.name}`}
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
                        title={`${t("tree.poke")} ${c.name}`}
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
  const t = useT();
  if (!selected || selected.type === "server") {
    return (
      <div className="ts-info-panel">
        <div className="ts-info-title">
          <ServerIcon />
          <span>{serverName || host}</span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.address")}</span> <span>{host}</span>
        </div>
        {serverVersion && (
          <div className="ts-info-row">
            <span>{t("info.version")}</span> <span>{serverVersion}</span>
          </div>
        )}
        {serverLicense && (
          <div className="ts-info-row">
            <span>{t("info.license")}</span> <span>{serverLicense}</span>
          </div>
        )}
        <div className="ts-info-row">
          <span>{t("info.currentClients")}</span> <span>{totalClientCount} / {serverMaxClients || "∞"}</span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.currentChannels")}</span> <span>{channels.length}</span>
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
          <span>{t("info.topic")}</span> <span>{channel.topic}</span>
        </div>
      )}
      <div className="ts-info-row">
        <span>{t("info.audioCodec")}</span> <span>{channel.codec}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.passwordProtected")}</span> <span>{channel.hasPassword ? t("info.yes") : t("info.no")}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.clients")}</span> <span>{clientCount} / {channel.maxClients ?? "∞"}</span>
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
  const t = useT();
  return (
    <div className="ts-dialog-backdrop" onClick={onCancel}>
      <div className="ts-dialog ts-connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("connect.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("connect.serverAddress")}
              <input autoFocus value={host} onChange={(e) => onHostChange(e.target.value)} />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverPassword")}
              <input
                type="password"
                value={serverPassword}
                onChange={(e) => onServerPasswordChange(e.target.value)}
              />
            </label>
          </div>
          <label className="ts-dialog-field">
            {t("connect.nickname")}
            <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} />
          </label>

          {expanded && (
            <div className="ts-dialog-grid">
              <label className="ts-dialog-field">
                {t("connect.phoneticNickname")}
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                {t("connect.identity")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.defaultChannel")}
                <input value={defaultChannel} onChange={(e) => onDefaultChannelChange(e.target.value)} />
              </label>
              <label className="ts-dialog-field">
                {t("connect.recordingProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.channelPassword")}
                <input
                  type="password"
                  value={channelPassword}
                  onChange={(e) => onChannelPasswordChange(e.target.value)}
                />
              </label>
              <label className="ts-dialog-field">
                {t("connect.playbackProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.onetimeGrant")}
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                {t("connect.hotkeyProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-checkbox">
                <input type="checkbox" disabled title="Not supported yet" />
                {t("connect.sendMyTeamSpeakId")}
              </label>
              <label className="ts-dialog-field">
                {t("connect.soundPack")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onToggleExpanded}>{expanded ? t("connect.less") : t("connect.more")}</button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onConnect} disabled={connecting || !host || !nickname}>
              {connecting ? t("connect.connecting") : t("connect.connect")}
            </button>
            <button disabled title="Not supported in the web client">
              {t("connect.newTab")}
            </button>
            <button onClick={onCancel}>{t("connect.cancel")}</button>
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
  const t = useT();
  const pendingNewRef = useRef<Favorite | null>(
    prefillNew
      ? {
          id: crypto.randomUUID(),
          bookmarkName: prefillNew.host || t("favorites.newFavoriteName"),
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
      bookmarkName: t("favorites.newFavoriteName"),
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
          <span>{t("favorites.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-favorites-body">
          <div className="ts-favorites-list-col">
            <div className="ts-favorites-list-group-title">{t("favorites.synced")}</div>
            <div className="ts-favorites-list-empty">{t("favorites.notLoggedIn")}</div>
            <div className="ts-favorites-list-group-title">{t("favorites.local")}</div>
            <ul className="ts-favorites-list">
              {draft.map((f) => (
                <li
                  key={f.id}
                  className={`ts-favorites-list-item${f.id === selectedId ? " ts-favorites-list-item-selected" : ""}`}
                  onClick={() => setSelectedId(f.id)}
                >
                  {f.bookmarkName || t("favorites.unnamed")}
                </li>
              ))}
            </ul>
          </div>

          <div className="ts-favorites-fields-col">
            <label className="ts-dialog-field">
              {t("favorites.bookmarkName")}
              <input
                disabled={!selected}
                value={selected?.bookmarkName ?? ""}
                onChange={(e) => updateSelected({ bookmarkName: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.nickname")}
              <input
                disabled={!selected}
                value={selected?.nickname ?? ""}
                onChange={(e) => updateSelected({ nickname: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.phoneticNickname")}
              <input disabled title="Not supported yet" />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverAddress")}
              <input
                disabled={!selected}
                value={selected?.host ?? ""}
                onChange={(e) => updateSelected({ host: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverPassword")}
              <input
                type="password"
                disabled={!selected}
                value={selected?.serverPassword ?? ""}
                onChange={(e) => updateSelected({ serverPassword: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.defaultChannel")}
              <input
                disabled={!selected}
                value={selected?.defaultChannel ?? ""}
                onChange={(e) => updateSelected({ defaultChannel: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.channelPassword")}
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
              {t("connect.identity")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.recordingProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.playbackProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.hotkeyProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.soundPack")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled defaultChecked title="Not supported yet" />
              {t("favorites.showServerQueryClients")}
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title="Not supported yet" />
              {t("favorites.connectOnStartup")}
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title="Not supported yet" />
              {t("favorites.enableMyTeamSpeak")}
            </label>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleNewFavorite}>{t("favorites.new")}</button>
            <button disabled title="Not supported in the web client">
              {t("favorites.newFolder")}
            </button>
            <button onClick={handleRemove} disabled={!selected}>
              {t("favorites.remove")}
            </button>
          </div>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              {t("favorites.ok")}
            </button>
            <button onClick={onClose}>{t("favorites.cancel")}</button>
            <button onClick={() => onSave(draft)}>{t("favorites.apply")}</button>
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
  presets: MessagePreset[];
  onMessageChange: (v: string) => void;
  onOk: () => void;
  onSaveTemplate: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="ts-dialog-backdrop" onClick={onCancel}>
      <div className="ts-dialog ts-away-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("away.dialog.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <span className="ts-dialog-away-label">{t("away.dialog.message")}</span>
            <label className="ts-dialog-field">
              {t("away.dialog.template")}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onMessageChange(e.target.value);
                }}
              >
                <option value="">{t("away.dialog.none")}</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.message}>
                    {p.name}
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
            <button onClick={onOk}>{t("away.dialog.ok")}</button>
            <button onClick={onSaveTemplate} disabled={!message.trim()}>
              {t("away.dialog.save")}
            </button>
            <button onClick={onCancel}>{t("away.dialog.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const OPTIONS_SECTIONS = [
  { id: "anwendung", icon: "🎧" },
  { id: "wiedergabe", icon: "🔊" },
  { id: "aufnahme", icon: "🎙️" },
  { id: "sounds", icon: "🔔" },
  { id: "design", icon: "🖌️" },
  { id: "erweiterungen", icon: "🧩" },
  { id: "hotkeys", icon: "⌨️" },
  { id: "whispern", icon: "🤫" },
  { id: "downloads", icon: "⬇️" },
  { id: "chat", icon: "💬" },
  { id: "sicherheit", icon: "🛡️" },
  { id: "nachrichten", icon: "🔤" },
  { id: "meldungen", icon: "ℹ️" },
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
  const t = useT();
  const volumeDb = Math.round(20 * Math.log10(audio.playbackVolume || 0.001) * 10) / 10;
  return (
    <>
      <h3>{t("playback.title")}</h3>
      <p className="ts-options-subtitle">{t("playback.subtitle")}</p>
      <div className="ts-options-field-row">
        <label>{t("playback.profile")}</label>
      </div>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("playback.device")}
            <select
              value={audio.outputDeviceId}
              onFocus={audio.onRefreshOutputDevices}
              onChange={(e) => audio.onOutputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <div className="ts-options-slider-row">
            <span>{t("playback.quiet")}</span>
            <span className="ts-options-slider-label">{t("playback.voiceVolume")}</span>
            <span>{t("playback.loud")}</span>
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
          <button onClick={audio.onPlayTestTone}>{t("playback.playTestTone")}</button>
          <fieldset className="ts-options-fieldset">
            <legend>{t("playback.options")}</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              {t("playback.autoVolume")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              {t("playback.ownMicClicks")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" disabled readOnly />
              {t("playback.otherMicClicks")}
            </label>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AufnahmePanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  return (
    <>
      <h3>{t("recording.title")}</h3>
      <p className="ts-options-subtitle">{t("recording.subtitle")}</p>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("recording.device")}
            <select
              value={audio.inputDeviceId}
              onFocus={audio.onRefreshInputDevices}
              onChange={(e) => audio.onInputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.activation")}</legend>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              {t("recording.pushToTalk")}
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              {t("recording.continuous")}
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" checked readOnly />
              {t("recording.voiceActivation")}
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
                {audio.micTestOn ? t("recording.testStop") : t("recording.testStart")}
              </button>
              <span className={`ts-options-test-dot${audio.micTestOn ? " ts-options-test-dot-on" : ""}`} />
              <label className="ts-options-field-inline">
                {t("recording.hangoverDelay")}
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={audio.vadHangover}
                  onChange={(e) => audio.onVadHangoverChange(Number(e.target.value))}
                />
                {t("recording.secondsUnit")}
              </label>
            </div>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.dsp")}</legend>
            <div className="ts-options-dsp-grid">
              <label className="ts-options-checkbox">
                <input type="checkbox" disabled readOnly />
                {t("recording.typingAttenuation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.echoCancellationEnabled}
                  onChange={audio.onToggleEchoCancellation}
                />
                {t("recording.echoCancellation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.noiseSuppressionEnabled}
                  onChange={audio.onToggleNoiseSuppression}
                />
                {t("recording.noiseSuppression")}
              </label>
            </div>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AnwendungPanel() {
  const t = useT();
  const { langPref, setLangPref } = useLanguage();
  return (
    <>
      <h3>{t("app.title")}</h3>
      <p className="ts-options-subtitle">{t("app.subtitle")}</p>
      <label className="ts-options-field">
        {t("app.language")}
        <select value={langPref} onChange={(e) => setLangPref(e.target.value as LangPref)}>
          <option value="auto">{t("app.language.auto")}</option>
          <option value="de">{t("app.language.de")}</option>
          <option value="en">{t("app.language.en")}</option>
        </select>
      </label>
    </>
  );
}

function SoundsPanel() {
  const t = useT();
  const [enabled, setEnabled] = useState(() => loadSoundsEnabled());
  const [volume, setVolume] = useState(() => loadSoundsVolume());
  const [customNames, setCustomNames] = useState<Partial<Record<SoundEventId, string>>>({});
  const [eventEnabled, setEventEnabled] = useState<Record<SoundEventId, boolean>>(() =>
    Object.fromEntries(SOUND_EVENTS.map((id) => [id, loadEventSoundEnabled(id)])) as Record<SoundEventId, boolean>
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<SoundEventId | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        SOUND_EVENTS.map(async (id) => [id, (await loadCustomSound(id))?.name] as const)
      );
      if (cancelled) return;
      const next: Partial<Record<SoundEventId, string>> = {};
      for (const [id, name] of entries) if (name) next[id] = name;
      setCustomNames(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    saveSoundsEnabled(next);
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    saveSoundsVolume(v);
  };

  const handleToggleEventEnabled = (event: SoundEventId) => {
    const next = !eventEnabled[event];
    setEventEnabled((prev) => ({ ...prev, [event]: next }));
    saveEventSoundEnabled(event, next);
  };

  const handleUploadClick = (event: SoundEventId) => {
    uploadTargetRef.current = event;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const event = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !event) return;
    await saveCustomSound(event, file);
    setCustomNames((prev) => ({ ...prev, [event]: file.name }));
  };

  const handleReset = async (event: SoundEventId) => {
    await clearCustomSound(event);
    setCustomNames((prev) => {
      const next = { ...prev };
      delete next[event];
      return next;
    });
  };

  return (
    <>
      <h3>{t("sounds.title")}</h3>
      <p className="ts-options-subtitle">{t("sounds.subtitle")}</p>
      <label className="ts-options-field-row">
        <input type="checkbox" checked={enabled} onChange={handleToggleEnabled} />
        {t("sounds.enable")}
      </label>
      <div className="ts-options-slider-with-value">
        <span className="ts-options-slider-label">{t("sounds.volume")}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
        />
        <span>{Math.round(volume * 100)}%</span>
      </div>
      <table className="ts-options-sounds-table">
        <tbody>
          {SOUND_EVENTS.map((eventId) => (
            <tr key={eventId}>
              <td>
                <input
                  type="checkbox"
                  checked={eventEnabled[eventId]}
                  onChange={() => handleToggleEventEnabled(eventId)}
                  title={t("sounds.eventEnable")}
                />
              </td>
              <td>{t(`sounds.event.${eventId}`)}</td>
              <td className="ts-options-sounds-source">
                {customNames[eventId] ? t("sounds.custom", { name: customNames[eventId]! }) : t("sounds.default")}
              </td>
              <td>
                <button onClick={() => void playSound(eventId)}>{t("sounds.test")}</button>
              </td>
              <td>
                <button onClick={() => handleUploadClick(eventId)}>{t("sounds.upload")}</button>
              </td>
              <td>
                {customNames[eventId] && <button onClick={() => void handleReset(eventId)}>{t("sounds.reset")}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => void handleFileSelected(e)}
      />
    </>
  );
}

function NachrichtenPanel() {
  const t = useT();
  const [presets, setPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [disconnectMessage, setDisconnectMessageState] = useState(() => loadDisconnectMessage());
  const [newName, setNewName] = useState("");
  const [newMessage, setNewMessage] = useState("");

  const handleDisconnectMessageChange = (v: string) => {
    setDisconnectMessageState(v);
    saveDisconnectMessage(v);
  };

  const handleAdd = () => {
    const name = newName.trim();
    const message = newMessage.trim();
    if (!name || !message) return;
    const next = [...presets, { name, message }];
    setPresets(next);
    saveAwayPresets(next);
    setNewName("");
    setNewMessage("");
  };

  const handleDelete = (index: number) => {
    const next = presets.filter((_, i) => i !== index);
    setPresets(next);
    saveAwayPresets(next);
  };

  return (
    <>
      <h3>{t("nachrichten.title")}</h3>
      <p className="ts-options-subtitle">{t("nachrichten.subtitle")}</p>
      <label className="ts-dialog-field">
        {t("nachrichten.disconnectMessage")}
        <input
          value={disconnectMessage}
          onChange={(e) => handleDisconnectMessageChange(e.target.value)}
          placeholder={t("nachrichten.disconnectMessagePlaceholder")}
        />
      </label>
      <h4>{t("nachrichten.presetsTitle")}</h4>
      <table className="ts-options-sounds-table">
        <thead>
          <tr>
            <th>{t("nachrichten.type")}</th>
            <th>{t("nachrichten.templateName")}</th>
            <th>{t("nachrichten.message")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {presets.map((preset, index) => (
            <tr key={`${preset.name}-${index}`}>
              <td>{t("nachrichten.type.away")}</td>
              <td>{preset.name}</td>
              <td>{preset.message}</td>
              <td>
                <button onClick={() => handleDelete(index)}>{t("nachrichten.delete")}</button>
              </td>
            </tr>
          ))}
          <tr>
            <td>{t("nachrichten.type.away")}</td>
            <td>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("nachrichten.templateName")}
              />
            </td>
            <td>
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={t("nachrichten.message")}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </td>
            <td>
              <button onClick={handleAdd} disabled={!newName.trim() || !newMessage.trim()}>
                {t("nachrichten.add")}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
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
  const t = useT();
  const active = OPTIONS_SECTIONS.find((s) => s.id === section) ?? OPTIONS_SECTIONS[0];
  return (
    <div className="ts-dialog-backdrop" onClick={onClose}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("options.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
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
                <span>{t(`options.section.${s.id}`)}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {active.id === "anwendung" ? (
              <AnwendungPanel />
            ) : active.id === "wiedergabe" ? (
              <WiedergabePanel audio={audio} />
            ) : active.id === "aufnahme" ? (
              <AufnahmePanel audio={audio} />
            ) : active.id === "sounds" ? (
              <SoundsPanel />
            ) : active.id === "nachrichten" ? (
              <NachrichtenPanel />
            ) : (
              <>
                <h3>{t(`options.section.${active.id}`)}</h3>
                <p className="ts-options-placeholder">{t("options.notImplemented")}</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("options.ok")}</button>
            <button onClick={onClose}>{t("options.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const [host, setHost] = useState(() => localStorage.getItem(LAST_HOST_KEY) ?? (DEMO_MODE ? DEMO_HOST : "localhost"));
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(LAST_NICKNAME_KEY) ?? (DEMO_MODE ? "Guest" : "")
  );
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
  const [awayPresets, setAwayPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [extrasMenuOpen, setExtrasMenuOpen] = useState(false);
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(false);
  const [optionsSection, setOptionsSection] = useState<string>(OPTIONS_SECTIONS[0].id);
  const socketRef = useRef<WebSocket | DemoSocket | null>(null);
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
  // Set when a "disconnected" event is received, so the socket's onclose
  // handler (which fires shortly after, on its own close handshake) can tell
  // a clean disconnect apart from the socket dying before ever connecting.
  const cleanDisconnectRef = useRef(false);
  const previousClientsRef = useRef<ClientInfo[] | null>(null);
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

    // Switching servers while already connected (or mid-connect): tear down the
    // old socket first and detach its handlers so its async close doesn't later
    // clobber state that belongs to the new connection.
    const previousSocket = socketRef.current;
    if (previousSocket) {
      previousSocket.onopen = null;
      previousSocket.onmessage = null;
      previousSocket.onerror = null;
      previousSocket.onclose = null;
      if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
        previousSocket.close();
      }
      stopMic();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
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
    }

    hasConnectedRef.current = false;
    setConnecting(true);
    setConnectError(null);
    setConnectDialogOpen(false);

    ensureAudioContext();

    const socket = DEMO_MODE ? new DemoSocket() : new WebSocket(GATEWAY_URL);
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
          previousClientsRef.current = null;
          void playSound("connect");
          break;
        case "channels": {
          const newClients: ClientInfo[] = data.clients;
          const prevClients = previousClientsRef.current;
          if (prevClients) {
            const prevIds = new Set(prevClients.map((c) => c.id));
            const newIds = new Set(newClients.map((c) => c.id));
            const joined = newClients.some((c) => !prevIds.has(c.id) && c.name !== connectNickname);
            const left = prevClients.some((c) => !newIds.has(c.id) && c.name !== connectNickname);
            if (joined) void playSound("clientJoin");
            if (left) void playSound("clientLeave");
          }
          previousClientsRef.current = newClients;
          setChannels(data.channels);
          setClients(newClients);
          break;
        }
        case "chatMessage":
          setChat((prev) => [...prev, { from: data.from, message: data.message }]);
          if (data.from !== connectNickname) void playSound("message");
          break;
        case "serverMessage":
          setServerChat((prev) => [...prev, { from: data.from, message: data.message }]);
          if (data.from !== connectNickname) void playSound("message");
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
          if (!data.fromSelf) void playSound("message");
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
          void playSound("poke");
          break;
        }
        case "disconnected": {
          const wasConnected = hasConnectedRef.current;
          hasConnectedRef.current = false;
          cleanDisconnectRef.current = true;
          previousClientsRef.current = null;
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
          if (wasConnected) void playSound("disconnect");
          break;
        }
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
      if (!hasConnectedRef.current && !cleanDisconnectRef.current) {
        setConnecting(false);
        setConnectError((prev) => prev ?? "Connection closed before the server responded");
      }
      cleanDisconnectRef.current = false;
      setConnected(false);
      stopMic();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  };

  const handleDisconnect = () => {
    const socket = socketRef.current;
    if (!socket) return;
    const message = loadDisconnectMessage();
    if (message && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "disconnect", message }));
    }
    socket.close();
  };

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
      if (prev.some((p) => p.message === trimmed)) return prev;
      const next = [...prev, { name: trimmed, message: trimmed }];
      saveAwayPresets(next);
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
    setSoundsOutputDevice(deviceId);
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
  const t = useT();

  return (
    <div className={`ts-app ts-theme-${theme}`}>
      {DEMO_MODE && (
        <div className="ts-demo-banner">
          Demo mode — simulated data only, no real TeamSpeak server involved.{" "}
          <a href="https://github.com/Moepchi/webspeak3" target="_blank" rel="noreferrer">
            Get WebSpeak3
          </a>
        </div>
      )}
      <div className="ts-menubar">
        <div className="ts-menubar-dropdown" ref={connectionsMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setConnectionsMenuOpen((v) => !v)}
          >
            {t("menu.connections")}
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
                <span className="ts-menu-item-label">{t("menu.connections.connect")}</span>
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
                <span className="ts-menu-item-label">{t("menu.connections.disconnectCurrent")}</span>
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
                <span className="ts-menu-item-label">{t("menu.connections.disconnectAll")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={favoritesMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setFavoritesMenuOpen((v) => !v)}
          >
            {t("menu.favorites")}
          </span>
          {favoritesMenuOpen && (
            <div className="ts-menu">
              <button className="ts-menu-item" onClick={openAddFavorite}>
                <span className="ts-menu-item-icon">⭐</span>
                <span className="ts-menu-item-label">{t("menu.favorites.add")}</span>
                <span className="ts-menu-item-shortcut">Strg+B</span>
              </button>
              <button className="ts-menu-item" onClick={openManageFavorites}>
                <span className="ts-menu-item-icon">🗂️</span>
                <span className="ts-menu-item-label">{t("menu.favorites.manage")}</span>
              </button>
              {favorites.length > 0 && <div className="ts-menu-separator" />}
              {favorites.map((f) => (
                <button
                  key={f.id}
                  className="ts-menu-item"
                  disabled={connecting}
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
        {[t("menu.self"), t("menu.rights")].map((item) => (
          <span key={item} className="ts-menubar-item">
            {item}
          </span>
        ))}
        <div className="ts-menubar-dropdown" ref={extrasMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setExtrasMenuOpen((v) => !v)}
          >
            {t("menu.extras")}
          </span>
          {extrasMenuOpen && (
            <div className="ts-menu">
              {[
                { icon: "🪪", label: t("menu.extras.identities"), shortcut: "Strg+I" },
                { icon: "📇", label: t("menu.extras.contacts"), shortcut: "Strg+Umschalt+O" },
                { icon: "🔗", label: t("menu.extras.collectedUrls"), shortcut: "Strg+U" },
                { icon: "📁", label: t("menu.extras.fileTransfers"), shortcut: "Strg+T" },
                { icon: "🧑‍🤝‍🧑", label: t("menu.extras.inviteFriend") },
                { icon: "✉️", label: t("menu.extras.offlineMessages"), shortcut: "Strg+O" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="ts-menu-item-shortcut">{item.shortcut}</span>}
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🗒️", label: t("menu.extras.whisperLists"), shortcut: "Strg+Umschalt+W" },
                { icon: "🕓", label: t("menu.extras.whisperHistory"), shortcut: "Strg+Umschalt+H" },
                { icon: "📜", label: t("menu.extras.clientLog"), shortcut: "Strg+L" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  <span className="ts-menu-item-shortcut">{item.shortcut}</span>
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🚫", label: t("menu.extras.banList"), shortcut: "Strg+Umschalt+B" },
                { icon: "⚠️", label: t("menu.extras.complaintList"), shortcut: "Strg+Umschalt+C" },
                { icon: "🔑", label: t("menu.extras.serverQueryLogin") },
                { icon: "📄", label: t("menu.extras.serverLog"), shortcut: "Strg+Umschalt+L" },
              ].map((item) => (
                <button key={item.label} className="ts-menu-item" disabled>
                  <span className="ts-menu-item-icon">{item.icon}</span>
                  <span className="ts-menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="ts-menu-item-shortcut">{item.shortcut}</span>}
                </button>
              ))}
              <div className="ts-menu-separator" />
              {[
                { icon: "🔴", label: t("menu.extras.startRecording"), shortcut: "Strg+Umschalt+R" },
                { icon: "🔴", label: t("menu.extras.startMultitrackRecording") },
                { icon: "⏹️", label: t("menu.extras.stopRecording"), shortcut: "Strg+Umschalt+T" },
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
                <span className="ts-menu-item-label">{t("menu.extras.installOverwolf")}</span>
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
                <span className="ts-menu-item-label">{t("menu.extras.options")}</span>
                <span className="ts-menu-item-shortcut">Alt+P</span>
              </button>
            </div>
          )}
        </div>
        <span className="ts-menubar-item">{t("menu.help")}</span>
      </div>

      <div className="ts-toolbar">
        <div className="ts-toolbar-icons">
          <div className="ts-toolbar-away" ref={awayMenuRef}>
            <button
              className={`ts-icon-button${isAway ? " ts-away-on" : ""}`}
              onClick={() => sendAway(!isAway, "")}
              disabled={!connected}
              title={isAway ? t("toolbar.backOnline") : t("toolbar.setAway")}
            >
              💤
            </button>
            <button
              className="ts-icon-caret"
              onClick={() => {
                setAwayPresets(loadAwayPresets());
                setAwayMenuOpen((v) => !v);
              }}
              disabled={!connected}
              title={t("toolbar.awayOptions")}
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
                  <span className="ts-menu-item-label">{t("away.setGlobal")}</span>
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
                  <span className="ts-menu-item-label">{t("away.setGlobalStatus")}</span>
                </button>
                {awayPresets.length > 0 && <div className="ts-menu-separator" />}
                {awayPresets.map((preset) => (
                  <button
                    key={preset.name}
                    className="ts-menu-item"
                    onClick={() => {
                      sendAway(true, preset.message);
                      setAwayMenuOpen(false);
                    }}
                  >
                    <span className="ts-menu-item-label">{preset.name}</span>
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
                ? t("toolbar.micEnable")
                : inputMuted
                  ? t("toolbar.micUnmute")
                  : t("toolbar.micMute")
            }
          >
            {micOn && !inputMuted ? "🎤" : "🔇"}
          </button>
          <label className="ts-icon-slider" title={t("toolbar.vadSensitivity")}>
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
            title={outputMuted ? t("toolbar.unmuteSound") : t("toolbar.muteSound")}
          >
            {outputMuted ? "🔇" : "🔊"}
          </button>
          {hasNativeOutputPicker() ? (
            <button className="ts-icon-button" onClick={handlePickOutputDevice} title={t("toolbar.chooseOutputDevice")}>
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
                <option value="">{t("playback.systemDefault")}</option>
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
            onClick={() => setTheme((mode) => (mode === "dark" ? "light" : "dark"))}
            title={t("toolbar.toggleTheme")}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="ts-app-logo" />
          <span className="ts-app-title">WebSpeak3</span>
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
          <button onClick={() => setConnectError(null)} title={t("connectError.dismiss")}>
            ✕
          </button>
        </div>
      )}

      {pokeTarget && (
        <div className="ts-poke-compose-backdrop" onClick={() => setPokeTarget(null)}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👉 {t("poke.title")} <strong>{pokeTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={pokeMessage}
              onChange={(e) => setPokeMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendPoke();
                if (e.key === "Escape") setPokeTarget(null);
              }}
              placeholder={t("poke.optionalMessage")}
            />
            <button onClick={handleSendPoke}>{t("poke.send")}</button>
            <button onClick={() => setPokeTarget(null)}>{t("poke.cancel")}</button>
          </div>
        </div>
      )}

      {pokes.map((poke) => (
        <div key={poke.id} className="ts-poke-notice">
          <span>
            👉 <strong>{poke.from}</strong> {t("poke.pokedYou")}{poke.message ? `: ${poke.message}` : ""}
          </span>
          <button onClick={() => setPokes((prev) => prev.filter((p) => p.id !== poke.id))} title={t("poke.dismiss")}>
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
              <div className="ts-tree-empty">{t("tree.notConnected")}</div>
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
                        {entry.fromSelf ? t("chat.you") : pmThreads[activeTab].partnerName}:
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
              {t("chat.server")}
            </button>
            <button
              className={`ts-chat-tab${activeTab === "channel" ? " ts-chat-tab-active" : ""}`}
              onClick={() => setActiveTab("channel")}
            >
              {t("chat.channel")}
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
                  ? t("chat.notConnected")
                  : activeTab === "channel"
                    ? t("chat.messageChannel")
                    : activeTab === "server"
                      ? t("chat.messageServer")
                      : t("chat.messagePartner", { name: pmThreads[activeTab]?.partnerName ?? "" })
              }
            />
            <button onClick={handleSendChat} disabled={!connected}>
              {t("chat.send")}
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

function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}

export default App;
