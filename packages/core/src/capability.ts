// CAPABILITY — samodzielny plugin, który dostarcza możliwości. Zasada: capability ma własną implementację
// i własne zależności (deklaruje je); qwe ma lifecycle i wykonanie. Plugin nie instaluje niczego sam w runtime.
//
// Paczka/folder capability:
//   capability.yaml   — descriptor (name, version, description, dependencies, tools)
//   index.ts|js       — `export async function create(ctx: CapabilityContext): Promise<ToolMap>`
//
// Capability nie wie, czy wywołał ją agent bezpośrednio, czy Plan Executor. Dostaje input, robi robotę, zwraca output.

import type { AgentEvent } from "./events.js";
import type { LlmAdapter } from "./llm.js";

export interface ToolSpec {
  /** Tag w <nativeapi>, np. "web.query". */
  name: string;
  /** Jedna linia do promptu: co robi i co w środku tagu. */
  usage: string;
  /** Opcjonalnie dłuższy opis / zasady (do promptu, pod usage). */
  notes?: string;
}

export interface CapabilityDescriptor {
  apiVersion?: "qwe/v1";
  kind?: "Capability";
  name: string;
  version: string;
  description: string;
  dependencies?: { npm?: string[]; system?: string[] };
  tools: ToolSpec[];
}

export interface ToolResult {
  ok: boolean;
  /** Tekst, który wraca do modelu (bez opakowania <nativeresult> — opakuje runtime). */
  text: string;
  /** Lekki, strukturalny wynik dla UI / następnych kroków planu (bez pełnych treści stron). */
  data?: unknown;
  /** Dokładniejszy status niż ok (np. computer: ok · partial · cancelled_by_user · failed) — idzie do <nativeresult status=…>. */
  status?: string;
}

export type WaitReason = "LOGIN_REQUIRED" | "CONFIRM_ACTION" | "CAPTCHA" | "USER_CONTROL" | "OTHER";

export interface ToolCallContext {
  taskId: string;
  sessionId?: string;
  /** Który bot (agent) wywołał narzędzie — jego folder: `${ctx.agentsDir}/${agent}`. */
  agent?: string;
  stepId?: string;
  planId?: string;
  signal: AbortSignal;
  /** Wyniki wcześniejszych kroków planu (id → tekst wyniku). Dla direct call — puste. */
  priorResults: Record<string, ToolResult>;
  /** Emituj zdarzenie do event streamu (koperta dostaje taskId/sessionId/stepId automatycznie). */
  emit(type: string, data?: Record<string, unknown>): AgentEvent;
  /**
   * Human-in-the-loop: zatrzymaj task i czekaj aż user kliknie "wznów" (albo anuluje → throw).
   * Przycisk oznacza ZGODĘ na wznowienie, nie potwierdzenie — po resume capability sama sprawdza stan.
   */
  waitForUser(reason: WaitReason, message: string, meta?: Record<string, unknown>): Promise<void>;
  /** Punkt kontrolny między krokami: czeka, jeśli user dał "pauza"; rzuca, jeśli anulował. */
  checkpoint(): Promise<void>;
  /** Zdjęcia/obrazy: zapis → id; UI pobiera /api/screenshots/:id. */
  screenshots: { put(buf: Buffer, mime?: string): string };
}

export type ToolFn = (args: Record<string, string>, call: ToolCallContext) => Promise<ToolResult>;
export type ToolMap = Record<string, ToolFn>;

export interface CapabilityContext {
  mock: boolean;
  dataDir: string;
  /** Katalog botów (agents/) — dla capability, które piszą do folderu bota (skille, pamięć). */
  agentsDir: string;
  env: Record<string, string | undefined>;
  llm: LlmAdapter;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface CapabilityModule {
  descriptor: CapabilityDescriptor;
  create(ctx: CapabilityContext): Promise<ToolMap> | ToolMap;
}

export interface LoadedCapability {
  descriptor: CapabilityDescriptor;
  tools: ToolMap;
  /** skąd: "builtin:web" | "plugin:./plugins/hello" */
  source: string;
}

export function toolsPrompt(descriptors: CapabilityDescriptor[]): string {
  return descriptors
    .flatMap((d) => d.tools)
    .map((t) => `- ${t.usage}${t.notes ? `\n  ${t.notes.split("\n").join("\n  ")}` : ""}`)
    .join("\n");
}
