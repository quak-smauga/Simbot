// @qwe/plugin-computer — capability "computer": tool computer.run.
// Jedna przeglądarka na proces agenta (trwały profil w dataDir/browser-profile), jeden task naraz (lock).
import type { CapabilityContext, CapabilityDescriptor, ToolMap, ToolResult } from "@qwe/core";
import { BrowserRuntime } from "./browser.js";
import { llmDecider, mockDecider, mockDesktopDecider } from "./decider.js";
import { DesktopDriver } from "./desktop.js";
import { llmPlanner, mockPlanner } from "./planner.js";
import { runComputerTask } from "./executor.js";

export { BrowserRuntime, describeObservation } from "./browser.js";
export type { Observation, PageElement } from "./browser.js";
export { llmDecider, mockDecider, mockDesktopDecider } from "./decider.js";
export { DesktopDriver, GUARDED_APPS } from "./desktop.js";
export type { Decision, Decider } from "./decider.js";
export { llmPlanner, mockPlanner, budgetFor } from "./planner.js";
export type { Planner, TaskPlan, Stage } from "./planner.js";

/**
 * Sim może dopisać do celu kryteria akceptacji: <done_when>kliknięty co najmniej jeden filtr</done_when>.
 * Parser nativeapi zostawia zagnieżdżone tagi w treści — tu je wyciągamy. Każde wymaganie staje się etapem planu i przechodzi weryfikację.
 */
export function splitGoal(raw: string): { goal: string; required: string[] } {
  const required: string[] = [];
  const goal = raw
    .replace(/<done_when>([\s\S]*?)<\/done_when>/gi, (_m, t: string) => {
      const r = t.replace(/\s+/g, " ").trim();
      if (r && required.length < 6) required.push(r.slice(0, 200));
      return " ";
    })
    .replace(/<\/?done_when>/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { goal, required };
}

export const descriptor: Partial<CapabilityDescriptor> = { name: "computer" };

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : v === "1" || v.toLowerCase() === "true");

export function create(ctx: CapabilityContext): ToolMap {
  const headless = bool(ctx.env.QWE_COMPUTER_HEADLESS, false) || !!ctx.env.QWE_IN_DOCKER;
  const vision = bool(ctx.env.QWE_COMPUTER_VISION, true);
  const maxSteps = Number(ctx.env.QWE_COMPUTER_MAX_STEPS ?? 25);
  const browser = new BrowserRuntime({ dataDir: ctx.dataDir, headless, channel: ctx.env.QWE_COMPUTER_CHANNEL || undefined, log: ctx.log });
  const decider = ctx.mock ? mockDecider() : llmDecider(ctx.llm, { vision, model: ctx.env.QWE_EXECUTOR_MODEL || undefined });
  // desktop: cały komputer przez qwe-helper (most w aplikacji simbot); zrzut zawsze, bo menu i aplikacje bez dostępności widać tylko na nim
  const desktop = new DesktopDriver({ dataDir: ctx.dataDir, env: ctx.env, log: ctx.log });
  const desktopDecider = ctx.mock ? mockDesktopDecider() : llmDecider(ctx.llm, { vision: true, model: ctx.env.QWE_EXECUTOR_DESKTOP_MODEL || ctx.env.QWE_EXECUTOR_MODEL || undefined, mode: "desktop" });
  const desktopSteps = Number(ctx.env.QWE_COMPUTER_DESKTOP_MAX_STEPS ?? 30);
  // planner: przed pętlą sprawdza, czy cel już spełniony, i daje etapy + budżet kroków (env MAX_STEPS = już tylko twardy limit)
  const planOn = bool(ctx.env.QWE_COMPUTER_PLANNER, true);
  const planModel = ctx.env.QWE_PLANNER_MODEL || undefined;
  const planner = !planOn ? undefined : ctx.mock ? mockPlanner() : llmPlanner(ctx.llm, { vision, model: planModel || ctx.env.QWE_EXECUTOR_MODEL || undefined });
  const desktopPlanner = !planOn ? undefined : ctx.mock ? mockPlanner() : llmPlanner(ctx.llm, { vision: true, model: planModel || ctx.env.QWE_EXECUTOR_DESKTOP_MODEL || ctx.env.QWE_EXECUTOR_MODEL || undefined });

  return {
    "computer.run": async (args, call): Promise<ToolResult> => {
      // <done_when>…</done_when> w treści = wymagania od zlecającego (kryteria akceptacji); reszta to cel
      const { goal, required } = splitGoal(args._ ?? args.task ?? "");
      if (!goal) return { ok: false, text: "Pusty cel dla computer.run." };
      // kontekst z wcześniejszych kroków planu (np. wyniki web.query) — przycięty, to podpowiedź, nie instrukcja
      // + kontekst podany przez sima wprost (atrybut context="…": co user powiedział, co już wiadomo) — też tylko podpowiedź
      const own = (args.context ?? "").trim();
      const context = [
        own ? `— od sima (rozmowa):\n${own.slice(0, 1500)}` : "",
        ...Object.entries(call.priorResults).map(([id, r]) => `— krok ${id}:\n${r.text.slice(0, 1500)}`),
      ].filter(Boolean).join("\n\n");
      if ((args.target ?? "").trim().toLowerCase() === "desktop")
        return desktop.withLock(() => runComputerTask({ goal, context, maxSteps: desktopSteps, browser: desktop, decider: desktopDecider, planner: desktopPlanner, mode: "desktop", call, log: ctx.log, guard: (d) => desktop.guard(d) }));
      return browser.withLock(() => runComputerTask({ goal, context, maxSteps, browser, decider, planner, mode: "browser", required, call, log: ctx.log }));
    },
  };
}
