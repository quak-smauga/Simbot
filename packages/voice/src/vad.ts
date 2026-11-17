// VAD (RMS). Wejście: PCM s16le mono 16k z przeglądarki (WS binary).
import type { VadOptions } from "./config.js";

export interface Utterance {
  pcm: Buffer;
  sampleRate: number;
  durationMs: number;
}

export function rms(frame: Buffer): number {
  const n = frame.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class EnergyVad {
  private utterCb: (u: Utterance) => void = () => {};
  private levelCb: (rms: number, speaking: boolean) => void = () => {};
  private muted = false;
  private readonly frameBytes: number;
  private readonly opts: VadOptions;
  private pending: Buffer = Buffer.alloc(0);
  private speaking = false;
  private speechFrames: Buffer[] = [];
  private preroll: Buffer[] = [];
  private aboveCount = 0;
  private silenceMsAcc = 0;
  private speechMsAcc = 0;

  constructor(private readonly sampleRate: number, opts: VadOptions, private readonly frameMs = 30) {
    this.opts = opts;
    this.frameBytes = Math.round((sampleRate * frameMs) / 1000) * 2;
  }
  onUtterance(cb: (u: Utterance) => void) {
    this.utterCb = cb;
  }
  onLevel(cb: (rms: number, speaking: boolean) => void) {
    this.levelCb = cb;
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.reset();
  }
  isMuted() {
    return this.muted;
  }
  reset() {
    this.speaking = false;
    this.speechFrames = [];
    this.aboveCount = 0;
    this.silenceMsAcc = 0;
    this.speechMsAcc = 0;
  }
  push(chunk: Buffer) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= this.frameBytes) {
      const frame = this.pending.subarray(0, this.frameBytes);
      this.pending = this.pending.subarray(this.frameBytes);
      this.onFrame(Buffer.from(frame));
    }
  }
  private onFrame(frame: Buffer) {
    const level = rms(frame);
    const above = level > this.opts.threshold;
    this.levelCb(level, this.speaking);
    if (this.muted) return;
    const { frameMs } = this;
    const { silenceMs, minSpeechMs, maxUtteranceMs, prerollMs } = this.opts;
    if (!this.speaking) {
      this.preroll.push(frame);
      const maxPre = Math.ceil(prerollMs / frameMs);
      if (this.preroll.length > maxPre) this.preroll.shift();
      this.aboveCount = above ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= 3) {
        this.speaking = true;
        this.speechFrames = [...this.preroll];
        this.preroll = [];
        this.silenceMsAcc = 0;
        this.speechMsAcc = this.aboveCount * frameMs;
      }
      return;
    }
    this.speechFrames.push(frame);
    this.speechMsAcc += frameMs;
    this.silenceMsAcc = above ? 0 : this.silenceMsAcc + frameMs;
    const tooLong = this.speechMsAcc >= maxUtteranceMs;
    if (this.silenceMsAcc >= silenceMs || tooLong) {
      const voicedMs = this.speechMsAcc - this.silenceMsAcc;
      const pcm = Buffer.concat(this.speechFrames);
      this.reset();
      if (voicedMs < minSpeechMs) return;
      this.utterCb({ pcm, sampleRate: this.sampleRate, durationMs: voicedMs });
    }
  }
}
