// OLLAMA — lokalne modele po HTTP (domyślnie http://127.0.0.1:11434). Adapter z tym samym interfejsem co Anthropic
// (stream dla rozmowy, json dla zadań) + pomocnicze: status, lista modeli z capabilities, pobieranie modelu, start serwera.
//   GET  /api/version  — czy działa
//   GET  /api/tags     — zainstalowane modele
//   POST /api/show     — capabilities (completion, vision, thinking, tools…) i context_length
//   POST /api/pull     — pobranie modelu (NDJSON z postępem)
//   POST /api/chat     — rozmowa (stream NDJSON albo jedna odpowiedź)
// Ważne: Ollama domyślnie daje mały kontekst (num_ctx) i po cichu ucina prompt — zawsze ustawiamy num_ctx.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extractJson, type JsonOptions, type LlmUsage, type Media, type StreamOptions, type Turn } from "./llm.js";

export interface OllamaModel {
  /** Nazwa z tagiem, np. gemma3:latest */
  id: string;
  size: number;
  params?: string;
  family?: string;
  vision: boolean;
  thinking: boolean;
  /** Maks. kontekst modelu (z /api/show). */
  ctx?: number;
}

export interface OllamaStatus {
  url: string;
  installed: boolean;
  running: boolean;
  version?: string;
}

const showCache = new Map<string, { capabilities: string[]; ctx?: number }>();

export class OllamaClient {
  constructor(
    readonly url = "http://127.0.0.1:11434",
    /** Górny limit num_ctx (więcej = więcej RAM). Model z mniejszym kontekstem dostaje swój. */
    readonly maxCtx = 16384,
  ) {}

