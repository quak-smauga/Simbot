// BOT RUNNER — jedna tura jednego sima w rozmowie: historia (z bazy, z perspektywy TEGO sima) → LLM (stream) → say.*
// | <nativeapi> → task w agent serverze → <nativeresult> → LLM … → koniec tury. Nie wie nic o audio ani o UI.
//
// Rozmowa ma wielu simów, więc historia nie jest własnością runnera — buduje się z bazy przy każdej turze:
//   user               → user
//   assistant (ja)     → assistant (pełny tekst z blokiem)
//   assistant (inny)   → user, jako „@nazwa: tekst” (bez bloków — cudze narzędzia to nie moja sprawa)
//   tool (moje)        → user (<nativeresult>) — w całości tylko w bieżącej turze, starsze skrócone (context.ts)
//   tool (cudze)       → pomijam
// Na początku: streszczenie starszej części rozmowy (jeśli jest). Sąsiednie tury tej samej roli sklejam, ale każdy kawałek
// zostaje osobnym blokiem (Turn.parts) — dzięki temu początek historii jest bajt w bajt taki sam co turę i łapie się w cache.
import { CLOSE_TAG, ToolStreamParser, escapeXml, nativeResult, newId, withClosedTag, type LlmAdapter, type Media, type MentionAction, type ModelCaps, type NativeBlock, type NativeCall, type Turn, MENTION_ACTIONS, parseMentions } from "@qwe/core";
import { fileParts, filesBudget } from "./files.js";
import type { AgentLink } from "./agent-link.js";
import type { ChatBus } from "./events.js";
import { CONTEXT, compactToolResult } from "./context.js";
import type { FoundConversation } from "./recall.js";

type LocalResult = { text: string; found?: FoundConversation[]; files?: string[] };
import type { MessageRow, Store } from "./store.js";

const MAX_HOPS = 3;

export interface BotRunnerOptions {
  sessionId: string;
  bot: string;
  bus: ChatBus;
  llm: LlmAdapter;
  link: AgentLink;
  store: Store;
  /** Prompt systemowy sima (cache'owany po stronie API) — funkcja, bo sim może się zmienić (skill.save, edycja). */
  system: () => string;
  /** Kontekst rozmowy (członkowie, workflow) — zmienny, idzie poza cache. */
  context: () => string;
  /** ElevenLabs voiceId sima (puste = domyślny). */
  voice: () => string;
  maxTokens: number;
  /** Folder plików rozmowy + co potrafi model rozmowy (pliki w kontekście: obraz/PDF/tekst albo odnośnik). */
  filesDir?: string;
  /** Czy narzędzie jest lokalne (wtedy także plan z samych takich kroków wykonuje się tutaj). */
  isLocal?: (name: string) => boolean;
  caps?: () => ModelCaps;
  /** Simy w pokoju, gdy jest ich więcej niż jeden (wtedy historia idzie w <msg from to>); null = rozmowa 1:1. */
  room?: () => string[] | null;
  /** Narzędzia wykonywane w chat serverze (memory.search, files.*). Zwraca <nativeresult> albo null, gdy to nie lokalne narzędzie. */
  local?: (call: NativeCall) => Promise<LocalResult | null> | LocalResult | null;
  /** Po skończonej turze (ostatnia odpowiedź bez bloku): wymiana user→…→sim do pamięci. */
  onTurnDone?: (exchange: Turn[]) => void;
}

export class BotRunner {
  private abort?: AbortController;
  private turn = 0;
  /** Aktualnie wykonywany task w agent serverze (do komend głosowych / przycisków). */
  activeTaskId: string | null = null;

  constructor(private o: BotRunnerOptions) {}

  /** Zamknięcie rozmowy / reset: przerwij turę i anuluj zadanie w agencie. */
  cancel() {
    this.abort?.abort();
    if (this.activeTaskId) void this.o.link.control(this.activeTaskId, "cancel");
  }

  /**
   * Esc / barge-in / „przestań mówić”: przerywa mówienie i myślenie, ale NIE zadanie komputera w toku — to anuluje się
   * tylko wprost (Anuluj, ⌃⌥Esc, „anuluj zadanie”). Inaczej Esc w trakcie logowania kończył udane zadanie jako „anulowano”.
   * Zwraca true, jeśli tura czeka na zadanie (nic nie przerwano).
   */
  interrupt(): boolean {
    if (this.activeTaskId) return true;
    this.abort?.abort();
    return false;
  }

