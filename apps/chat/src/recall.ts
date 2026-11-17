// RECALL — pamięć poprzednich rozmów.
//   • Recap: każda rozmowa dostaje krótkie podsumowanie (o czym, co ustalono, konkrety). Pisze je tani model w tle,
//     chwilę po tym, jak rozmowa ucichnie (debounce) — nie po każdej wiadomości. Zaległe (restart serwera w trakcie
//     odliczania, rozmowy sprzed tej funkcji) nadrabia przegląd: przy starcie i co kilka minut.
//     Przy okazji: jeśli rozmowa odjechała od tytułu (tytuł jest z pierwszej wiadomości), recap proponuje nowy —
//     tylko gdy user nie nadał tytułu ręcznie.
//   • memory.search: narzędzie simów, wykonywane w chat serverze (ma bazę). Szuka po tytułach, recapach, streszczeniach
//     i treści wiadomości — bez embeddingów i bez FTS (node:sqlite go nie ma): normalizacja polskich znaków + rdzenie słów
//     (faktura/fakturę/faktury → „faktur”). Wyniki ocenia już sam sim — dostaje kilka najlepszych rozmów z fragmentami.
import { escapeXml, nativeResult, type LlmAdapter, type NativeCall } from "@qwe/core";
import type { Store } from "./store.js";

export const RECALL = {
  /** Po tylu ms ciszy w rozmowie piszemy/odświeżamy jej recap. */
  get idleMs() { return Number(process.env.QWE_RECAP_IDLE_MS || 90_000); }, // getter: .env ładuje się po imporcie modułu
  /** Ile rozmów zwraca memory.search. */
  results: 5,
  /** Tyle ostatnich rozmów (tytuły) sim widzi w kontekście, żeby wiedział, że jest do czego sięgnąć. */
  recentInPrompt: 6,
  /** Przegląd zaległych recapów: co tyle ms, maks. tyle rozmów naraz. */
  sweepMs: 5 * 60_000,
  sweepBatch: 10,
};

/** Narzędzia wykonywane lokalnie w chat serverze (nie idą do agent servera). */
export const LOCAL_TOOLS = new Set(["memory.search"]);

export const MEMORY_SEARCH_USAGE = {
  usage: '<memory.search>czego szukasz, np. faktura Kowalski</memory.search> — przeszukuje Wasze POPRZEDNIE rozmowy (wszystkich simów): podsumowania i fragmenty',
  notes:
    "Użyj, gdy user nawiązuje do wcześniejszych rozmów („jak ostatnio”, „ta firma, o której mówiliśmy”, „co ustaliliśmy w sprawie…”) albo gdy odpowiedź pewnie padła już kiedyś. Pytaj konkretnymi słowami (nazwy, firmy, tematy), nie całym zdaniem. Pusta treść = ostatnie rozmowy. Tylko jako pojedyncze wywołanie, nie w planie.",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l");
const STOP = new Set("jak ten tej tego tym ktory ktora ktore ostatnio wczesniej rozmawialismy mowilismy mowiles mowilas byla bylo byly jest sie czy mnie mam masz moje moja moj nasz nasza dla przez oraz albo tylko jeszcze juz tez ale sprawie temat tamta tamten tamto".split(" "));
/** Rdzeń słowa (polska fleksja: końcówki odcinamy): faktura/fakturę → faktur, Kowalskiego → kowals, Krakowie → krakow. */
const stem = (t: string) => t.slice(0, Math.min(6, Math.max(4, t.length - 1)));
export function queryStems(q: string): string[] {
  return [...new Set(norm(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)).map(stem))];
}
const count = (hay: string, s: string) => {
  let n = 0;
  for (let i = hay.indexOf(s); i !== -1 && n < 5; i = hay.indexOf(s, i + s.length)) n++;
  return n;
};
const spokenOf = (content: string, meta: string | null) => {
  try {
    const m = meta ? (JSON.parse(meta) as { spoken?: string }) : {};
    return m.spoken ?? content.replace(/<nativeapi>[\s\S]*$/, "").trim();
  } catch {
    return content.replace(/<nativeapi>[\s\S]*$/, "").trim();
  }
};
const day = (iso: string) => iso.slice(0, 10);

/** Znaleziona rozmowa — do karty „przypominam sobie” w UI. */
export interface FoundConversation {
  id: string;
  day: string;
  title: string;
  members: string[];
  about: string;
}

