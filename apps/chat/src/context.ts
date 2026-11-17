// CONTEXT — co z rozmowy idzie do modelu. Trzy zasady:
//   1. Wyniki narzędzi w całości tylko w bieżącej turze (od ostatniej wiadomości usera). Starsze → skrót: lista źródeł
//      ([n] tytuł + adres) albo początek raportu. Sim i tak streścił je w swojej odpowiedzi; pełne zostają w bazie i w UI.
//   2. Kroczące streszczenie: gdy niestreszczona część rozmowy urośnie, najstarszy kawałek (poza ostatnimi KEEP wiadomościami)
//      idzie do streszczenia (tani model, w tle, po turze). Historia = [streszczenie] + reszta dosłownie.
//   3. Stały początek historii (zmienia się tylko przy streszczaniu i raz na turę przy skracaniu narzędzi) → cache promptu
//      obejmuje też historię, nie tylko prompt systemowy (patrz llm.stream: cache_control na ostatniej wiadomości).
import type { LlmAdapter } from "@qwe/core";
import type { SeqMessageRow, Store } from "./store.js";

export const CONTEXT = {
  /** Ile znaków niestreszczonej rozmowy (bez wyników narzędzi) uruchamia streszczanie. ~40k zn. ≈ 12k tokenów. */
  get triggerChars() { return Number(process.env.QWE_CTX_TRIGGER_CHARS || 40_000); }, // getter: .env ładuje się po imporcie modułu
  /** Ile ostatnich wiadomości (user + simy) zostaje zawsze dosłownie. */
  get keep() { return Number(process.env.QWE_CTX_KEEP || 12); },
  /** Bezpiecznik, gdyby streszczanie nie nadążało: maks. wiadomości w historii. */
  hardCap: 160,
  /** Skrót wyniku bez listy źródeł: tyle znaków początku. */
  toolHead: 400,
};