  async status(): Promise<OllamaStatus> {
    try {
      const r = await fetch(`${this.url}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { url: this.url, installed: true, running: true, version: ((await r.json()) as { version?: string }).version };
    } catch {
      /* nie działa */
    }
    return { url: this.url, installed: ollamaInstalled(), running: false };
  }

  /** capabilities + context_length jednego modelu (cache w procesie — model się nie zmienia, dopóki go nie podmienisz). */
  async show(model: string): Promise<{ capabilities: string[]; ctx?: number }> {
    const hit = showCache.get(model);
    if (hit) return hit;
    const r = await fetch(`${this.url}/api/show`, { method: "POST", body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`ollama: nie znam modelu ${model} (${r.status})`);
    const j = (await r.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
    const ctxEntry = Object.entries(j.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
    const v = { capabilities: j.capabilities ?? ["completion"], ctx: ctxEntry ? Number(ctxEntry[1]) : undefined };
    showCache.set(model, v);
    return v;
  }

  async models(): Promise<OllamaModel[]> {
    const r = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`ollama: /api/tags ${r.status}`);
    const j = (await r.json()) as { models?: { name: string; size: number; details?: { parameter_size?: string; family?: string } }[] };
    return Promise.all(
      (j.models ?? []).map(async (m) => {
        const s = await this.show(m.name).catch(() => ({ capabilities: [] as string[], ctx: undefined }));
        return { id: m.name, size: m.size, params: m.details?.parameter_size, family: m.details?.family, vision: s.capabilities.includes("vision"), thinking: s.capabilities.includes("thinking"), ctx: s.ctx };
      }),
    );
  }

  /** Pobranie modelu. onProgress dostaje kolejne linie statusu Ollamy (status, total, completed). */
  async pull(model: string, onProgress: (p: { status: string; total?: number; completed?: number }) => void, signal?: AbortSignal): Promise<void> {
    const r = await fetch(`${this.url}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }), signal });
    if (!r.ok || !r.body) throw new Error(`ollama: pull ${model} → ${r.status} ${await r.text().catch(() => "")}`);
    for await (const line of ndjson(r.body)) {
      const p = line as { status?: string; total?: number; completed?: number; error?: string };
      if (p.error) throw new Error(`ollama: ${p.error}`);
      onProgress({ status: p.status ?? "", total: p.total, completed: p.completed });
    }
    showCache.delete(model);
  }

  /** Start serwera: na macu aplikacja Ollama (pasek menu), inaczej `ollama serve` w tle. Czeka, aż odpowie (do 15 s). */
  async start(): Promise<OllamaStatus> {
    const s = await this.status();
    if (s.running) return s;
    if (!s.installed) throw new Error("Ollama nie jest zainstalowana — pobierz z https://ollama.com/download");
    const app = process.platform === "darwin" && existsSync("/Applications/Ollama.app");
    const child = app ? spawn("open", ["-a", "Ollama"], { detached: true, stdio: "ignore" }) : spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 400));
      const now = await this.status();
      if (now.running) return now;
    }
    throw new Error("Ollama nie wstała w 15 s");
  }

  /** POST z czytelnym błędem, gdy serwer nie działa (zamiast gołego „fetch failed”). */
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, { method: "POST", body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(`Ollama nie odpowiada pod ${this.url} — uruchom ją (przycisk modelu → Uruchom)`);
    }
  }

  private async options(model: string, maxTokens: number, stop?: string[]) {
    const s = await this.show(model).catch(async (e: Error) => {
      if ((await this.status()).running) throw e;
      throw new Error(`Ollama nie odpowiada pod ${this.url} — uruchom ją (przycisk modelu → Uruchom)`);
    });
    return {
      think: s.capabilities.includes("thinking") ? { think: false } : {},
      options: { num_ctx: Math.min(s.ctx ?? this.maxCtx, this.maxCtx), num_predict: maxTokens, ...(stop?.length ? { stop } : {}) },
    };
  }

  async stream(model: string, system: string, history: Turn[], onDelta: (d: string) => void, opts: StreamOptions = {}): Promise<{ text: string; stopReason: string | null; usage: LlmUsage }> {
    const o = await this.options(model, opts.maxTokens ?? 1200, opts.stopSequences);
    const messages = toOllamaMessages([system, opts.systemExtra].filter(Boolean).join("\n\n"), history, opts.tail);
    const r = await this.post("/api/chat", { model, messages, stream: true, ...o.think, options: o.options }, opts.signal);
    if (!r.ok || !r.body) throw new Error(`ollama ${model}: ${r.status} ${await r.text().catch(() => "")}`);
    let text = "";
    let stopReason: string | null = null;
    const usage: LlmUsage = { input: 0, output: 0 };
    for await (const line of ndjson(r.body)) {
      const c = line as { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
      if (c.error) throw new Error(`ollama ${model}: ${c.error}`);
      const d = c.message?.content ?? "";
      if (d) {
        text += d;
        onDelta(d);
      }
      if (c.done) {
        stopReason = c.done_reason === "length" ? "max_tokens" : "end_turn";
        usage.input = c.prompt_eval_count ?? 0;
        usage.output = c.eval_count ?? 0;
      }
    }
    return { text, stopReason, usage };
  }

  async json<T>(model: string, system: string, history: Turn[], opts: JsonOptions = {}): Promise<{ value: T; raw: string; usage: LlmUsage }> {
    const o = await this.options(model, opts.maxTokens ?? 600);
    const h = history.map((t) => ({ ...t }));
    if (opts.image && h.length) h[h.length - 1].parts = [{ kind: "image", data: opts.image.data, mime: opts.image.mime }, t2s(h[h.length - 1])];
    const messages = toOllamaMessages(system, h);
    const r = await this.post("/api/chat", { model, messages, stream: false, format: "json", ...o.think, options: o.options }, opts.signal);
    if (!r.ok) throw new Error(`ollama ${model}: ${r.status} ${await r.text().catch(() => "")}`);
    const j = (await r.json()) as { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    const raw = j.message?.content ?? "";
    if (!raw.trim()) throw new Error(`pusta odpowiedź modelu ${model} (stop: ${j.done_reason})`);
    return { value: extractJson<T>(raw), raw, usage: { input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 } };
  }
}

const t2s = (t: Turn) => t.content;

/** Historia → wiadomości Ollamy: tekst sklejony, obrazy w `images` (base64). PDF-ów Ollama nie czyta — zostaje notka. */
export function toOllamaMessages(system: string, history: Turn[], tail?: string) {
  const msgs: { role: string; content: string; images?: string[] }[] = [{ role: "system", content: system }];
  for (const t of history) {
    const parts = t.parts?.length ? t.parts : [t.content];
    const text: string[] = [];
    const images: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        if (p.trim()) text.push(p);
      } else if (p.kind === "image") images.push(p.data.toString("base64"));
      else text.push(`[${mediaLabel(p)} — ten model nie czyta PDF bezpośrednio]`);
    }
    msgs.push({ role: t.role, content: text.join("\n\n"), ...(images.length ? { images } : {}) });
  }
  if (tail) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user") last.content += "\n\n" + tail;
    else msgs.push({ role: "user", content: tail });
  }
  return msgs;
}

const mediaLabel = (m: Media) => (m.name ? `plik ${m.name}` : m.kind);

/** Czy binarka ollama jest na maszynie (bez uruchamiania). */
export function ollamaInstalled(): boolean {
  if (process.platform === "darwin" && existsSync("/Applications/Ollama.app")) return true;
  const dirs = (process.env.PATH ?? "").split(":").concat(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"]);
  return dirs.some((d) => d && existsSync(`${d}/ollama`));
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}
