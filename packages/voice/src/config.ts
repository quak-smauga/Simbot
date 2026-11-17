// Konfiguracja głosu — czytana raz przez chat server i przekazywana do VAD / STT / TTS.
export interface VadOptions {
  threshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  prerollMs: number;
}

export interface VoiceConfig {
  mock: boolean;
  elevenKey: string;
  voiceId: string;
  ttsModel: string;
  sttModel: string;
  micSampleRate: number; // przeglądarka → PCM s16le mono 16k
  ttsSampleRate: number; // ElevenLabs pcm_24000
  frameMs: number;
  vad: VadOptions;
  voiceSettings: { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean };
}

export function voiceConfigFromEnv(env: Record<string, string | undefined>, mock: boolean): VoiceConfig {
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return {
    mock: mock || !env.ELEVENLABS_API_KEY,
    elevenKey: env.ELEVENLABS_API_KEY ?? "",
    voiceId: env.ELEVEN_VOICE_ID || "WtA85syCrJwasGeHGH2p",
    ttsModel: env.ELEVEN_TTS_MODEL || "eleven_flash_v2_5",
    sttModel: env.ELEVEN_STT_MODEL || "scribe_v1",
    micSampleRate: 16000,
    ttsSampleRate: 24000,
    frameMs: 30,
    vad: {
      threshold: num("VAD_THRESHOLD", 0.012),
      silenceMs: num("VAD_SILENCE_MS", 800),
      minSpeechMs: num("VAD_MIN_SPEECH_MS", 250),
      maxUtteranceMs: num("VAD_MAX_UTTERANCE_MS", 20000),
      prerollMs: 300,
    },
    voiceSettings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
  };
}
