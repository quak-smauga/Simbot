// LLM — adapter dla chatu (stream) i executorów capability (json). Dwóch dostawców: Anthropic i Ollama (lokalnie).
// Dwa sloty: „chat” (rozmowa) i „tools” (zadania: computer, streszczenia, tytuły, pamięć). Wybór z UI (LlmSelection)
// przełącza się w locie; bez wyboru — modele z env (QWE_CHAT_MODEL / QWE_EXECUTOR_MODEL), jak dawniej. Tryb mock bez klucza.
import Anthropic from "@anthropic-ai/sdk";
import { OllamaClient } from "./ollama.js";

export type Role = "user" | "assistant";
/** Plik dołączony do tury: obraz albo PDF (bajty). Tekst idzie zwykłym stringiem. */
export interface Media {
  kind: "image" | "pdf";
  data: Buffer;
  mime: string;
  name?: string;
}
export interface Turn {
  role: Role;
  content: string;
  /** Opcjonalnie: ta sama treść jako osobne kawałki (sklejone tury) → osobne bloki w API. Stabilny prefiks dla cache.
   *  Kawałek może być plikiem (obraz/PDF) — trafia do API jako blok obrazu/dokumentu w tym miejscu. */
  parts?: (string | Media)[];
}
export interface StreamOptions {
  model?: string;
  maxTokens?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  /** Dopisek do promptu systemowego (poza cache'owanym blokiem) — rzadko zmienny kontekst, np. skład rozmowy. */
  systemExtra?: string;
  /** Notka na samym końcu (za punktem cache): zmienna co turę, np. tryb głos/tekst. Doklejana do ostatniej wiadomości usera. */
  tail?: string;
  /** Cache także historii: cache_control na ostatniej wiadomości (kolejna tura czyta prefiks z cache). */
  cacheHistory?: boolean;
}
export interface JsonOptions {
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Obraz (np. screenshot) dołączany do OSTATNIEJ wiadomości usera. */
  image?: { data: Buffer; mime: "image/jpeg" | "image/png" };
}
export interface LlmUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type LlmProvider = "anthropic" | "ollama";
export type LlmSlotName = "chat" | "tools";
/** Model w slocie + to, co potrafi (wypełnia chat server przy zapisie wyboru). */
export interface LlmSlot {
  provider: LlmProvider;
  model: string;
  vision?: boolean;
  /** Maks. kontekst modelu (tokeny). */
  ctx?: number;
}
/** Wybór z UI. `tools` puste = ten sam model co rozmowa. */
export interface LlmSelection {
  chat: LlmSlot;
  tools?: LlmSlot | null;
}
export interface ModelCaps {
  provider: LlmProvider;
  model: string;
  vision: boolean;
  ctx?: number;
  mock: boolean;
}

export interface LlmAdapter {
  readonly mock: boolean;
  /** Co potrafi model w danym slocie (np. czy widzi obrazy). Opcjonalne — stare/testowe adaptery go nie mają. */
  caps?(slot: LlmSlotName): ModelCaps;
  /** Strumień tekstu (chat). Zwraca pełny tekst i stop_reason. */
  stream(system: string, history: Turn[], onDelta: (d: string) => void, opts?: StreamOptions): Promise<{ text: string; stopReason: string | null; usage: LlmUsage }>;
  /** Jedna odpowiedź jako JSON (executor computer itp.). Rzuca, jak nie da się sparsować. */
  json<T = unknown>(system: string, history: Turn[], opts?: JsonOptions): Promise<{ value: T; raw: string; usage: LlmUsage }>;
}

export interface LlmConfig {
  apiKey?: string;
  chatModel: string;
  executorModel: string;
  mock?: boolean;
  /** Myślenie modelu w rozmowie (domyślnie wyłączone — patrz noThinking). */
  chatThinking?: boolean;
  ollamaUrl?: string;
  /** Górny limit num_ctx dla Ollamy. */
  ollamaNumCtx?: number;
  /** Wybór z UI (zapisany) — nadpisuje modele z env. */
  selection?: LlmSelection | null;
}

/** Adapter z przełącznikiem: `select()` zmienia modele w locie (UI → chat server → agent). */
export interface SwitchableLlm extends LlmAdapter {
  select(sel: LlmSelection | null): void;
  selection(): LlmSelection | null;
  caps(slot: LlmSlotName): ModelCaps;
  readonly ollama: OllamaClient;
}