  /** Historia z bazy z perspektywy tego sima: [streszczenie] + wiadomości po nim (stare wyniki narzędzi skrócone). */
  history(): Turn[] {
    const me = this.o.bot;
    const { store, sessionId } = this.o;
    const { summary, seq } = store.getSummary(sessionId);
    let rows = store.messagesSince(sessionId, seq);
    if (rows.length > CONTEXT.hardCap) rows = rows.slice(-CONTEXT.hardCap);
    // bieżąca tura = od ostatniej wiadomości usera; wcześniejsze wyniki narzędzi już „przerobione” w odpowiedziach
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === "user") { lastUser = i; break; }

    const turns: Turn[] = [];
    const push = (role: Turn["role"], text: string, media: (string | Media)[] = []) => {
      const parts = [...media, ...(text ? [text] : [])];
      if (!parts.length) return;
      const plain = parts.filter((p): p is string => typeof p === "string").join("\n\n");
      const last = turns[turns.length - 1];
      if (last && last.role === role) {
        last.content += "\n\n" + plain;
        last.parts!.push(...parts);
      } else turns.push({ role, content: plain, parts });
    };
    // pliki: w bieżącej turze w treści (w budżecie), wcześniej — odnośniki (patrz files.ts)
    const caps = this.o.caps?.();
    // @[ścieżka] (meta.scope): w bieżącej turze pliki jak załączniki (ten sam budżet), wcześniej — jedna linijka
    const files = (m: MessageRow, inline: boolean) => {
      const meta = metaOf(m);
      const names = meta.files ?? [];
      const scope = meta.scope;
      if ((!names.length && !scope?.refs.length) || !this.o.filesDir || !caps) return [];
      const out: (string | Media)[] = [];
      if (scope?.refs.length) {
        const what = scope.refs.map((r) => `@[${r.path}] (${r.type === "dir" ? `folder, ${r.count} pl.` : "plik"})`).join(", ");
        out.push(inline ? `[user wskazał: ${what} — treść poniżej, w miarę budżetu]` : `[user wskazał wtedy: ${what}; zajrzyj przez files.list / files.read / files.look]`);
      }
      const all = inline ? [...names, ...(scope?.files ?? []).filter((f) => !names.includes(f))] : names;
      if (all.length) out.push(...fileParts(this.o.filesDir, all, caps, inline, filesBudget(caps)));
      return out;
    };
    if (summary) push("user", `<streszczenie_rozmowy>\nTo notatki ze starszej części tej rozmowy (pełne wiadomości już nie mieszczą się w kontekście). Traktuj je jak to, co pamiętasz z wcześniej.\n\n${summary}\n</streszczenie_rozmowy>`);
    // w pokoju z kilkoma simami cudze wiadomości idą w <msg from to>: kto mówi i kogo naprawdę zawołał (routing aplikacji,
    // nie zgadywanie po gołym @). Jeden sim + user → zwykły tekst usera, jak dawniej.
    const room = this.o.room?.() ?? null;
    rows.forEach((m, i) => {
      if (m.role === "user") push("user", room ? msgTag(m.author, metaOf(m).to ?? callsIn(m.content, room, m.author), m.content) : m.content, files(m, i === lastUser));
      else if (m.role === "assistant") {
        if (m.author === me) push("assistant", m.content);
        else {
          const spoken = metaOf(m).spoken ?? m.content.replace(/<nativeapi>[\s\S]*$/, "").trim();
          if (spoken) push("user", msgTag(m.author, callsIn(spoken, room ?? [], m.author), spoken));
        }
      } else if (m.role === "tool" && m.author === me) push("user", i > lastUser ? m.content : compactToolResult(m.content), i > lastUser ? files(m, true) : []);
    });
    while (turns.length && turns[0].role !== "user") turns.shift();
    return turns;
  }

  /**
   * Jedna tura sima. `source` = jak przyszła wiadomość usera (głos/tekst), `action` = tryb z @ (ask | task).
   * Zwraca tekst ostatniej wypowiedzi (do łańcucha @ i snippetu listy).
   */
  async respond(source: "stt" | "typed", action: MentionAction = "ask"): Promise<string> {
    const { bus, store, sessionId, bot } = this.o;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.turn++;
    bus.emit("agent.thinking", { turn: this.turn, bot });
    bus.emit("agent.state", { state: "thinking", bot });
    const mode = source === "stt" ? "[tryb: GŁOS — odpowiadaj krótko, tylko mówione słowa, bez markdownu]" : "[tryb: TEKST — czat; markdown renderuje się (listy, **pogrubienia**, tabele, kod) — używaj, gdy porządkuje odpowiedź]";
    // kontekst rozmowy (skład, workflow) zmienia się rzadko → przed historią; tryb i akcja zmieniają się co turę → na końcu,
    // za punktem cache (inaczej każda zmiana trybu unieważniałaby cache całej historii)
    const systemExtra = this.o.context();
    const tail = [mode, MENTION_ACTIONS[action].prompt].filter(Boolean).join("\n");
    const startSeq = store.lastSeq(sessionId); // wiadomość, na którą odpowiadamy (do pamięci po turze)
    let last = "";
    try {
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        if (signal.aborted) return last;
        const r = await this.streamOnce(signal, systemExtra, tail);
        last = r.text || last;
        if (!r.block) {
          if (!signal.aborted) this.o.onTurnDone?.(exchangeOf(store.messagesSince(sessionId, startSeq - 1), bot));
          return last;
        }
        if (hop === MAX_HOPS) {
          this.pushTool("(limit narzędzi w tej turze — odpowiedz z tym, co masz)");
          continue;
        }
        const res = await this.runBlock(r.block, signal);
        this.pushTool(res.text, res.files);
        bus.emit("agent.state", { state: "thinking", bot });
      }
      return last;
    } finally {
      this.activeTaskId = null;
    }
  }

  /** Wynik narzędzia do historii. `files` = pliki, które model ma zobaczyć w następnym kroku (files.look). */
  private pushTool(text: string, files?: string[]) {
    this.o.store.addMessage(this.o.sessionId, "tool", this.o.bot, text, files?.length ? { files } : undefined);
  }

  private async streamOnce(signal: AbortSignal, systemExtra: string, tail: string): Promise<{ block: NativeBlock | null; text: string }> {
    const { bus, llm, store, sessionId, bot } = this.o;
    let sayId: string | null = null;
    let spoken = "";
    const parser = new ToolStreamParser((delta) => {
      if (!delta.trim() && !sayId) return;
      if (!sayId) {
        sayId = newId("say");
        bus.emit("say.start", { sayId, bot, voice: this.o.voice() });
      }
      spoken += delta;
      bus.emit("say.text", { sayId, delta, bot });
    });
    let full = "";
    try {
      const res = await llm.stream(this.o.system(), this.history(), (d) => parser.push(d), { signal, stopSequences: [CLOSE_TAG], maxTokens: this.o.maxTokens, systemExtra, tail, cacheHistory: true });
      if (res.stopReason === "max_tokens") this.o.bus.emit("log", { level: "warn", message: `odpowiedź @${bot} ucięta — skończył się limit (QWE_CHAT_MAX_TOKENS=${this.o.maxTokens})` });
      if (res.usage.input || res.usage.cacheRead) this.o.bus.emit("log", { level: "info", message: `[llm @${bot}] wejście ${res.usage.input} + cache ${res.usage.cacheRead ?? 0} (zapis ${res.usage.cacheWrite ?? 0}) · wyjście ${res.usage.output}` });
      full = res.text;
    } catch (e) {
      if (signal.aborted) return { block: null, text: "" };
      bus.emit("agent.error", { message: (e as Error).message, bot });
      const msg = "Coś mi się urwało w głowie, powtórz.";
      if (!sayId) {
        sayId = newId("say");
        bus.emit("say.start", { sayId, bot });
      }
      bus.emit("say.text", { sayId, delta: msg, bot });
      bus.emit("say.end", { sayId, text: spoken + msg, bot });
      return { block: null, text: spoken + msg };
    }
    const block = parser.finish();
    const text = spoken.trim();
    if (sayId) bus.emit("say.end", { sayId, text, bot });
    const closed = withClosedTag(full);
    const m = store.addMessage(sessionId, "assistant", bot, closed, { spoken: text, hasBlock: !!block });
    if (text) bus.emit("assistant.message", { messageId: m.id, text, bot });
    return { block, text };
  }

  /** Blok → task w agent serverze (jako ten sim) → tekst <nativeresult> dla modelu. */
  private async runBlock(block: NativeBlock, signal: AbortSignal): Promise<{ text: string; files?: string[] }> {
    const { bus, link, bot } = this.o;
    const callId = newId("call");
    const t0 = Date.now();
    bus.emit("agent.state", { state: "working", bot });
    bus.emit("tool.call", { callId, block, bot });
    let text: string;
    let ok = false;
    // plan z samych lokalnych narzędzi (np. kilka files.read) — kroki po kolei tutaj, agent server ich nie zna
    if (block.kind === "plan" && this.o.local && this.o.isLocal && block.steps.length && block.steps.every((s) => this.o.isLocal!(s.name))) {
      const rs: LocalResult[] = [];
      for (const st of block.steps) rs.push((await this.o.local(st)) ?? { text: nativeResult(st.name, "nie wykonano", { ok: "false" }) });
      text = nativeResult("plan", rs.map((r, i) => `<step id="${block.steps[i].id}" name="${block.steps[i].name}" status="completed">\n${r.text}\n</step>`).join("\n\n"), { ok: "true" });
      const files = rs.flatMap((r) => r.files ?? []);
      bus.emit("tool.result", { callId, ok: true, ms: Date.now() - t0, text, bot, found: rs.flatMap((r) => r.found ?? []) });
      return { text, files };
    }
    // lokalne narzędzia (memory.search, files.*) — bez agent servera
    if (block.kind === "direct" && this.o.local) {
      const local = await Promise.all(block.calls.map((c) => this.o.local!(c)));
      if (local.every((x) => x !== null)) {
        const rs = local as LocalResult[];
        text = rs.map((r) => r.text).join("\n\n");
        const found = rs.flatMap((r) => r.found ?? []);
        const files = rs.flatMap((r) => r.files ?? []);
        bus.emit("tool.result", { callId, ok: true, ms: Date.now() - t0, text, bot, found });
        return { text, files };
      }
    }
    try {
      const r = await link.submit(block, this.o.sessionId, bot, (taskId) => {
        this.activeTaskId = taskId;
        bus.emit("agent.state", { state: "working", taskId, bot });
      });
      // pełny wynik narzędzi zawsze (także po anulowaniu: raport z tego, co zdążyło się zrobić), pod nazwą narzędzia
      ok = r.ok;
      const cancelled = r.state === "cancelled" ? { task: "cancelled_by_user" } : {};
      if (block.kind === "direct") {
        text = r.parts.length ? r.parts.map((p) => nativeResult(p.name, p.text, { ok: String(p.ok), status: p.status, ...cancelled })).join("\n\n") : nativeResult(block.calls[0]?.name ?? "task", r.state === "cancelled" ? "STATUS: cancelled_by_user\nZadanie anulowane, zanim narzędzie cokolwiek oddało." : `Błąd: ${r.error ?? r.state}`, { ok: "false", status: r.state === "cancelled" ? "cancelled_by_user" : "failed" });
      } else {
        const steps = r.parts.map((p) => `<step id="${p.stepId}" name="${p.name}" status="${p.status ?? (p.ok ? "completed" : "failed")}">\n${p.text}\n</step>`).join("\n\n");
        text = nativeResult("plan", steps || `Błąd: ${r.error ?? r.state}`, { ok: String(r.ok), ...cancelled });
      }
    } catch (e) {
      text = nativeResult("task", `Błąd: ${escapeXml((e as Error).message)}`);
    }
    bus.emit("tool.result", { callId, taskId: this.activeTaskId ?? undefined, ok, ms: Date.now() - t0, text, bot });
    return { text };
  }
}

