// STT — ElevenLabs Scribe (batch). W trybie --mock zwraca stały tekst.
import type { VoiceConfig } from "./config.js";
import type { Utterance } from "./vad.js";

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function transcribe(u: Utterance, config: VoiceConfig): Promise<string> {
  if (config.mock) return `(mock) powiedziałem coś przez ${(u.durationMs / 1000).toFixed(1)} sekundy`;
  const form = new FormData();
  form.append("model_id", config.sttModel);
  form.append("language_code", "pol");
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([new Uint8Array(pcmToWav(u.pcm, u.sampleRate))], { type: "audio/wav" }), "utt.wav");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": config.elevenKey },
    body: form,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
