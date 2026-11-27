// AGENT LINK — chat ↔ agent server. Chat + agent osobno: chat działa, agent WSTAJE dopiero po pierwszej akcji z chatu.
//   ensure()   — spawn procesu agenta (dev/host) albo tylko sprawdzenie /health (docker / QWE_AGENT_MODE=url)
//   submit()   — POST /api/tasks, czeka na terminalny event (task.succeeded|failed|cancelled), oddaje result
//   SSE        — jedno połączenie /api/events/stream na cały chat; eventy rozdzielane po sessionId do sesji
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, type AgentEvent, type LlmSelection, type NativeBlock } from "@qwe/core";

export interface AgentTaskResult {
  ok: boolean;
  state: string;
  parts: { name: string; stepId?: string; ok: boolean; status?: string; text: string; data?: unknown }[];
  error?: string;
}

export interface AgentLinkOptions {
  url: string;
  mode: "spawn" | "url";
  port: number;
  host: string;
  mock: boolean;
  dev: boolean; // uruchomieni przez tsx → agent też przez tsx
  onEvent(e: AgentEvent): void;
  /** Aktualny wybór modeli — agent dostaje go przy starcie (env) i po każdym połączeniu. */
  llm?: () => LlmSelection | null;
  log(level: "info" | "warn" | "error", message: string): void;
}

export class AgentLink {
  private child: ChildProcess | null = null;
  private childExit: number | null = null;
  private starting: Promise<void> | null = null;
  private sseAbort: AbortController | null = null;
  private lastSeq = 0;
  private waiters = new Map<string, { resolve: (r: AgentTaskResult) => void }>();
  status: "down" | "starting" | "up" = "down";

  constructor(private o: AgentLinkOptions) {}