/** Wynik narzędzia ze starszej tury → skrót (źródła albo początek raportu). */
export function compactToolResult(content: string): string {
  const blocks = [...content.matchAll(/<nativeresult name="([^"]+)"([^>]*)>([\s\S]*?)<\/nativeresult>/g)];
  if (!blocks.length) return clip(content, CONTEXT.toolHead);
  return blocks
    .map(([, name, attrs, body]) => {
      const sources = [...body.matchAll(/^\[(\d+)\] (.+)\n(https?:\/\/\S+)/gm)].map(([, n, title, url]) => `[${n}] ${title.trim()} — ${url}`);
      const inner = sources.length ? `źródła:\n${sources.join("\n")}` : clip(body.trim(), CONTEXT.toolHead);
      return `<nativeresult name="${name}"${attrs} skrot="tak">\n(wynik z wcześniejszej tury, skrócony — ważne rzeczy są w odpowiedzi po nim)\n${inner}\n</nativeresult>`;
    })
    .join("\n\n");
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …" : s);

const metaSpoken = (m: SeqMessageRow): string => {
  try {
    const meta = m.meta ? (JSON.parse(m.meta) as { spoken?: string }) : {};
    return meta.spoken ?? m.content.replace(/<nativeapi>[\s\S]*$/, "").trim();
  } catch {
    return m.content.replace(/<nativeapi>[\s\S]*$/, "").trim();
  }
};

/** Wiersz transkryptu (neutralny, z perspektywy rozmowy): kto: co. Wyniki narzędzi tylko jako wzmianka. */
function line(m: SeqMessageRow, userName: string): string {
  if (m.role === "user") return `${userName}: ${m.content}`;
  if (m.role === "assistant") {
    const t = metaSpoken(m);
    return t ? `@${m.author}: ${t}` : "";
  }
  const names = [...m.content.matchAll(/<nativeresult name="([^"]+)"/g)].map((x) => x[1]);
  return `(@${m.author} użył narzędzi: ${[...new Set(names)].join(", ") || "narzędzie"})`;
}
const weight = (m: SeqMessageRow) => (m.role === "tool" ? 0 : m.role === "assistant" ? metaSpoken(m).length : m.content.length);

const SUMMARY_SYSTEM = [
  "Prowadzisz notatki z rozmowy użytkownika z simami (asystentami AI). Notatki zastępują simom starszą część rozmowy, więc muszą wystarczyć do dalszej pracy bez czytania oryginału.",
  "Dostajesz dotychczasowe notatki (mogą być puste) i kolejny fragment rozmowy. Zwracasz NOWE, kompletne notatki: scal stare z nowym fragmentem, zaktualizuj to, co się zmieniło, usuń to, co nieaktualne.",
  "Format — markdown, po polsku, zwięźle, tylko sekcje, które mają treść:",
  "## Cel — o co chodzi w tej rozmowie (1–2 zdania)",
  "## Ustalenia i decyzje — co zostało postanowione, wybrane, zatwierdzone",
  "## Konkrety — dane, które mogą się przydać dosłownie: nazwy, kwoty, daty, adresy, numery, linki, wyniki wyszukiwań",
  "## Zrobione — co simy już wykonały (zadania na komputerze, wyszukiwania) i z jakim skutkiem",
  "## Otwarte — na co czekamy, co jest do zrobienia, o co user prosił, a nie zostało jeszcze zrobione",
  "## Kto co — tylko jeśli w rozmowie jest kilka simów: za co odpowiada który",
  "Zachowuj konkrety dokładnie (liczby, nazwy własne, linki). Nie dopisuj nic, czego nie było. Pomijaj small talk.",
  'Zwróć TYLKO JSON: {"summary":"…markdown…"}',
].join("\n");

/** Kroczące streszczenie rozmów: jedno na rozmowę, wspólne dla wszystkich simów. */
export class ContextKeeper {
  private running = new Set<string>();

  constructor(
    private store: Store,
    private llm: LlmAdapter,
    private userName: () => string,
    private log: (level: "info" | "warn", message: string) => void = () => {},
  ) {}

  /** Po turze: jeśli niestreszczona część jest za duża, streść najstarszy kawałek. Async, bez blokowania rozmowy. */
  async maybeSummarize(sessionId: string): Promise<boolean> {
    if (this.running.has(sessionId)) return false;
    const { summary, seq } = this.store.getSummary(sessionId);
    const rows = this.store.messagesSince(sessionId, seq);
    const total = rows.reduce((a, m) => a + weight(m), 0);
    if (total < CONTEXT.triggerChars) return false;

    // cięcie: zostaw ostatnie KEEP wiadomości (user/sim); reszta zaczyna się od wiadomości usera
    let kept = 0;
    let cut = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role !== "tool") kept++;
      if (kept >= CONTEXT.keep && rows[i].role === "user" && i > 0) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) return false;
    const chunk = rows.slice(0, cut);

    this.running.add(sessionId);
    const t0 = Date.now();
    try {
      const who = this.userName() || "User";
      const transcript = chunk.map((m) => line(m, who)).filter(Boolean).join("\n");
      let next: string;
      if (this.llm.mock) {
        next = `${summary ? summary + "\n" : ""}## Konkrety (mock)\n${chunk.filter((m) => m.role !== "tool").map((m) => `- ${line(m, who).slice(0, 90)}`).join("\n")}`.slice(-6000);
      } else {
        const { value } = await this.llm.json<{ summary?: string }>(
          SUMMARY_SYSTEM,
          [{ role: "user", content: `DOTYCHCZASOWE NOTATKI:\n${summary || "(brak)"}\n\nKOLEJNY FRAGMENT ROZMOWY:\n${transcript}` }],
          { maxTokens: 2000 },
        );
        next = String(value.summary ?? "").trim();
      }
      // rozmowa mogła się w międzyczasie wyczyścić albo ktoś streścił szybciej — zapis tylko, gdy punkt startu się nie zmienił
      if (!next || this.store.getSummary(sessionId).seq !== seq || !this.store.getSession(sessionId)) return false;
      this.store.setSummary(sessionId, next, chunk[chunk.length - 1].seq);
      this.log("info", `[kontekst] streszczono ${chunk.length} wiad. (${Math.round(chunk.reduce((a, m) => a + weight(m), 0) / 1000)}k zn.) → ${Math.round(next.length / 100) / 10}k zn. w ${Date.now() - t0}ms`);
      return true;
    } catch (e) {
      this.log("warn", `[kontekst] streszczenie nie wyszło: ${(e as Error).message}`);
      return false;
    } finally {
      this.running.delete(sessionId);
    }
  }
}
