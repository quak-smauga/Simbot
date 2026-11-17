// AGENT RUNTIME — Execution Engine: direct execution albo plan execution, capabilities z rejestru,
// lifecycle tasków (queued → running → waiting_user/paused → succeeded|failed|cancelled), eventy do store.
// Taski z różnych sesji biegną równolegle; to capability (np. computer) pilnuje własnych zasobów (lock przeglądarki).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryEventStore,
  executePlan,
  newId,
  type AgentEvent,
  type CapabilityDescriptor,
  type LoadedCapability,
  type NativeBlock,
  type NativeCall,
  type PlanStep,
  type ToolCallContext,
  type ToolResult,
  type WaitReason,
} from "@qwe/core";

export type TaskState = "queued" | "running" | "waiting_user" | "paused" | "succeeded" | "failed" | "cancelled";

export interface ResultPart {
  name: string;
  stepId?: string;
  ok: boolean;
  status?: string;
  text: string;
  data?: unknown;
}

export interface Task {
  id: string;
  sessionId?: string;
  /** Bot, który zlecił task — narzędzia piszące do folderu bota (skille, pamięć) korzystają z tego. */
  agent?: string;
  kind: "direct" | "plan";
  block: NativeBlock;
  state: TaskState;
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  waiting?: { reason: WaitReason; message: string; meta?: Record<string, unknown>; since: string };
  result?: { ok: boolean; parts: ResultPart[] };
  error?: string;
}

interface Control {
  abort: AbortController;
  paused: boolean;
  /** resolve = wznów, reject = anuluj */
  waiters: { resolve: () => void; reject: (e: Error) => void }[];
}

export class Screenshots {
  private dir: string;
  private index = new Map<string, { file: string; mime: string; at: number }>();
  constructor(dataDir: string, private max = 400) {
    this.dir = join(dataDir, "screenshots");
    mkdirSync(this.dir, { recursive: true });
  }
  put(buf: Buffer, mime = "image/jpeg"): string {
    const id = newId("shot");
    const file = join(this.dir, `${id}.${mime === "image/png" ? "png" : "jpg"}`);
    writeFileSync(file, buf);
    this.index.set(id, { file, mime, at: Date.now() });
    if (this.index.size > this.max) {
      const oldest = this.index.keys().next().value!;
      this.index.delete(oldest);
    }
    return id;
  }
  get(id: string): { buf: Buffer; mime: string } | null {
    const e = this.index.get(id);
    if (e && existsSync(e.file)) return { buf: readFileSync(e.file), mime: e.mime };
    // po restarcie: szukamy na dysku
    for (const ext of ["jpg", "png"]) {
      const f = join(this.dir, `${id}.${ext}`);
      if (/^[\w]+$/.test(id) && existsSync(f)) return { buf: readFileSync(f), mime: ext === "png" ? "image/png" : "image/jpeg" };
    }
    return null;
  }
}

export interface RuntimeOptions {
  identity: { name: string; version: string; description?: string; instanceId: string; buildHash?: string };
  capabilities: LoadedCapability[];
  dataDir: string;
  log(level: "info" | "warn" | "error", message: string): void;
  /** Narzędzia, których nie ma w rejestrze capability, bo powstają w trakcie (serwery MCP: mcp.<serwer>.<narzędzie>). */
  dynamicTool?(name: string): LoadedCapability["tools"][string] | undefined;
  dynamicToolNames?(): string[];
}

export class AgentRuntime {
  readonly events: MemoryEventStore;
  readonly screenshots: Screenshots;
  readonly startedAt = new Date().toISOString();
  private tasks = new Map<string, Task>();
  private controls = new Map<string, Control>();
  private tools = new Map<string, { fn: LoadedCapability["tools"][string]; cap: string }>();

  constructor(readonly opts: RuntimeOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    const logFile = join(opts.dataDir, "agent-events.jsonl");
    this.events = new MemoryEventStore(5000, (e) => appendFileSync(logFile, JSON.stringify(e) + "\n"));
    this.screenshots = new Screenshots(opts.dataDir);
    for (const c of opts.capabilities) for (const [name, fn] of Object.entries(c.tools)) this.tools.set(name, { fn, cap: c.descriptor.name });
    this.events.append({ type: "agent.booted", data: { name: opts.identity.name, tools: [...this.tools.keys()] } });
  }

