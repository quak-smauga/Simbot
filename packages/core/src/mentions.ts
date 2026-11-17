// MENTIONS — `@nazwa` i `@nazwa.akcja` w wiadomościach. Jedyny sposób adresowania w rozmowie z wieloma simami.
//   user:  "@ksiegowy.task wystaw fakturę, @audytor patrz na ręce"  → ksiegowy (task), potem audytor (ask)
//   bot:   "@kacper potwierdzasz?"                                  → powiadomienie dla usera
//   bot:   "@audytor sprawdź sumy"                                   → łańcuch: audytor odpowiada po księgowym
// Bez @ odpowiada prowadzący rozmowy (pierwszy członek). Akcje to rejestr — `task` zmienia tryb odpowiedzi sima.
// Odpowiadają TYLKO simy z rozmowy: @sim spoza rozmowy nie dołącza sam (trafia do `absent` — UI podpowiada „dodaj”).

export interface Mention {
  /** nazwa po @ (małe litery) */
  name: string;
  /** akcja po kropce (np. "task"); brak = zwykłe zwrócenie się */
  action: MentionAction;
  index: number;
  raw: string;
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

/** `@nazwa: tekst` to cytat (tak sim widzi cudze wypowiedzi), nie wołanie — pomijamy. */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(RE)) {
    if (m[4]) continue;
    const action = (m[3] ?? "ask").toLowerCase();
    out.push({ name: m[2].toLowerCase(), action: action in MENTION_ACTIONS ? (action as MentionAction) : "ask", index: (m.index ?? 0) + m[1].length, raw: m[0].slice(m[1].length) });
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
}

export interface Targets {
  bots: { name: string; action: MentionAction; joined: boolean }[];
  userMentioned: boolean;
  unknown: string[];
  /** znane simy, których nie ma w tej rozmowie — wspomniane, ale nie odpowiadają */
  absent: string[];
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
    if (!o.known.includes(m.name)) {
      unknown.push(m.name);
      continue;
    }
    seen.add(m.name);
    if (!o.members.includes(m.name)) {
      absent.push(m.name);
      continue;
    }
    bots.push({ name: m.name, action: m.action, joined: false });
  }
  // nikt z rozmowy nie zawołany (także: same @ do simów spoza rozmowy) → odpowiada prowadzący; dotyczy tylko usera
  if (!bots.length && !o.from && o.members[0]) bots.push({ name: o.members[0], action: "ask", joined: false });
  return { bots, userMentioned, unknown, absent };
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
