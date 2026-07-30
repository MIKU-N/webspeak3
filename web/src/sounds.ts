export type SoundEventId = "connect" | "disconnect" | "clientJoin" | "clientLeave" | "message" | "poke";

export const SOUND_EVENTS: SoundEventId[] = ["connect", "disconnect", "clientJoin", "clientLeave", "message", "poke"];

const ENABLED_KEY = "webspeak3:sounds-enabled";
const VOLUME_KEY = "webspeak3:sounds-volume";
const DB_NAME = "webspeak3-sounds";
const STORE_NAME = "custom";

interface StoredSound {
  blob: Blob;
  name: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomSound(event: SoundEventId, file: File): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ blob: file, name: file.name } satisfies StoredSound, event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadCustomSound(event: SoundEventId): Promise<StoredSound | undefined> {
  const db = await openDb();
  const result = await new Promise<StoredSound | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(event);
    req.onsuccess = () => resolve(req.result as StoredSound | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function clearCustomSound(event: SoundEventId): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function loadSoundsEnabled(): boolean {
  const raw = localStorage.getItem(ENABLED_KEY);
  return raw === null ? true : raw === "true";
}

export function saveSoundsEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled));
}

export function loadSoundsVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY);
  const n = raw ? Number(raw) : 0.5;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

export function saveSoundsVolume(volume: number): void {
  localStorage.setItem(VOLUME_KEY, String(volume));
}

type SinkableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Notification sounds get their own AudioContext, independent from the
 * voice AudioContext in voice.ts - that one is created on connect and torn
 * down on disconnect, but sounds must keep working (and be testable from
 * Options) regardless of connection state.
 */
class NotificationSoundPlayer {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private element: SinkableElement | null = null;
  private outputDeviceId = "";

  private ensure(): { context: AudioContext; destination: MediaStreamAudioDestinationNode } {
    if (!this.context) {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const element: SinkableElement = new Audio();
      element.srcObject = destination.stream;
      element.autoplay = true;
      this.context = context;
      this.destination = destination;
      this.element = element;
      if (this.outputDeviceId && typeof element.setSinkId === "function") {
        element.setSinkId(this.outputDeviceId).catch(() => {});
      }
    }
    return { context: this.context, destination: this.destination! };
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.element && typeof this.element.setSinkId === "function") {
      await this.element.setSinkId(deviceId).catch(() => {});
    }
  }

  async playBlob(blob: Blob, volume: number): Promise<void> {
    const { context, destination } = this.ensure();
    if (context.state === "suspended") await context.resume().catch(() => {});
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(destination);
    source.start();
  }

  playSynth(event: SoundEventId, volume: number): void {
    const { context, destination } = this.ensure();
    if (context.state === "suspended") context.resume().catch(() => {});
    const now = context.currentTime;
    for (const note of synthNotes(event)) {
      this.playNote(context, destination, now + note.delay, note.freq, note.duration, volume * note.gain);
    }
  }

  private playNote(
    context: AudioContext,
    destination: AudioNode,
    startTime: number,
    freq: number,
    duration: number,
    peakGain: number
  ): void {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain).connect(destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}

/** Soft, modern two/three-note chimes - a sine-wave, quick-attack/exponential-decay
 *  shape reads as gentle rather than the harsh square/saw beeps of classic UI sounds. */
function synthNotes(event: SoundEventId): { delay: number; freq: number; duration: number; gain: number }[] {
  switch (event) {
    case "connect":
      return [
        { delay: 0, freq: 523.25, duration: 0.16, gain: 0.5 },
        { delay: 0.09, freq: 783.99, duration: 0.22, gain: 0.5 },
      ];
    case "disconnect":
      return [
        { delay: 0, freq: 659.25, duration: 0.16, gain: 0.45 },
        { delay: 0.09, freq: 440.0, duration: 0.24, gain: 0.45 },
      ];
    case "clientJoin":
      return [{ delay: 0, freq: 880.0, duration: 0.14, gain: 0.4 }];
    case "clientLeave":
      return [{ delay: 0, freq: 587.33, duration: 0.16, gain: 0.4 }];
    case "message":
      return [
        { delay: 0, freq: 987.77, duration: 0.09, gain: 0.35 },
        { delay: 0.06, freq: 1318.51, duration: 0.12, gain: 0.3 },
      ];
    case "poke":
      return [
        { delay: 0, freq: 987.77, duration: 0.1, gain: 0.5 },
        { delay: 0.12, freq: 987.77, duration: 0.1, gain: 0.5 },
      ];
  }
}

const player = new NotificationSoundPlayer();

export function setSoundsOutputDevice(deviceId: string): void {
  void player.setOutputDevice(deviceId);
}

export async function playSound(event: SoundEventId): Promise<void> {
  if (!loadSoundsEnabled()) return;
  const volume = loadSoundsVolume();
  const custom = await loadCustomSound(event).catch(() => undefined);
  if (custom) {
    try {
      await player.playBlob(custom.blob, volume);
      return;
    } catch {
      // Stored file failed to decode (corrupted/unsupported) - fall back to the default chime.
    }
  }
  player.playSynth(event, volume);
}
