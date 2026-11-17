// MCP CLIENT — JSON-RPC 2.0 do jednego serwera Model Context Protocol. Zero zależności.
//   stdio            serwer jako podproces: jedna wiadomość JSON na linię (stdin/stdout), stderr = logi serwera
//   Streamable HTTP  POST na jeden endpoint; odpowiedź to JSON albo strumień SSE; sesja w nagłówku Mcp-Session-Id
// Handshake: initialize → notifications/initialized. Potem tools/*, resources/*, prompts/*.
// Czego tu NIE ma: OAuth, starego transportu HTTP+SSE (dwa endpointy), sampling/elicitation (serwer → model/user).
import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "@qwe/core";

export const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}
/** Serwer HTTP zapomniał sesji (404) — trzeba zrobić initialize od nowa. */
class SessionExpired extends Error {}

export interface McpClientOptions {
  name: string;
  config: McpServerConfig;
  /** Katalog roboczy podprocesu, gdy config.cwd nie jest podany. */
  cwd: string;
  clientInfo: { name: string; version: string };
  log(level: "info" | "warn" | "error", message: string): void;
  /** Linia ze stderr serwera stdio (jego własne logi — bywają kolorowe). */
  onStderr?(line: string): void;
  onNotification?(method: string, params: Json): void;
  /** Połączenie padło samo (proces się zakończył). Nie woła się po close(). */
  onClose?(reason: string): void;
}

export interface InitializeResult {
  protocolVersion?: string;
  capabilities?: { tools?: Json; resources?: Json; prompts?: Json; [k: string]: unknown };
  serverInfo?: { name?: string; title?: string; version?: string };
  instructions?: string;
}

interface Pending {
  resolve(v: Json): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

export class McpClient {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  private negotiated: string | null = null;
  private closed = false;
  private streams = new Set<AbortController>();
  init: InitializeResult | null = null;

  constructor(private o: McpClientOptions) {}

  get transport(): "stdio" | "http" {
    return this.o.config.url ? "http" : "stdio";
  }
  get alive(): boolean {
    return !this.closed && !!this.init && (this.transport === "http" || !!this.child);
  }

  // ───────── lifecycle ─────────

