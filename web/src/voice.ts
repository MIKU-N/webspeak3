// Encoding/decoding and Web Audio plumbing for the voice feature.
//
// The connector always speaks 48kHz PCM in 20ms frames: mono for the
// microphone -> server direction (which it Opus-encodes), stereo mixed
// for the server -> speakers direction (already decoded/mixed for us).

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms @ 48kHz

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** How long transmission continues after the level drops back below the threshold, so words aren't clipped. */
const VAD_HANGOVER_SECONDS = 0.4;

/**
 * Captures the microphone and emits base64-encoded mono 16-bit PCM frames.
 *
 * Uses voice activation (like TeamSpeak's own "Sprachaktivierung"): frames are
 * only sent while the input level is above `threshold`, plus a short hangover
 * so the tail of a word isn't cut off. `onActivity` reports transitions so the
 * UI can show a local "currently transmitting" indicator.
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silence: GainNode | null = null;
  private pending: number[] = [];
  private active = false;
  private activeUntil = 0;
  threshold: number;

  constructor(
    private context: AudioContext,
    private onFrame: (base64Pcm: string) => void,
    private onActivity?: (active: boolean) => void,
    threshold = 0.02
  ) {
    this.threshold = threshold;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices) {
      throw new Error("Microphone access requires HTTPS (or localhost) - the site is not a secure context.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
      const rms = Math.sqrt(sumSquares / input.length);

      const now = this.context.currentTime;
      if (rms >= this.threshold) this.activeUntil = now + VAD_HANGOVER_SECONDS;
      const shouldBeActive = now < this.activeUntil;
      if (shouldBeActive !== this.active) {
        this.active = shouldBeActive;
        this.onActivity?.(this.active);
        if (!this.active) this.pending = [];
      }

      if (!this.active) return;

      for (let i = 0; i < input.length; i++) this.pending.push(input[i]);
      while (this.pending.length >= FRAME_SAMPLES) {
        const frame = this.pending.splice(0, FRAME_SAMPLES);
        const int16 = new Int16Array(FRAME_SAMPLES);
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          const clamped = Math.max(-1, Math.min(1, frame[i]));
          int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        }
        this.onFrame(int16ToBase64(int16));
      }
    };
    // A ScriptProcessorNode only fires while connected to a destination; route
    // it through a muted gain node so we don't hear our own mic echoed back.
    this.silence = this.context.createGain();
    this.silence.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.silence);
    this.silence.connect(this.context.destination);
  }

  stop(): void {
    this.processor?.disconnect();
    this.silence?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.processor = null;
    this.silence = null;
    this.source = null;
    this.stream = null;
    this.pending = [];
    if (this.active) {
      this.active = false;
      this.onActivity?.(false);
    }
  }
}

/** Output ("audiooutput") devices available for playback, e.g. for a device picker. */
export async function listAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audiooutput");
}

type MediaDevicesWithPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

/** Whether the browser supports the native OS output-device picker (Chrome/Edge 105+). */
export function hasNativeOutputPicker(): boolean {
  if (!navigator.mediaDevices) return false;
  return typeof (navigator.mediaDevices as MediaDevicesWithPicker).selectAudioOutput === "function";
}

/**
 * Opens the browser's native OS device chooser for audio output. Unlike
 * `enumerateDevices()`, this lists every device the OS knows about (including
 * ones like a USB headset that plain enumeration can otherwise omit) and asks
 * the user to pick one, each call - no persistent listing to keep in sync.
 */
export async function pickAudioOutputDevice(): Promise<MediaDeviceInfo | null> {
  if (!navigator.mediaDevices) return null;
  const md = navigator.mediaDevices as MediaDevicesWithPicker;
  if (typeof md.selectAudioOutput !== "function") return null;
  return md.selectAudioOutput();
}

type SinkableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/**
 * Schedules incoming base64-encoded stereo 16-bit PCM frames for gap-free
 * playback, and supports switching output device across browsers.
 *
 * Playback is routed through a `MediaStreamAudioDestinationNode` into a
 * hidden `<audio>` element rather than straight to `context.destination`,
 * because device switching support is split across browsers:
 * `AudioContext.setSinkId` (Chrome 110+) only retargets the context itself,
 * while `HTMLMediaElement.setSinkId` (Chrome, and Firefox 130+) only works on
 * a media element. Routing through the element lets `setOutputDevice` use
 * whichever one the browser actually supports.
 */
export class AudioPlayer {
  private nextTime = 0;
  private destination: MediaStreamAudioDestinationNode;
  private element: SinkableElement;

  constructor(private context: AudioContext) {
    this.destination = context.createMediaStreamDestination();
    this.element = document.createElement("audio") as SinkableElement;
    this.element.autoplay = true;
    this.element.srcObject = this.destination.stream;
    this.element.style.display = "none";
    document.body.appendChild(this.element);
  }

  playFrame(base64Pcm: string): void {
    const int16 = base64ToInt16(base64Pcm);
    const frames = int16.length / 2;
    if (frames <= 0) return;

    const buffer = this.context.createBuffer(2, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = int16[i * 2] / 32768;
      right[i] = int16[i * 2 + 1] / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);

    const now = this.context.currentTime;
    if (this.nextTime < now + 0.02) {
      // First frame, or we fell behind - restart just ahead of now instead of
      // letting a backlog build up.
      this.nextTime = now + 0.02;
    }
    source.start(this.nextTime);
    this.nextTime += frames / SAMPLE_RATE;
  }

  reset(): void {
    this.nextTime = 0;
  }

  /** Routes playback to a specific device (empty string = system default). */
  async setOutputDevice(deviceId: string): Promise<void> {
    if (typeof this.element.setSinkId === "function") {
      await this.element.setSinkId(deviceId);
      return;
    }
    const ctx = this.context as SinkableContext;
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
    }
    // Neither API is available - stays on the system default output.
  }

  dispose(): void {
    this.element.pause();
    this.element.srcObject = null;
    this.element.remove();
    this.destination.stream.getTracks().forEach((t) => t.stop());
  }
}