/** Wiadomość w historii pokoju: `<msg from="ksiegowy" to="sima">…</msg>`; `to` = kto został zawołany (pusto = nikt). */
export function msgTag(from: string, to: string[], body: string): string {
  return `<msg from="${from}"${to.length ? ` to="${to.join(" ")}"` : ""}>\n${body.replace(/<\/msg>/g, "<\\/msg>")}\n</msg>`;
}
/** Kogo wiadomość woła — te same reguły co routing (bez kodu, cytatów, cudzysłowów), tylko simy z pokoju. */
function callsIn(text: string, room: string[], from: string): string[] {
  return [...new Set(parseMentions(text).map((m) => m.name))].filter((n) => n !== from && room.includes(n));
}

type Meta = { to?: string[]; spoken?: string; files?: string[]; scope?: { refs: { path: string; type: "dir" | "file"; count: number }[]; files: string[] } };
const metaOf = (m: MessageRow): Meta => {
  try {
    return m.meta ? (JSON.parse(m.meta) as Meta) : {};
  } catch {
    return {};
  }
};

/** Do pamięci: ostatnia wiadomość usera + to, co ten sim powiedział w tej turze (bez narzędzi). */
function exchangeOf(rows: MessageRow[], bot: string): Turn[] {
  const out: Turn[] = [];
  for (const m of rows) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.author === bot) out.push({ role: "assistant", content: metaOf(m).spoken ?? m.content });
  }
  const lastUser = out.map((t) => t.role).lastIndexOf("user");
  return lastUser === -1 ? out : out.slice(lastUser);
}
