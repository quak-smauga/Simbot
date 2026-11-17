// TEXT — normalizacja + Levenshtein + dopasowanie fraz z tolerancją na dziurawe STT.
// Używane przez command router (komendy głosowe podczas computer taska) i frazy budzące.
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function containsPhrase(text: string, phrase: string, maxDistance = 3): boolean {
  const t = normalize(text).replace(/ /g, "");
  const p = normalize(phrase).replace(/ /g, "");
  if (!p) return false;
  if (t.includes(p)) return true;
  if (t.length < p.length - maxDistance) return false;
  const lo = Math.max(1, p.length - maxDistance);
  const hi = p.length + maxDistance;
  for (let start = 0; start < t.length; start++) for (let len = lo; len <= hi && start + len <= t.length; len++) if (levenshtein(t.slice(start, start + len), p) <= maxDistance) return true;
  return false;
}

/**
 * Command router: podczas computer taska zwykłe wypowiedzi NIE idą do LLM — tylko komendy sterujące.
 * Nie polegamy na gołym "stop"/"start" (łatwo o przypadkowe trafienie) — charakterystyczne frazy, próg zależny od długości.
 */
export type VoiceCommand = "pause" | "resume" | "cancel" | "take_control" | "give_control";

const COMMANDS: { cmd: VoiceCommand; phrases: string[] }[] = [
  { cmd: "cancel", phrases: ["anuluj zadanie", "anuluj komputer", "przerwij zadanie", "przerwij komputer", "zostaw to"] },
  { cmd: "pause", phrases: ["zatrzymaj komputer", "zatrzymaj zadanie", "pauza komputer", "poczekaj chwile", "wstrzymaj"] },
  { cmd: "resume", phrases: ["wznow komputer", "wznow zadanie", "kontynuuj", "jedz dalej", "zalogowalem sie", "zrobione lec dalej", "mozesz lecieć", "dalej komputer"] },
  { cmd: "take_control", phrases: ["przejmuje kontrole", "ja przejmuje", "daj mi kontrole"] },
  { cmd: "give_control", phrases: ["oddaje kontrole", "masz kontrole", "twoja kolej"] },
];

export function matchVoiceCommand(text: string): VoiceCommand | null {
  const n = normalize(text);
  if (!n) return null;
  for (const { cmd, phrases } of COMMANDS) for (const p of phrases) if (containsPhrase(n, p, Math.max(1, Math.floor(p.length / 6)))) return cmd;
  return null;
}
