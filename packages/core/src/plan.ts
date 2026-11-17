// PLAN EXECUTOR — prosty executor zależności. Nie DAG-owe imperium: kroki, `after`, wyniki, eventy.
//   - domyślnie kroki niezależne idą równolegle, `after` wymusza kolejność
//   - wynik każdego kroku jest dostępny dla następnych (priorResults)
//   - plan może się zatrzymać (waiting_user w kroku) i wznowić — executor nie blokuje event loopa
//   - executor nie jest inteligentniejszy niż musi

import type { PlanStep } from "./nativeapi.js";
import type { ToolResult } from "./capability.js";

export type StepStatus = "pending" | "running" | "waiting_user" | "completed" | "failed" | "skipped";

export interface StepResult {
  stepId: string;
  name: string;
  status: StepStatus;
  result?: ToolResult;
  error?: string;
  ms: number;
}

export interface PlanRunOptions {
  steps: PlanStep[];
  signal: AbortSignal;
  /** Wykonaj jeden krok; `prior` = wyniki ukończonych kroków, na które krok czeka (i wszystkich wcześniej ukończonych). */
  run(step: PlanStep, prior: Record<string, ToolResult>): Promise<ToolResult>;
  emit(type: "plan.started" | "step.started" | "step.completed" | "step.failed" | "step.skipped" | "plan.completed" | "plan.failed", data: Record<string, unknown>): void;
}

export function validatePlan(steps: PlanStep[]): string | null {
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) return `powtórzone id kroku: ${s.id}`;
    ids.add(s.id);
  }
  for (const s of steps) for (const a of s.after) if (!ids.has(a)) return `krok ${s.id} czeka na nieistniejący ${a}`;
  // cykl?
  const state = new Map<string, number>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string): boolean => {
    const st = state.get(id) ?? 0;
    if (st === 1) return false;
    if (st === 2) return true;
    state.set(id, 1);
    for (const a of byId.get(id)!.after) if (!visit(a)) return false;
    state.set(id, 2);
    return true;
  };
  for (const s of steps) if (!visit(s.id)) return `cykl zależności przy kroku ${s.id}`;
  return null;
}

export async function executePlan(o: PlanRunOptions): Promise<StepResult[]> {
  const err = validatePlan(o.steps);
  if (err) throw new Error(`Zły plan: ${err}`);
  const results = new Map<string, StepResult>();
  const done = new Map<string, ToolResult>();
  const running = new Map<string, Promise<void>>();
  o.emit("plan.started", { steps: o.steps.map((s) => ({ id: s.id, name: s.name, after: s.after })) });

  const ready = () => o.steps.filter((s) => !results.has(s.id) && !running.has(s.id) && s.after.every((a) => results.get(a)?.status === "completed"));
  const blocked = () => o.steps.filter((s) => !results.has(s.id) && !running.has(s.id) && s.after.some((a) => results.has(a) && results.get(a)!.status !== "completed"));

  const launch = (step: PlanStep) => {
    const t0 = Date.now();
    o.emit("step.started", { stepId: step.id, name: step.name, args: step.args });
    const p = (async () => {
      try {
        const prior: Record<string, ToolResult> = {};
        for (const [id, r] of done) prior[id] = r; // wszystko, co już skończone — kolejność planu to kontekst
        const r = await o.run(step, prior);
        done.set(step.id, r);
        const sr: StepResult = { stepId: step.id, name: step.name, status: r.ok ? "completed" : "failed", result: r, ms: Date.now() - t0 };
        if (!r.ok) sr.error = r.text.slice(0, 300);
        results.set(step.id, sr);
        o.emit(r.ok ? "step.completed" : "step.failed", { stepId: step.id, name: step.name, ms: sr.ms, data: r.data, error: sr.error });
      } catch (e) {
        const sr: StepResult = { stepId: step.id, name: step.name, status: "failed", error: (e as Error).message, ms: Date.now() - t0 };
        results.set(step.id, sr);
        o.emit("step.failed", { stepId: step.id, name: step.name, ms: sr.ms, error: sr.error });
      } finally {
        running.delete(step.id);
      }
    })();
    running.set(step.id, p);
  };

  while (results.size < o.steps.length) {
    // anulowanie: nie wyrzucamy tego, co już zrobione — kroki w toku same oddają raport, reszta = pominięte
    if (o.signal.aborted) {
      await Promise.allSettled(running.values());
      for (const s of o.steps) if (!results.has(s.id)) { results.set(s.id, { stepId: s.id, name: s.name, status: "skipped", error: "anulowane przez usera", ms: 0 }); o.emit("step.skipped", { stepId: s.id, name: s.name, after: s.after, reason: "cancelled" }); }
      break;
    }
    for (const s of blocked()) {
      results.set(s.id, { stepId: s.id, name: s.name, status: "skipped", error: `pominięty — zależność nie powiodła się (${s.after.join(", ")})`, ms: 0 });
      o.emit("step.skipped", { stepId: s.id, name: s.name, after: s.after });
    }
    for (const s of ready()) launch(s);
    if (results.size >= o.steps.length) break;
    if (!running.size) throw new Error("plan utknął (brak kroków gotowych do startu)");
    await Promise.race(running.values());
  }
  const out = o.steps.map((s) => results.get(s.id)!);
  const okAll = out.every((r) => r.status === "completed");
  o.emit(okAll ? "plan.completed" : "plan.failed", { steps: out.map((r) => ({ stepId: r.stepId, name: r.name, status: r.status, ms: r.ms, error: r.error })) });
  return out;
}
