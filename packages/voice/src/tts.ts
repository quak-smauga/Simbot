// TTS — ElevenLabs stream-input (WS). Zamiast soxa: audio idzie na EventBus
// jako voice.chunk (PCM 24 kHz) → ws → przeglądarka gra i liczy RMS do ust.
// Jedna kwestia (sayId) = jedno połączenie WS. Tryb --mock: syntetyczny ton zamiast ElevenLabs.
import WebSocket from "ws";
import type { VoiceConfig } from "./config.js";
import type { VoiceBus } from "./pipeline.js";
type VoiceSettings = VoiceConfig["voiceSettings"];

export interface VoiceLine {
  push(text: string): void;
  /** Koniec tekstu; resolves gdy cały dźwięk został wysłany do klienta (nie: odegrany). */
  end(): Promise<void>;
  abort(): void;
  readonly sayId: string;
}

const SENTENCE_END = /[.!?…]+["»)]?\s/g;
const CLAUSE_END = /[,;:—–-]\s/g;
const LONG_CHUNK = 90;

/** Do którego indeksu tekst da się wysłać do syntezy (0 = czekaj). Zdanie → fraza → ostatnia spacja. */
export function findChunkEnd(buf: string): number {
  let last = 0;
  for (const m of buf.matchAll(SENTENCE_END)) last = (m.index ?? 0) + m[0].length;
  if (last > 0) return last;
  if (buf.length < LONG_CHUNK) return 0;
  for (const m of buf.matchAll(CLAUSE_END)) last = (m.index ?? 0) + m[0].length;
  if (last > 0) return last;
  if (buf.length < LONG_CHUNK * 2) return 0;
  const sp = buf.lastIndexOf(" ");
  return sp > 0 ? sp + 1 : 0;
}

export class ElevenLine implements VoiceLine {
  private ws: WebSocket;
  private ready: Promise<void>;
  private finished: Promise<void>;
  private resolveFinished!: () => void;
  private closedByUs = false;
  private pendingText: string[] = [];
  private isOpen = false;
  private textBuf = "";
  private seq = 0;
  private config: VoiceConfig;

  constructor(
    readonly sayId: string,
    voiceId: string,
    settings: VoiceSettings,
    private bus: VoiceBus,
    private label: string,
    cfg: VoiceConfig,
  ) {
    const config = cfg;
    this.config = cfg;
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${encodeURIComponent(config.ttsModel)}&output_format=pcm_${config.ttsSampleRate}&language_code=pl` +
      `&auto_mode=true&inactivity_timeout=60`;
    this.ws = new WebSocket(url, { headers: { "xi-api-key": config.elevenKey } });
    this.finished = new Promise((r) => (this.resolveFinished = r));
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        this.isOpen = true;
        this.ws.send(JSON.stringify({ text: " ", voice_settings: settings }));
        for (const t of this.pendingText) this.ws.send(JSON.stringify({ text: t }));
        this.pendingText = [];
        resolve();
      });
      this.ws.once("error", (e) => {
        bus.emit("log", { level: "error", message: `[tts ${label}] ${e.message}` });
        reject(e);
      });
    });
    this.ws.on("message", (data) => {
      let msg: { audio?: string | null; isFinal?: boolean; error?: string; message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error || msg.message) bus.emit("log", { level: "warn", message: `[tts ${label}] ${msg.error ?? msg.message}` });
      if (msg.audio) bus.emit("voice.chunk", { sayId, seq: this.seq++, pcm: Buffer.from(msg.audio, "base64"), sampleRate: config.ttsSampleRate });
      if (msg.isFinal) this.finishAudio();
    });
    this.ws.on("close", () => this.finishAudio());
    this.ws.on("error", () => this.finishAudio());
  }
  push(text: string) {
    if (!text) return;
    this.textBuf += text;
    for (;;) {
      const cut = findChunkEnd(this.textBuf);
      if (cut <= 0) break;
      this.sendText(this.textBuf.slice(0, cut));
      this.textBuf = this.textBuf.slice(cut);
    }
  }
  private sendText(text: string) {
    if (!text.trim()) return;
    const chunk = text.endsWith(" ") ? text : text + " ";
    if (this.isOpen) this.ws.send(JSON.stringify({ text: chunk }));
    else this.pendingText.push(chunk);
  }
  async end(): Promise<void> {
    this.sendText(this.textBuf);
    this.textBuf = "";
    await this.ready.catch(() => {});
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ text: "" }));
    await this.finished;
    this.bus.emit("voice.end", { sayId: this.sayId });
  }
  abort() {
    this.closedByUs = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.resolveFinished();
  }
  private finishAudio() {
    this.resolveFinished();
    if (!this.closedByUs && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/** --mock: "mówi" tonem o długości ~ liczba znaków / 14 s, z modulacją, żeby usta się ruszały. */
export class MockLine implements VoiceLine {
  private text = "";
  private seq = 0;
  constructor(readonly sayId: string, private bus: VoiceBus, private config: VoiceConfig) {}
  push(text: string) {
    this.text += text;
  }
  async end(): Promise<void> {
    const sr = this.config.ttsSampleRate;
    const secs = Math.max(0.8, Math.min(12, this.text.length / 14));
    const total = Math.floor(secs * sr);
    const chunk = Math.floor(sr * 0.1);
    for (let off = 0; off < total; off += chunk) {
      const n = Math.min(chunk, total - off);
      const buf = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const t = (off + i) / sr;
        const env = 0.5 + 0.5 * Math.sin(t * 11) * Math.sin(t * 3.1); // "sylaby"
        const v = Math.sin(t * 2 * Math.PI * 180) * 0.25 * env;
        buf.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      this.bus.emit("voice.chunk", { sayId: this.sayId, seq: this.seq++, pcm: buf, sampleRate: sr });
      await new Promise((r) => setTimeout(r, 60));
    }
    this.bus.emit("voice.end", { sayId: this.sayId });
  }
  abort() {}
}