/** memory.search: najlepsze rozmowy (poza bieżącą) z podsumowaniem i pasującymi fragmentami → tekst dla modelu + lista dla UI. */
export function searchConversations(store: Store, query: string, excludeSession: string, userName: string): { text: string; found: FoundConversation[] } {
  const stems = queryStems(query);
  const sessions = store.recallSessions().filter((s) => s.id !== excludeSession);
  if (!sessions.length) return { text: "Brak wcześniejszych rozmów.", found: [] };
  const msgs = store.recallMessages().filter((m) => m.session_id !== excludeSession);
  const bySession = new Map<string, typeof msgs>();
  for (const m of msgs) (bySession.get(m.session_id) ?? bySession.set(m.session_id, []).get(m.session_id)!).push(m);

  type Hit = { s: (typeof sessions)[number]; score: number; matched: number; snippets: string[] };
  const hits: Hit[] = sessions.map((s) => {
    const meta = norm(`${s.title}\n${s.recap}\n${s.summary}`);
    const rows = bySession.get(s.id) ?? [];
    let score = 0;
    const matchedStems = new Set<string>();
    const snippets: { text: string; n: number }[] = [];
    for (const st of stems) {
      const inTitle = count(norm(s.title), st);
      const inMeta = count(meta, st);
      if (inTitle || inMeta) matchedStems.add(st);
      score += inTitle * 4 + inMeta * 2;
    }
    for (const m of rows) {
      const text = m.role === "assistant" ? spokenOf(m.content, m.meta) : m.content;
      const n = norm(text);
      const found = stems.filter((st) => n.includes(st));
      if (!found.length) continue;
      found.forEach((st) => matchedStems.add(st));
      score += Math.min(3, found.length);
      // fragment wokół pierwszego trafienia (indeksy z tekstu znormalizowanego pasują 1:1 — NFD tylko zdejmuje znaki łączące)
      const at = Math.max(0, n.indexOf(found[0]) - 120);
      const who = m.role === "user" ? userName || "user" : `@${m.author}`;
      snippets.push({ text: `${who}: ${at > 0 ? "…" : ""}${text.slice(at, at + 320).replace(/\s+/g, " ").trim()}${text.length > at + 320 ? "…" : ""}`, n: found.length });
    }
    snippets.sort((a, b) => b.n - a.n);
    return { s, score: score + matchedStems.size * 6, matched: matchedStems.size, snippets: snippets.slice(0, 3).map((x) => x.text) };
  });

  // bez słów kluczowych → po prostu ostatnie rozmowy
  const ranked = stems.length ? hits.filter((h) => h.matched > 0).sort((a, b) => b.score - a.score || (a.s.updated_at < b.s.updated_at ? 1 : -1)) : hits;
  const top = ranked.slice(0, RECALL.results);
  if (!top.length) return { text: `Nic nie znalazłem we wcześniejszych rozmowach dla: ${escapeXml(query)}. Najnowsze rozmowy: ${sessions.slice(0, 5).map((s) => `„${s.title}” (${day(s.updated_at)})`).join(", ")}.`, found: [] };
  const found: FoundConversation[] = [];
  const text = top
    .map(({ s, snippets }) => {
      let members: string[] = [];
      try {
        members = JSON.parse(s.members) as string[];
      } catch {
        /* — */
      }
      const about = s.recap || (s.summary ? s.summary.slice(0, 600) + (s.summary.length > 600 ? "…" : "") : "(bez podsumowania — tylko fragmenty)");
      found.push({ id: s.id, day: day(s.updated_at), title: s.title, members, about: s.recap || snippets[0] || "" });
      return `<rozmowa data="${day(s.updated_at)}" tytul="${escapeXml(s.title)}" simy="${members.map((m) => `@${m}`).join(" ")}">\n${about}${snippets.length ? `\nFragmenty:\n${snippets.map((x) => `- ${x}`).join("\n")}` : ""}\n</rozmowa>`;
    })
    .join("\n\n");
  return { text, found };
}

/** Lokalne wywołanie narzędzia → <nativeresult> dla modelu + `found` dla UI. */
export function runLocalTool(store: Store, call: NativeCall, sessionId: string, userName: string): { text: string; found?: FoundConversation[] } {
  if (call.name === "memory.search") {
    const r = searchConversations(store, call.args._ ?? "", sessionId, userName);
    return { text: nativeResult("memory.search", r.text, { ok: "true" }), found: r.found };
  }
  return { text: nativeResult(call.name, `Nieznane narzędzie lokalne: ${call.name}`, { ok: "false" }) };
}

/** Ostatnie rozmowy do kontekstu sima (tytuł + data), bez bieżącej. */
export function recentConversations(store: Store, excludeSession: string): { title: string; day: string }[] {
  return store
    .recallSessions()
    .filter((s) => s.id !== excludeSession && s.title !== "Nowa rozmowa")
    .slice(0, RECALL.recentInPrompt)
    .map((s) => ({ title: s.title, day: day(s.updated_at) }));
}