/** Wszystkie modele Claude widzą obrazy i czytają PDF; kontekst 200k. */
export const ANTHROPIC_MODELS: { id: string; label: string; ctx: number }[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", ctx: 200_000 },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", ctx: 200_000 },
  { id: "claude-opus-5-5", label: "Opus 5.5", ctx: 200_000 },
  { id: "claude-fable-5-2", label: "Fable 5.2", ctx: 200_000 },
];

export function createLlm(cfg: LlmConfig, mockFns?: Partial<Pick<LlmAdapter, "stream" | "json">>): SwitchableLlm {
  const ollama = new OllamaClient(cfg.ollamaUrl, cfg.ollamaNumCtx);
  const mock = mockLlm(mockFns);
  const claude = cfg.apiKey && !cfg.mock ? anthropicLlm(cfg, new Anthropic({ apiKey: cfg.apiKey })) : null;
  let sel: LlmSelection | null = cfg.selection ?? null;

  // slot → kto i jakim modelem. Bez wyboru z UI: env (i caller może podać własny model, np. QWE_PLANNER_MODEL).
  const slot = (name: LlmSlotName): LlmSlot & { user: boolean } => {
    const s = name === "tools" ? (sel?.tools ?? sel?.chat) : sel?.chat;
    if (s) return { ...s, user: true };
    return { provider: "anthropic", model: name === "chat" ? cfg.chatModel : cfg.executorModel, vision: true, user: false };
  };
  const isMock = (s: LlmSlot) => !!cfg.mock || (s.provider === "anthropic" && !claude);
  const caps = (name: LlmSlotName): ModelCaps => {
    const s = slot(name);
    return { provider: s.provider, model: s.model, vision: s.provider === "anthropic" ? true : !!s.vision, ctx: s.ctx, mock: isMock(s) };
  };

  return {
    get mock() {
      return isMock(slot("chat"));
    },
    ollama,
    caps,
    select(next) {
      sel = next && next.chat?.model ? next : null;
    },
    selection: () => sel,
    async stream(system, history, onDelta, opts = {}) {
      const s = slot("chat");
      if (isMock(s)) return mock.stream(system, history, onDelta, opts);
      // wybór z UI wygrywa z modelem podanym przez wołającego (inaczej env z innego dostawcy trafiłby do złego API)
      const model = s.user ? s.model : (opts.model ?? s.model);
      if (s.provider === "ollama") return ollama.stream(model, system, history, onDelta, opts);
      return claude!.stream(system, history, onDelta, { ...opts, model });
    },
    async json<T>(system: string, history: Turn[], opts: JsonOptions = {}) {
      const s = slot("tools");
      if (isMock(s)) return mock.json<T>(system, history, opts);
      const model = s.user ? s.model : (opts.model ?? s.model);
      if (s.provider === "ollama") return ollama.json<T>(model, system, history, { ...opts, image: s.vision ? opts.image : undefined });
      return claude!.json<T>(system, history, { ...opts, model });
    },
  };
}

/** Anthropic (Messages API): cache promptu, myślenie wyłączone tam, gdzie się da. */
function anthropicLlm(cfg: LlmConfig, client: Anthropic): Pick<LlmAdapter, "stream" | "json"> {
  return {
    async stream(system, history, onDelta, opts = {}) {
      let text = "";
      const model = opts.model ?? cfg.chatModel;
      // rozmowa: domyślnie bez myślenia (szybszy start odpowiedzi, a myślenie nie zjada limitu tekstu);
      // QWE_CHAT_THINKING=1 → model myśli (adaptive), a limit dostaje zapas na myślenie
      const think = cfg.chatThinking ? { params: {}, extraTokens: 4000 } : noThinking(model);
      const s = client.messages.stream(
        {
          model,
          max_tokens: (opts.maxTokens ?? 1200) + think.extraTokens,
          ...(think.params as object),
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }, ...(opts.systemExtra ? [{ type: "text" as const, text: opts.systemExtra }] : [])],
          messages: toMessages(history, opts),
          stop_sequences: opts.stopSequences,
        },
        { signal: opts.signal },
      );
      s.on("text", (d) => {
        text += d;
        onDelta(d);
      });
      const final = await s.finalMessage();
      return { text, stopReason: final.stop_reason, usage: usageOf(final.usage) };
    },
    async json(system, history, opts = {}) {
      const messages = toMessages(history, {});
      if (opts.image && messages.length) {
        const last = messages[messages.length - 1];
        last.content = [mediaBlock({ kind: "image", data: opts.image.data, mime: opts.image.mime }), ...(last.content as Anthropic.ContentBlockParam[])];
      }
      const model = opts.model ?? cfg.executorModel;
      const quiet = noThinking(model);
      const res = await client.messages.create(
        {
          model,
          max_tokens: (opts.maxTokens ?? 600) + quiet.extraTokens,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: messages as Anthropic.MessageParam[],
          ...(quiet.params as object),
        },
        { signal: opts.signal },
      );
      const raw = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!raw.trim()) throw new Error(`pusta odpowiedź modelu ${model} (stop: ${res.stop_reason}${res.stop_reason === "max_tokens" ? " — limit tokenów zjadło myślenie" : ""})`);
      return { value: extractJson(raw), raw, usage: usageOf(res.usage) };
    },
  };
}