  private async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.o.url}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Agent wstaje leniwie. Kolejne wywołania czekają na ten sam start. */
  ensure(): Promise<void> {
    if (this.status === "up") return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.status = "starting";
      if (await this.health()) return this.markUp();
      if (this.o.mode === "url") throw new Error(`agent nie odpowiada pod ${this.o.url} (QWE_AGENT_MODE=url — uruchom go: qwe agent / qwe run)`);
      this.spawnAgent();
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (await this.health()) return this.markUp();
        if (this.childExit !== null) throw new Error(`proces agenta zakończył się kodem ${this.childExit} (patrz log [agent!])`);
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("agent nie wstał w 30 s");
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  private markUp() {
    this.status = "up";
    this.o.log("info", `[agent] online: ${this.o.url}`);
    this.openStream();
    // agent mógł wstać sam (QWE_AGENT_MODE=url) albo przed zmianą w UI — wyrównaj wybór modeli
    void this.setLlm(this.o.llm?.() ?? null);
  }

  /** Wybór modeli → agent (jeśli żyje; jak nie, dostanie go przy starcie). */
  async setLlm(selection: LlmSelection | null) {
    if (this.status !== "up") return;
    try {
      await fetch(`${this.o.url}/api/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection }), signal: AbortSignal.timeout(3000) });
    } catch (e) {
      this.o.log("warn", `[agent] nie przekazałem wyboru modeli: ${(e as Error).message}`);
    }
  }

  private spawnAgent() {
    // chat uruchomiony z binarki Electrona (spakowana apka): process.execPath to Electron, nie node → tryb node
    const env = { ...process.env, QWE_AGENT_PORT: String(this.o.port), QWE_HOST: this.o.host, QWE_MOCK: this.o.mock ? "1" : "0", QWE_LLM: JSON.stringify(this.o.llm?.() ?? null), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
    const args = this.o.dev
      ? [fileURLToPath(import.meta.resolve("tsx/cli")), "--conditions=development", resolve(REPO_ROOT, "apps", "agent", "src", "index.ts")]
      : ["--no-warnings=ExperimentalWarning", resolve(REPO_ROOT, "apps", "agent", "dist", "index.js")];
    if (this.o.mock) args.push("--mock");
    this.o.log("info", `[agent] startuję proces: ${this.o.dev ? "tsx" : "node"} ${args[args.length - 1]}`);
    this.childExit = null;
    this.child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT });
    // prefiks na każdej linii (jeden chunk to często kilka linii, np. logi serwerów MCP)
    const tag = (prefix: string, d: unknown) => String(d).trimEnd().split("\n").map((l) => `  ${prefix} ${l}`).join("\n") + "\n";
    this.child.stdout?.on("data", (d) => process.stdout.write(tag("[agent]", d)));
    this.child.stderr?.on("data", (d) => process.stderr.write(tag("[agent!]", d)));
    this.child.on("exit", (code) => {
      this.o.log("warn", `[agent] proces zakończony (${code})`);
      this.childExit = code ?? 1;
      this.child = null;
      this.status = "down";
      this.sseAbort?.abort();
      for (const [, w] of this.waiters) w.resolve({ ok: false, state: "failed", parts: [], error: "agent padł" });
      this.waiters.clear();
    });
    const kill = () => this.child?.kill("SIGTERM");
    process.once("exit", kill);
    process.once("SIGINT", kill);
    process.once("SIGTERM", kill);
  }

  /** SSE: od lastSeq, z reconnectem. Eventy terminalne tasków budzą submit(). */
  private openStream() {
    this.sseAbort?.abort();
    const ac = new AbortController();
    this.sseAbort = ac;
    (async () => {
      let retry = 500;
      while (!ac.signal.aborted && this.status !== "down") {
        try {
          const res = await fetch(`${this.o.url}/api/events/stream?since=${this.lastSeq}`, { signal: ac.signal });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          retry = 500;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n");
              if (!data) continue;
              try {
                this.onAgentEvent(JSON.parse(data) as AgentEvent);
              } catch (e) {
                this.o.log("warn", `[agent] zły event: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          this.o.log("warn", `[agent] stream: ${(e as Error).message} — reconnect za ${retry}ms`);
          if (!(await this.health())) this.status = "down";
          await new Promise((r) => setTimeout(r, retry));
          retry = Math.min(8000, retry * 1.6);
        }
      }
    })();
  }

  private onAgentEvent(e: AgentEvent) {
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    this.o.onEvent(e);
    if (e.taskId && /^task\.(succeeded|failed|cancelled)$/.test(e.type)) {
      const w = this.waiters.get(e.taskId);
      if (!w) return;
      this.waiters.delete(e.taskId);
      void this.fetchResult(e.taskId).then(w.resolve);
    }
  }

  private async fetchResult(taskId: string): Promise<AgentTaskResult> {
    try {
      const r = await fetch(`${this.o.url}/api/tasks/${taskId}`);
      const t = (await r.json()) as { state: string; result?: { ok: boolean; parts: AgentTaskResult["parts"] }; error?: string };
      return { ok: t.state === "succeeded" && !!t.result?.ok, state: t.state, parts: t.result?.parts ?? [], error: t.error };
    } catch (e) {
      return { ok: false, state: "failed", parts: [], error: (e as Error).message };
    }
  }

  /** Wyślij blok (direct | plan) jako task i czekaj na wynik. `onTaskId` od razu po 202 (UI, komendy głosowe). */
  async submit(block: NativeBlock, sessionId: string, agent: string, onTaskId?: (taskId: string) => void): Promise<AgentTaskResult> {
    await this.ensure();
    const r = await fetch(`${this.o.url}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, agent, block, requestedBy: "chat" }) });
    if (r.status !== 202) throw new Error(`agent: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const { taskId } = (await r.json()) as { taskId: string };
    onTaskId?.(taskId);
    const done = new Promise<AgentTaskResult>((resolve) => this.waiters.set(taskId, { resolve }));
    // bezpiecznik: stream mógł zgubić event — po chwili sprawdzamy stan bezpośrednio
    const poll = (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 4000));
        if (!this.waiters.has(taskId)) return null;
        const res = await this.fetchResult(taskId);
        if (["succeeded", "failed", "cancelled"].includes(res.state)) {
          this.waiters.delete(taskId);
          return res;
        }
      }
    })();
    return (await Promise.race([done, poll.then((r) => r ?? done)])) as AgentTaskResult;
  }

  async control(taskId: string, op: "pause" | "resume" | "cancel"): Promise<{ state?: string; error?: string }> {
    try {
      const r = await fetch(`${this.o.url}/api/tasks/${taskId}/${op}`, { method: "POST" });
      return (await r.json()) as { state?: string; error?: string };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  screenshotUrl(id: string) {
    return `${this.o.url}/api/screenshots/${id}`;
  }
  get url() {
    return this.o.url;
  }
}