const RECAP_SYSTEM = [
  "Piszesz krótkie podsumowanie rozmowy użytkownika z simami (asystentami AI) — do archiwum, żeby za tydzień czy miesiąc dało się ją odnaleźć i zrozumieć bez czytania całości.",
  "2–5 zdań po polsku: o czym była rozmowa, co ustalono lub zrobiono, z jakim wynikiem. Zachowaj konkrety dokładnie: nazwy firm i osób, kwoty, daty, miejsca, linki, numery dokumentów — to po nich będzie się szukać.",
  "Bez wstępów typu „W tej rozmowie…”. Pomiń small talk. Jeśli rozmowa to tylko powitanie bez treści — zwróć pusty recap.",
  "Tytuł: dostajesz obecny tytuł (nadany z pierwszej wiadomości). Jeśli nadal oddaje główny temat — zwróć pusty title. Jeśli rozmowa poszła gdzie indziej albo tytuł jest mylący — zaproponuj nowy: jedno emoji + 2–5 słów po polsku, bez kropki, o głównym temacie całej rozmowy.",
  'Zwróć TYLKO JSON: {"recap":"…","title":""}',
].join("\n");

/** Recapy rozmów: debounce po ostatniej turze, potem jedno wywołanie taniego modelu. */
export class RecapWriter {
  private timers = new Map<string, NodeJS.Timeout>();
  private sweeping = false;
  constructor(
    private store: Store,
    private llm: LlmAdapter,
    private userName: () => string,
    private log: (level: "info" | "warn", message: string) => void = () => {},
    /** Recap zmienił tytuł rozmowy → odśwież listę i nagłówek. */
    private onTitle: (sessionId: string, title: string) => void = () => {},
  ) {}

  /** Przegląd zaległych recapów: zaraz po starcie i potem co RECALL.sweepMs. */
  startSweep() {
    const run = () => void this.sweep();
    setTimeout(run, 10_000).unref?.();
    setInterval(run, RECALL.sweepMs).unref?.();
  }
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let n = 0;
    try {
      const idleBefore = new Date(Date.now() - RECALL.idleMs).toISOString();
      // po kolei, nie równolegle — to tło, nie ma się gdzie spieszyć
      for (const id of this.store.sessionsNeedingRecap(idleBefore, RECALL.sweepBatch)) if (!this.timers.has(id) && (await this.write(id))) n++;
      if (n) this.log("info", `[recap] przegląd: nadrobiono ${n}`);
    } finally {
      this.sweeping = false;
    }
    return n;
  }

  /** Po turze: (prze)planuj recap na moment, gdy rozmowa ucichnie. */
  schedule(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    const t = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.write(sessionId);
    }, RECALL.idleMs);
    t.unref?.();
    this.timers.set(sessionId, t);
  }

  async write(sessionId: string): Promise<boolean> {
    if (!this.store.getSession(sessionId)) return false;
    const { seq: recapSeq } = this.store.getRecap(sessionId);
    const lastSeq = this.store.lastSeq(sessionId);
    if (!lastSeq || lastSeq <= recapSeq) return false; // nic nowego od ostatniego recapu
    const { summary, seq } = this.store.getSummary(sessionId);
    const who = this.userName() || "User";
    const rows = this.store.messagesSince(sessionId, seq).filter((m) => m.role !== "tool");
    if (!rows.some((m) => m.role === "user")) return false;
    let transcript = rows.map((m) => (m.role === "user" ? `${who}: ${m.content}` : `@${m.author}: ${spokenOf(m.content, m.meta)}`)).join("\n");
    if (transcript.length > 20_000) transcript = "…" + transcript.slice(-20_000);
    const title = this.store.getSession(sessionId)?.title ?? "";
    const canRetitle = !this.store.isTitleManual(sessionId);
    try {
      let recap: string;
      let newTitle = "";
      if (this.llm.mock) {
        const users = rows.filter((m) => m.role === "user");
        recap = `(mock) ${title}: ${users.map((m) => m.content.slice(0, 60)).join(" / ")}`.slice(0, 400);
        // mock: rozmowa z ≥3 wiadomościami usera → tytuł z ostatniej (żeby dało się sprawdzić ścieżkę zmiany tytułu)
        if (users.length >= 3) newTitle = `🗂️ ${users[users.length - 1].content.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).slice(0, 4).join(" ")}`;
      } else {
        const { value } = await this.llm.json<{ recap?: string; title?: string }>(
          RECAP_SYSTEM,
          [{ role: "user", content: `TYTUŁ: ${title}\n\n${summary ? `NOTATKI ZE STARSZEJ CZĘŚCI:\n${summary}\n\n` : ""}ROZMOWA:\n${transcript}` }],
          { maxTokens: 500 },
        );
        recap = String(value.recap ?? "").trim();
        newTitle = String(value.title ?? "").trim().replace(/^["„]|["”]$/g, "").slice(0, 60);
      }
      this.store.setRecap(sessionId, recap, lastSeq);
      if (canRetitle && newTitle && newTitle !== title && this.store.retitleAuto(sessionId, newTitle)) {
        this.log("info", `[recap] tytuł: „${title}” → „${newTitle}”`);
        this.onTitle(sessionId, newTitle);
      }
      this.log("info", `[recap] ${sessionId.slice(-5)}: ${recap.slice(0, 90)}${recap.length > 90 ? "…" : ""}`);
      return true;
    } catch (e) {
      this.log("warn", `[recap] ${(e as Error).message}`);
      return false;
    }
  }
}
