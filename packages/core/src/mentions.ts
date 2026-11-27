// MENTIONS — `@nazwa` i `@nazwa.akcja` w wiadomościach. Jedyny sposób adresowania w rozmowie z wieloma simami.
//   user:  "@ksiegowy.task wystaw fakturę, @audytor patrz na ręce"  → ksiegowy (task), potem audytor (ask)
//   bot:   "@kacper potwierdzasz?"                                  → powiadomienie dla usera
//   bot:   "@audytor sprawdź sumy"                                   → łańcuch: audytor odpowiada po księgowym
// Bez @ odpowiada prowadzący rozmowy (pierwszy członek) — „przyklejony”: zostaje nim sim, którego user zawołał ostatnio
// (chat server przestawia kolejność członków); sim wołający sima pożycza pałeczkę na jedną odpowiedź.
// @ w `kodzie`, bloku ```, cytacie „>” i w cudzysłowie to omawianie; sim woła sima tylko @ na początku zdania/linii, nie wołanie. Akcje to rejestr — `task` zmienia tryb odpowiedzi sima.
// @sim spoza rozmowy: od usera (adopt) → dołącza i odpowiada (chat server oddaje mu prowadzenie zamiast Simy);
// od sima → nie dołącza sam (trafia do `absent`).

export interface Mention {
  /** nazwa po @ (małe litery) */
  name: string;
  /** akcja po kropce (np. "task"); brak = zwykłe zwrócenie się */
  action: MentionAction;
  index: number;
  raw: string;
  /** na początku zdania albo linii („@ksiegowy, sprawdź…”) — tylko tak sim woła sima; „napisał @sima” to wzmianka */
  opens: boolean;
}

export type MentionAction = "ask" | "task";

export const MENTION_ACTIONS: Record<MentionAction, { label: string; hint: string; prompt: string }> = {
  ask: { label: "zapytaj", hint: "@sim …", prompt: "" },
  task: {
    label: "zleć zadanie",
    hint: "@sim.task …",
    prompt: "[tryb: ZADANIE — to zlecenie, nie pytanie. Wykonaj je narzędziami bez dopytywania (poza operacjami wrażliwymi, które i tak wymagają potwierdzenia), a na końcu krótko zaraportuj, co zrobione i co nie.]",
  },
};

const RE = /(^|[^\p{L}\p{N}_@])@([a-z0-9][a-z0-9-]*)(?:\.([a-z]+))?(:?)/giu;

/** Tekst w cudzysłowie w jednej linii: „…”, “…”, "…", «…» (do 160 znaków). */
const QUOTE_RE = /[„“"«][^„“”"«»\n]{0,160}[”“"»]/g;

/**
 * Fragmenty, w których @nazwa to omawianie, a nie wołanie: blok kodu ```…```, `kod w linii`, cytat (linia od „>”),
 * tekst w cudzysłowie („@sima → @ksiegowy”). Zamieniamy je na spacje tej samej długości — indeksy wzmianek zostają prawdziwe.
 */
export function maskQuoted(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?(```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^[ \t]*>.*$/gm, blank)
    .replace(QUOTE_RE, blank);
}

/** `@nazwa: tekst` to cytat (tak sim widzi cudze wypowiedzi), nie wołanie — pomijamy. Tak samo @ w kodzie i cytacie. */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const masked = maskQuoted(text);
  for (const m of masked.matchAll(RE)) {
    if (m[4]) continue;
    const action = (m[3] ?? "ask").toLowerCase();
    const index = (m.index ?? 0) + m[1].length;
    const before = masked.slice(Math.max(0, index - 80), index);
    const opens = /(^|[.!?…:;\n]|^\s*[-*•]|\n\s*[-*•]|\n\s*\d+[.)])[\s*_]*$/.test(before) || index === 0;
    out.push({ name: m[2].toLowerCase(), action: action in MENTION_ACTIONS ? (action as MentionAction) : "ask", index, raw: m[0].slice(m[1].length), opens });
  }
  return out;
}

export interface TargetOptions {
  /** simy w rozmowie (pierwszy = prowadzący) */
  members: string[];
  /** wszystkie znane simy (żeby odróżnić „nie ma w rozmowie” od „nie ma takiego sima”) */
  known: string[];
  /** slug usera (np. "kacper") */
  user: string;
  /** kto to napisał — sim nie odpowiada sam sobie */
  from?: string;
  /** znany sim spoza rozmowy dołącza (joined: true) zamiast trafić do absent — tak traktujemy @ od usera */
  adopt?: boolean;
}

export interface Targets {
  bots: { name: string; action: MentionAction; joined: boolean }[];
  userMentioned: boolean;
  unknown: string[];
  /** znane simy, których nie ma w tej rozmowie — wspomniane, ale nie odpowiadają */
  absent: string[];
  /** nikt nie został zawołany wprost — odpowiada prowadzący z urzędu */
  defaulted: boolean;
}

/** Kto ma odpowiedzieć na tę wiadomość. Bez @ → prowadzący (tylko gdy pisze user). */
export function resolveTargets(text: string, o: TargetOptions): Targets {
  const seen = new Set<string>();
  const bots: Targets["bots"] = [];
  const unknown: string[] = [];
  const absent: string[] = [];
  let userMentioned = false;
  for (const m of parseMentions(text)) {
    if (m.name === o.user) {
      userMentioned = true;
      continue;
    }
    if (m.name === o.from || seen.has(m.name)) continue;
    // sim woła sima tylko @nazwą otwierającą zdanie/linię; w środku zdania to wzmianka („jak pisał @sima…”)
    if (o.from && !m.opens) continue;
    if (!o.known.includes(m.name)) {
      unknown.push(m.name);
      continue;
    }
    seen.add(m.name);
    if (!o.members.includes(m.name)) {
      if (o.adopt && !o.from) bots.push({ name: m.name, action: m.action, joined: true });
      else absent.push(m.name);
      continue;
    }
    bots.push({ name: m.name, action: m.action, joined: false });
  }
  // nikt z rozmowy nie zawołany (także: same @ do simów spoza rozmowy) → odpowiada prowadzący; dotyczy tylko usera
  const defaulted = !bots.length && !o.from && !!o.members[0];
  if (defaulted) bots.push({ name: o.members[0], action: "ask", joined: false });
  return { bots, userMentioned, unknown, absent, defaulted };
}

/**
 * Głos nie ma @ — transkrypcja „Księgowy, policz…” / „hej Simo, …” woła sima, gdy jego nazwa jest pierwszym słowem
 * (po ewentualnym „hej/ej/halo”). Wołacz na -o (Sima → Simo) też. Zwraca nazwę sima albo null.
 */
export function voiceAddress(text: string, known: string[]): string | null {
  const words = (text || "").trim().split(/\s+/).slice(0, 2).map((w) => userSlug(w.replace(/[^\p{L}\p{N}-]/gu, "")));
  const first = ["hej", "ej", "halo", "siema", "czesc"].includes(words[0]) ? words[1] : words[0];
  if (!first || first === "ty") return null;
  return known.find((n) => n === first || (n.endsWith("a") && first === n.slice(0, -1) + "o")) ?? null;
}

/** Slug do @ z imienia usera: "Kacper Walczak" → "kacper". */
export function userSlug(name: string): string {
  const s = (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .trim()
    .split(/\s+/)[0]
    .replace(/[^a-z0-9-]/g, "");
  return s || "ty";
}