  descriptors(): CapabilityDescriptor[] {
    return this.opts.capabilities.map((c) => c.descriptor);
  }
  toolNames(): string[] {
    return [...this.tools.keys(), ...(this.opts.dynamicToolNames?.() ?? [])];
  }
  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  stats() {
    const s = { queued: 0, running: 0, waiting_user: 0, paused: 0, done: 0 };
    for (const t of this.tasks.values()) {
      if (t.state === "queued") s.queued++;
      else if (t.state === "running") s.running++;
      else if (t.state === "waiting_user") s.waiting_user++;
      else if (t.state === "paused") s.paused++;
      else s.done++;
    }
    return s;
  }

  // ───────── submit / lifecycle ─────────

  submit(block: NativeBlock, meta: { sessionId?: string; requestedBy?: string; agent?: string } = {}): Task {
    const task: Task = {
      id: newId("task"),
      sessionId: meta.sessionId,
      agent: meta.agent,
      kind: block.kind,
      block,
      state: "queued",
      requestedBy: meta.requestedBy ?? "human",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    this.controls.set(task.id, { abort: new AbortController(), paused: false, waiters: [] });
    this.emit(task, "task.enqueued", { kind: block.kind, agent: task.agent, calls: block.kind === "direct" ? block.calls.map((c) => c.name) : block.steps.map((s) => `${s.id}:${s.name}`) });
    queueMicrotask(() => void this.run(task));
    return task;
  }

  cancel(id: string): Task | undefined {
    const t = this.tasks.get(id);
    const c = this.controls.get(id);
    if (!t || !c) return t;
    if (["succeeded", "failed", "cancelled"].includes(t.state)) return t;
    c.abort.abort();
    for (const w of c.waiters.splice(0)) w.reject(new Error("anulowano"));
    return t;
  }
  pause(id: string): Task | undefined {
    const t = this.tasks.get(id);
    const c = this.controls.get(id);
    if (!t || !c || t.state !== "running") return t;
    c.paused = true;
    this.setState(t, "paused");
    this.emit(t, "task.paused", {});
    return t;
  }
  resume(id: string): Task | undefined {
    const t = this.tasks.get(id);
    const c = this.controls.get(id);
    if (!t || !c) return t;
    if (t.state !== "waiting_user" && t.state !== "paused") return t;
    const after = t.state === "waiting_user" ? t.waiting?.reason : "PAUSED";
    c.paused = false;
    t.waiting = undefined;
    this.setState(t, "running");
    this.emit(t, "task.resumed", { after });
    for (const w of c.waiters.splice(0)) w.resolve();
    return t;
  }

  private setState(t: Task, s: TaskState) {
    t.state = s;
  }
  private emit(t: Task, type: string, data: Record<string, unknown>, extra: { stepId?: string; planId?: string } = {}): AgentEvent {
    return this.events.append({ type, taskId: t.id, sessionId: t.sessionId, ...extra, data });
  }

  // ───────── execution ─────────

  private async run(task: Task) {
    const c = this.controls.get(task.id)!;
    task.startedAt = new Date().toISOString();
    this.setState(task, "running");
    this.emit(task, "task.started", { kind: task.kind });
    try {
      const parts = task.kind === "direct" ? await this.runDirect(task, task.block.kind === "direct" ? task.block.calls : [], c) : await this.runPlan(task, task.block.kind === "plan" ? task.block.steps : [], c);
      const view = parts.map((p) => ({ name: p.name, stepId: p.stepId, ok: p.ok, status: p.status, text: p.text.slice(0, 400), data: p.data }));
      if (c.abort.signal.aborted) {
        // anulowane przez usera, ale narzędzia oddały raport (co zdążyły zrobić) — wynik zostaje, stan = cancelled
        task.result = { ok: false, parts };
        this.setState(task, "cancelled");
        task.error = "anulowane przez usera";
        this.emit(task, "task.cancelled", { parts: view });
        return;
      }
      const ok = parts.every((p) => p.ok);
      task.result = { ok, parts };
      this.setState(task, "succeeded");
      this.emit(task, "task.succeeded", { ok, parts: view });
    } catch (e) {
      const msg = (e as Error).message;
      if (c.abort.signal.aborted || /anulowano/.test(msg)) {
        this.setState(task, "cancelled");
        task.error = "anulowano";
        this.emit(task, "task.cancelled", {});
      } else {
        this.setState(task, "failed");
        task.error = msg;
        this.emit(task, "task.failed", { error: msg });
        this.opts.log("error", `[task ${task.id}] ${msg}`);
      }
    } finally {
      task.finishedAt = new Date().toISOString();
      this.controls.delete(task.id);
    }
  }

  private callContext(task: Task, c: Control, extra: { stepId?: string; planId?: string }, prior: Record<string, ToolResult>): ToolCallContext {
    const rt = this;
    return {
      taskId: task.id,
      sessionId: task.sessionId,
      agent: task.agent,
      stepId: extra.stepId,
      planId: extra.planId,
      signal: c.abort.signal,
      priorResults: prior,
      screenshots: rt.screenshots,
      emit: (type, data = {}) => rt.emit(task, type, data, extra),
      async checkpoint() {
        if (c.abort.signal.aborted) throw new Error("anulowano");
        if (!c.paused) return;
        await new Promise<void>((resolve, reject) => c.waiters.push({ resolve, reject }));
      },
      async waitForUser(reason, message, meta) {
        if (c.abort.signal.aborted) throw new Error("anulowano");
        task.waiting = { reason, message, meta, since: new Date().toISOString() };
        rt.setState(task, "waiting_user");
        rt.emit(task, "task.waiting", { reason, message, ...(meta ?? {}) }, extra);
        await new Promise<void>((resolve, reject) => c.waiters.push({ resolve, reject }));
      },
    };
  }

  private async invoke(task: Task, c: Control, call: NativeCall, extra: { stepId?: string; planId?: string }, prior: Record<string, ToolResult>): Promise<ToolResult> {
    const dynamic = this.tools.has(call.name) ? undefined : this.opts.dynamicTool?.(call.name);
    const tool = this.tools.get(call.name) ?? (dynamic ? { fn: dynamic, cap: "mcp" } : undefined);
    if (!tool) return { ok: false, text: `Nieznane narzędzie "${call.name}". Dostępne: ${this.toolNames().join(", ")}` };
    const t0 = Date.now();
    this.emit(task, "tool.call", { name: call.name, args: call.args }, extra);
    try {
      const r = await tool.fn(call.args, this.callContext(task, c, extra, prior));
      this.emit(task, "tool.result", { name: call.name, ok: r.ok, status: r.status, ms: Date.now() - t0, data: r.data }, extra);
      return r;
    } catch (e) {
      if (c.abort.signal.aborted) throw e;
      const text = `Błąd narzędzia ${call.name}: ${(e as Error).message}`;
      this.emit(task, "tool.result", { name: call.name, ok: false, ms: Date.now() - t0, error: (e as Error).message }, extra);
      return { ok: false, text };
    }
  }

  private async runDirect(task: Task, calls: NativeCall[], c: Control): Promise<ResultPart[]> {
    const parts: ResultPart[] = [];
    for (const call of calls) {
      if (c.abort.signal.aborted) break;
      const r = await this.invoke(task, c, call, {}, {});
      parts.push({ name: call.name, ok: r.ok, status: r.status, text: r.text, data: r.data });
    }
    return parts;
  }

  private async runPlan(task: Task, steps: PlanStep[], c: Control): Promise<ResultPart[]> {
    const planId = newId("plan");
    const results = await executePlan({
      steps,
      signal: c.abort.signal,
      emit: (type, data) => void this.emit(task, type, data, { planId, stepId: (data as { stepId?: string }).stepId }),
      run: (step, prior) => this.invoke(task, c, step, { planId, stepId: step.id }, prior),
    });
    return results.map((r) => ({
      name: r.name,
      stepId: r.stepId,
      ok: r.status === "completed",
      status: r.result?.status && r.result.status !== "ok" ? r.result.status : r.status,
      text: r.result?.text ?? r.error ?? "",
      data: r.result?.data,
    }));
  }
}
