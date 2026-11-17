// VOICE PIPELINE — słucha say.start/say.text/say.end i zamienia je na voice.chunk/voice.end.
// Kwestia zaczyna się syntezować, zanim agent skończy pisać; jak agent poszedł do narzędzia, głos i narzędzie lecą równolegle.
import type { EventBus } from "@qwe/core";
import type { VoiceConfig } from "./config.js";
import { SpeechFilter } from "./speakable.js";
import { ElevenLine, MockLine, type VoiceLine } from "./tts.js";

/** Minimalna mapa eventów, której potrzebuje głos — chat ma szerszą, zgodną nadzbiorowo. */
export interface VoiceEvents {
  /** `voice` = ElevenLabs voiceId sima (puste = domyślny), `bot` = kto mówi (chat/UI). */
  "say.start": { sayId: string; voice?: string; bot?: string };
  "say.text": { sayId: string; delta: string; bot?: string };
  "say.end": { sayId: string; text: string; bot?: string };
  "voice.chunk": { sayId: string; seq: number; pcm: Buffer; sampleRate: number };
  "voice.end": { sayId: string };
  "voice.played": { sayId: string };
  "voice.abort": { sayId?: string };
  log: { level: "info" | "warn" | "error"; message: string };
}
/** Strukturalnie: każdy EventBus, którego mapa zawiera VoiceEvents (chat ma nadzbiór). */
export interface VoiceBus {
  on<K extends keyof VoiceEvents>(name: K, fn: (p: VoiceEvents[K]) => void): () => void;
  emit<K extends keyof VoiceEvents>(name: K, payload: VoiceEvents[K]): void;
}
export const asVoiceBus = <M extends VoiceEvents>(bus: EventBus<M>): VoiceBus => bus as unknown as VoiceBus;

export class VoicePipeline {
  private lines = new Map<string, VoiceLine>();
  /** Kwestie, których audio jeszcze nie zostało odegrane u klienta. */
  private pendingPlay = new Set<string>();
  private playedWaiters: (() => void)[] = [];
  /** Markdown z czatu → czysty tekst do mowy (per wypowiedź). */
  private filters = new Map<string, SpeechFilter>();
  enabled = true;

  constructor(private bus: VoiceBus, private config: VoiceConfig) {
    bus.on("say.start", ({ sayId, voice }) => {
      if (!this.enabled) return; // tryb tekstowy: nie syntezujemy
      const line: VoiceLine = config.mock ? new MockLine(sayId, bus, config) : new ElevenLine(sayId, voice || config.voiceId, config.voiceSettings, bus, "qwe", config);
      this.lines.set(sayId, line);
      this.filters.set(sayId, new SpeechFilter());
      this.pendingPlay.add(sayId);
    });
    bus.on("say.text", ({ sayId, delta }) => {
      const line = this.lines.get(sayId);
      const f = this.filters.get(sayId);
      if (line && f) line.push(f.push(delta));
    });
    bus.on("say.end", ({ sayId }) => {
      const line = this.lines.get(sayId);
      if (!line) return;
      const f = this.filters.get(sayId);
      if (f) line.push(f.flush());
      this.filters.delete(sayId);
      line
        .end()
        .catch((e) => bus.emit("log", { level: "error", message: `[voice] ${(e as Error).message}` }))
        .finally(() => this.lines.delete(sayId));
    });
    bus.on("voice.played", ({ sayId }) => {
      this.pendingPlay.delete(sayId);
      if (!this.pendingPlay.size) this.flushWaiters();
    });
    bus.on("voice.abort", () => {
      for (const l of this.lines.values()) l.abort();
      this.lines.clear();
      this.filters.clear();
      this.pendingPlay.clear();
      this.flushWaiters();
    });
  }

  get speaking() {
    return this.pendingPlay.size > 0;
  }

  /** Czekaj aż klient odegra wszystko (z bezpiecznikiem czasowym — jakby karta zasnęła). */
  waitPlayed(timeoutMs = 60000): Promise<void> {
    if (!this.pendingPlay.size) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.bus.emit("log", { level: "warn", message: "[voice] timeout czekania na odegranie — lecę dalej" });
        this.pendingPlay.clear();
        resolve();
      }, timeoutMs);
      this.playedWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  private flushWaiters() {
    const w = this.playedWaiters;
    this.playedWaiters = [];
    w.forEach((f) => f());
  }
}