  async connect(timeoutMs = 15000): Promise<InitializeResult> {
    this.closed = false;
    if (this.transport === "stdio") await this.spawnChild();
    const init = (await this.rawRequest("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.o.clientInfo }, { timeoutMs })) as InitializeResult;
    this.negotiated = typeof init.protocolVersion === "string" ? init.protocolVersion : PROTOCOL_VERSION;
    this.init = init;
    await this.notify("notifications/initialized");
    return init;
  }

  async close() {
    this.closed = true;
    this.failAll(new McpError("połączenie zamknięte"));
    for (const s of this.streams) s.abort();
    this.streams.clear();
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.stdin?.end();
      const t = setTimeout(() => c.kill("SIGTERM"), 1200);
      c.once("exit", () => clearTimeout(t));
    } else if (this.o.config.url && this.sessionId) {
      // grzecznie kończymy sesję; serwer może tego nie obsługiwać (405) — bez znaczenia
      await fetch(this.o.config.url, { method: "DELETE", headers: this.httpHeaders(), signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
    this.sessionId = null;
    this.init = null;
  }

  // ───────── API ─────────

  /** Żądanie z odpowiedzią. Sesja HTTP wygasła → jeden ponowny handshake i powtórka. */
  async request(method: string, params: Json = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Json> {
    try {
      return await this.rawRequest(method, params, opts);
    } catch (e) {
      if (!(e instanceof SessionExpired) || this.closed) throw e;
      this.o.log("info", `[mcp:${this.o.name}] sesja wygasła — łączę ponownie`);
      this.sessionId = null;
      await this.connect();
      return this.rawRequest(method, params, opts);
    }
  }

  /** Lista z paginacją (tools/list, resources/list, prompts/list). */
  async list<T>(method: string, key: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.request(method, cursor ? { cursor } : {});
      if (Array.isArray(r[key])) out.push(...(r[key] as T[]));
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  // ───────── JSON-RPC ─────────

  private rawRequest(method: string, params: Json, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<Json> {
    const id = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<Json>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new McpError("anulowano"));
      const done = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        done();
        void this.notify("notifications/cancelled", { requestId: id, reason: "anulowane przez użytkownika" }).catch(() => {});
        reject(new McpError("anulowano"));
      };
      const timer = setTimeout(() => {
        done();
        void this.notify("notifications/cancelled", { requestId: id, reason: "timeout" }).catch(() => {});
        reject(new McpError(`brak odpowiedzi na ${method} w ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { method, timer, resolve: (v) => (done(), resolve(v)), reject: (e) => (done(), reject(e)) });
      this.send({ jsonrpc: "2.0", id, method, params }, [id]).catch((e: Error) => this.pending.get(id)?.reject(e));
    });
  }

  private notify(method: string, params?: Json): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, []);
  }

  private onMessage(m: RpcMessage) {
    if (!m || m.jsonrpc !== "2.0") return;
    // odpowiedź na nasze żądanie
    if (m.method === undefined && m.id !== undefined && m.id !== null) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      if (m.error) p.reject(new McpError(m.error.message || `błąd ${m.error.code}`, m.error.code));
      else p.resolve((m.result ?? {}) as Json);
      return;
    }
    if (typeof m.method !== "string") return;
    // żądanie od serwera: ping obsługujemy, reszty (sampling, roots, elicitation) nie deklarowaliśmy
    if (m.id !== undefined && m.id !== null) {
      const reply: RpcMessage = m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `klient nie obsługuje ${m.method}` } };
      void this.send(reply, []).catch(() => {});
      return;
    }
    this.o.onNotification?.(m.method, (m.params ?? {}) as Json);
  }

  private failAll(e: Error, ids?: number[]) {
    for (const [id, p] of [...this.pending]) if (!ids || ids.includes(id)) p.reject(e);
  }

  private send(msg: RpcMessage, ids: number[]): Promise<void> {
    return this.transport === "stdio" ? this.sendStdio(msg) : this.sendHttp(msg, ids);
  }

  // ───────── stdio ─────────

  private spawnChild(): Promise<void> {
    const c = this.o.config;
    // „node” = ten sam node, na którym działa agent (w spakowanej aplikacji node nie musi być w PATH)
    const cmd = c.command === "node" ? process.execPath : c.command!;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(cmd, c.args ?? [], { cwd: c.cwd || this.o.cwd, env: { ...process.env, ...(c.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (e: NodeJS.ErrnoException) => {
        const msg = e.code === "ENOENT" ? `nie znaleziono polecenia „${c.command}”` : e.message;
        if (!settled) {
          settled = true;
          this.child = null;
          reject(new McpError(msg));
        }
      });
      child.stdin!.on("error", () => {}); // EPIPE po śmierci procesu — obsłuży 'exit'
      const lines = (stream: NodeJS.ReadableStream, onLine: (l: string) => void) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (d: string) => {
          buf += d;
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            if (line.trim()) onLine(line);
          }
        });
      };
      lines(child.stdout!, (line) => {
        let m: RpcMessage | RpcMessage[];
        try {
          m = JSON.parse(line) as RpcMessage | RpcMessage[];
        } catch {
          return void this.o.log("warn", `[mcp:${this.o.name}] stdout nie jest JSON-em: ${line.slice(0, 120)}`);
        }
        for (const x of Array.isArray(m) ? m : [m]) this.onMessage(x);
      });
      lines(child.stderr!, (line) => this.o.onStderr?.(line));
      child.once("exit", (code, sig) => {
        if (this.child !== child) return; // close() albo nowszy proces
        this.child = null;
        this.init = null;
        const reason = `proces serwera zakończył się (${sig ?? code ?? "?"})`;
        this.failAll(new McpError(reason));
        if (!this.closed) this.o.onClose?.(reason);
      });
    });
  }

  private sendStdio(msg: RpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new McpError("serwer nie działa"));
    return new Promise((resolve, reject) => stdin.write(JSON.stringify(msg) + "\n", (e) => (e ? reject(new McpError(e.message)) : resolve())));
  }

  // ───────── Streamable HTTP ─────────

  private httpHeaders(): Record<string, string> {
    return {
      ...(this.o.config.headers ?? {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.negotiated ? { "mcp-protocol-version": this.negotiated } : {}),
    };
  }

  private async sendHttp(msg: RpcMessage, ids: number[]): Promise<void> {
    const ac = new AbortController();
    this.streams.add(ac);
    let res: Response;
    try {
      res = await fetch(this.o.config.url!, { method: "POST", headers: { ...this.httpHeaders(), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(msg), signal: ac.signal });
    } catch (e) {
      this.streams.delete(ac);
      const cause = ((e as Error).cause as { code?: string } | undefined)?.code;
      throw new McpError(`serwer nie odpowiada pod ${this.o.config.url} (${cause ?? (e as Error).message})`);
    }
    if (!res.ok) {
      this.streams.delete(ac);
      const body = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 404 && this.sessionId && msg.method !== "initialize") throw new SessionExpired("sesja wygasła");
      if (res.status === 401 || res.status === 403) throw new McpError(`serwer odmówił dostępu (HTTP ${res.status}) — sprawdź nagłówki autoryzacji`);
      // błąd JSON-RPC w treści odpowiedzi HTTP 4xx
      try {
        const j = JSON.parse(body) as RpcMessage;
        if (j?.error?.message) throw new McpError(j.error.message, j.error.code);
      } catch (e) {
        if (e instanceof McpError) throw e;
      }
      throw new McpError(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 202 || !res.body) {
      this.streams.delete(ac);
      return void res.body?.cancel().catch(() => {});
    }
    if (type.includes("text/event-stream")) {
      // odpowiedź jako strumień: czytamy w tle, żądanie rozwiąże się, gdy przyjdzie wiadomość z jego id
      void this.readSse(res.body, ids)
        .catch((e: Error) => !ac.signal.aborted && this.failAll(new McpError(`strumień odpowiedzi przerwany: ${e.message}`), ids))
        .finally(() => this.streams.delete(ac));
      return;
    }
    this.streams.delete(ac);
    const text = await res.text();
    if (!text.trim()) return;
    let m: RpcMessage | RpcMessage[];
    try {
      m = JSON.parse(text) as RpcMessage | RpcMessage[];
    } catch {
      throw new McpError(`odpowiedź serwera nie jest JSON-em (${type || "brak content-type"})`);
    }
    for (const x of Array.isArray(m) ? m : [m]) this.onMessage(x);
  }

  private async readSse(body: ReadableStream<Uint8Array>, ids: number[]) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        try {
          const m = JSON.parse(data) as RpcMessage | RpcMessage[];
          for (const x of Array.isArray(m) ? m : [m]) this.onMessage(x);
        } catch {
          this.o.log("warn", `[mcp:${this.o.name}] zdarzenie SSE nie jest JSON-em`);
        }
      }
    }
    // strumień się skończył, a odpowiedzi nie było
    this.failAll(new McpError("serwer zamknął strumień bez odpowiedzi"), ids);
  }
}