/**
 * Krótkie zadania JSON (pamięć, streszczenia, executor) nie potrzebują myślenia — a na nowszych modelach jest ono domyślnie
 * włączone i zjada `max_tokens` (np. Haiku 5.5: 400 tokenów na myślenie → pusta odpowiedź). Każda rodzina wyłącza je inaczej:
 *   Opus 5.5 / Fable — nie da się wyłączyć → effort low + zapas tokenów
 *   Sonnet 5.5       — `disabled` to 400 → `between_tools` (bez myślenia poza narzędziami)
 *   reszta (Haiku, Sonnet 5, Opus ≤5, 4.x) — `disabled`
 */
function noThinking(model: string): { params: Record<string, unknown>; extraTokens: number } {
  if (/opus-5-5|fable|mythos/.test(model)) return { params: { output_config: { effort: "low" } }, extraTokens: 3000 };
  if (/sonnet-5-5/.test(model)) return { params: { thinking: { type: "between_tools" } }, extraTokens: 0 };
  return { params: { thinking: { type: "disabled" } }, extraTokens: 0 };
}

function usageOf(u: Anthropic.Usage | undefined): LlmUsage {
  return { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 };
}

/** Plik → blok API: obraz (base64) albo dokument PDF. */
function mediaBlock(m: Media): Anthropic.ContentBlockParam {
  if (m.kind === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: m.data.toString("base64") }, ...(m.name ? { title: m.name } : {}) };
  return { type: "image", source: { type: "base64", media_type: m.mime as "image/png", data: m.data.toString("base64") } };
}

/** Historia → wiadomości API: kawałki jako osobne bloki (pliki jako obraz/dokument), cache_control na ostatnim bloku historii, `tail` za nim. */
export function toMessages(history: Turn[], opts: StreamOptions): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = history.map((t) => {
    const parts = (t.parts?.length ? t.parts : [t.content]).filter((p) => typeof p !== "string" || p.trim());
    return { role: t.role, content: parts.map((p) => (typeof p === "string" ? { type: "text" as const, text: p } : mediaBlock(p))) };
  });
  const last = msgs[msgs.length - 1];
  if (opts.cacheHistory && last && Array.isArray(last.content) && last.content.length) {
    const blocks = last.content as (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  }
  if (opts.tail) {
    if (last && last.role === "user") (last.content as Anthropic.TextBlockParam[]).push({ type: "text", text: opts.tail });
    else msgs.push({ role: "user", content: [{ type: "text", text: opts.tail }] });
  }
  return msgs;
}

/** Wyciąga pierwszy obiekt JSON z tekstu (model lubi dopisać zdanie albo ```json). Liczenie nawiasów, nie regex. */
export function extractJson<T = unknown>(raw: string): T {
  const s = raw.replace(/```(?:json)?/g, "");
  const start = s.indexOf("{");
  if (start === -1) throw new Error(`brak JSON w odpowiedzi: ${raw.slice(0, 120)}`);
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1)) as T;
    }
  }
  // ucięty (max_tokens): domknij ostatni string i obiekt — lepszy częściowy obiekt niż błąd
  const whole = s.slice(start).trimEnd();
  const cut = whole.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
  // najpierw domknij urwany string (zachowuje częściową treść), dopiero potem wytnij urwane pole
  for (const [base, tail] of [[whole, '"}'], [whole, "}"], [whole, '…"}'], [cut, '"}'], [cut, "}"], [cut, '"]}'], [cut, "]}"]] as const) {
    try {
      return JSON.parse(base + tail) as T;
    } catch {
      /* następna próba */
    }
  }
  throw new Error(`niedomknięty JSON: ${raw.slice(0, 120)}`);
}

/**
 * --mock: skrypt bez API. Każde pytanie z "?" / "szukaj" / "sprawdź" → web.query; "wejdź"/"otwórz"/"komputer" → computer.run;
 * "plan"/"i potem" → plan (search → computer). Po <nativeresult> → podsumowuje. Delty słowo po słowie, żeby TTS/UI dostały strumień.
 */
function mockLlm(over: Partial<Pick<LlmAdapter, "stream" | "json">> = {}): Pick<LlmAdapter, "stream" | "json"> {
  return {
    stream:
      over.stream ??
      (async (_system, history, onDelta) => {
        const whole = history[history.length - 1]?.content ?? "";
        // tura usera może być sklejona z wypowiedziami innych simów („@x: …”) — mock patrzy na ostatni akapit
        const last = whole.includes("<nativeresult") ? whole : (whole.split(/\n\n+/).pop() ?? whole).replace(/^@[a-z0-9-]+:\s*/i, "").replace(/@[a-z0-9-]+\.[a-z]+/gi, "").trim();
        let text: string;
        if (last.includes("<nativeresult")) {
          const mem = /name="memory\.search"[^>]*>\s*([\s\S]{0,300})/.exec(last);
          const m = /name="computer\.run"[^>]*>\s*([\s\S]{0,220})/.exec(last);
          text = mem ? `Pamiętam: ${mem[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : m ? `Zrobione. ${m[1].split("\n")[0].trim()} Pytaj dalej.` : "Mam. Z tego, co znalazłem, wynika, że to tryb testowy, więc nic prawdziwego nie wiem, ale strumień działa jak trzeba.";
        } else if (/ostatnio|wcześniej|pamiętasz|mówiliśmy|rozmawialiśmy/i.test(last)) {
          const q = last.replace(/[?.!,]/g, "").replace(/\b(pamiętasz|ostatnio|wcześniej|mówiliśmy|rozmawialiśmy|o|co|jak)\b/gi, "").trim().slice(0, 60);
          text = `Chwila, przypomnę sobie.\n<nativeapi>\n  <memory.search>${q}</memory.search>\n</nativeapi>`;
        } else if (/zapamiętaj jak|zapamietaj jak|następnym razem/i.test(last)) {
          text = `Jasne, zapisuję to sobie jako workflow.\n<nativeapi>\n  <skill.save name="mock-workflow" description="skill testowy z mocka">1. Wejdź na stronę.\n2. Kliknij to, co trzeba.\n3. Przed wysłaniem zapytaj Kacpra.</skill.save>\n</nativeapi>`;
        } else if (/plan|potem|a następnie/i.test(last)) {
          const q = last.replace(/[?.!]/g, "").trim().slice(0, 60) || "qwe";
          text = `Dobra, najpierw poszukam, potem wejdę na stronę.\n<nativeapi>\n  <plan>\n    <web.query id="s1">${q}</web.query>\n    <computer.run id="c1" after="s1">Otwórz pierwszy znaleziony adres i powiedz, co jest na stronie.</computer.run>\n  </plan>\n</nativeapi>`;
        } else if (/wejdź|otwórz|komputer|kliknij|zaloguj|przeglądark/i.test(last)) {
          text = `Jasne, biorę komputer.\n<nativeapi>\n  <computer.run>${last.trim()}</computer.run>\n</nativeapi>`;
        } else if (/\?|szukaj|sprawd|co to|kto to|ile/i.test(last)) {
          const q = last.replace(/[?.!]/g, "").trim().slice(0, 60) || "qwe";
          text = `Spoko, zaraz sprawdzę ${q.toLowerCase()}, chwila.\n<nativeapi>\n  <web.query>${q}</web.query>\n</nativeapi>`;
        } else {
          text = `Słyszę: ${last}. Tryb mock, więc odpowiadam na sucho, ale za to natychmiast.`;
        }
        for (const w of text.split(/(?<=\s)/)) {
          onDelta(w);
          await new Promise((r) => setTimeout(r, 25));
        }
        return { text: text.replace("</nativeapi>", ""), stopReason: text.includes("<nativeapi>") ? "stop_sequence" : "end_turn", usage: { input: 0, output: 0 } };
      }),
    json:
      over.json ??
      (async () => {
        throw new Error("mock llm: json() bez skryptu — capability w trybie mock powinna używać własnego mocka");
      }),
  };
}
