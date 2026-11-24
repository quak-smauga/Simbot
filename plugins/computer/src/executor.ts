// COMPUTER TASK LOOP — OBSERVE → DECIDE → ACT → OBSERVE → VERIFY → … Fundament: obserwacja po każdej akcji.
// Eventy (do istniejącego streamu, przez call.emit):
//   computer.started { goal } · computer.observation { url, title, screenshotId, hints, elements } ·
//   computer.action { step, action, label, status: started } → po akcji i nowej obserwacji { status: completed|failed, error?, outcome, url }
//     outcome = co akcja dała („PRZEKIEROWANO na …”, „nowa strona: …”, „bez zmian”, „trafiono w: …”) — to samo dostaje decydent w logu ·
//   computer.note { text } ·
//   computer.loop { description, count, strategyChange } · computer.resumed · computer.completed { result, steps, status } ·
//   computer.failed { error, status } · computer.cancelled { report } ·
//   computer.plan { replan, alreadyDone, estimatedSteps, budget, cap, stages[] } · computer.stage { id, title, status: done|unconfirmed, auto?, by?, next }
//     auto = etap zaliczył executor z warunku `check` planu (by: „URL xkcd.com/1773/”); unconfirmed = „done” bez zaliczenia etapu
//   computer.started niesie mode: browser|desktop — UI nazywa zadanie „przeglądarka” albo „komputer”.
//
// PLAN: przed pętlą planner ocenia obserwację — cel już spełniony → koniec bez kliknięcia; inaczej etapy z „zrobione, gdy…”
// i budżet kroków z szacunku (maxSteps z env to tylko twardy limit). Brak postępu przez NO_PROGRESS kroków → replan.
// Nie streamujemy każdego odczytu DOM — event, gdy zmieniła się sytuacja, agent podjął akcję, trzeba usera, koniec.
//
// RAPORT: każde zakończenie (sukces, częściowo, anulowanie, błąd) wraca do sima jako pełny raport — odwiedzone strony po kolei,
// kroki, notatki zebrane po drodze, przekazania kontroli userowi, co nie zadziałało, ostatni widok. Sim nie może dostać
// samego „anulowano”, kiedy zadanie w połowie się udało (np. gra skończona z wynikiem 333).
// Statusy: ok · partial (limit kroków / pętla, ale coś zebrane) · cancelled_by_user · failed. Czekanie na usera NIE kończy zadania.
import type { ToolCallContext, ToolResult } from "@qwe/core";
import type { BrowserRuntime, Observation } from "./browser.js";
import type { Decider, Decision } from "./decider.js";
import { bareUrl, budgetFor, checkStage, type Planner, type Stage, type TaskPlan } from "./planner.js";

export type ComputerStatus = "ok" | "partial" | "cancelled_by_user" | "failed";

/** To, czego executor potrzebuje od przeglądarki (testy podstawiają atrapę). */
export type BrowserLike = Pick<BrowserRuntime, "observe" | "navigate" | "click" | "hover" | "type" | "press" | "scroll" | "wait" | "back"> & {
  /** przeglądarka zwraca `hit` — co leżało w klikanym punkcie; desktop i atrapy mogą nie zwracać nic */
  clickAt(x: number, y: number): Promise<{ hit?: string } | void>;
  /** desktop: uruchom / przełącz aplikację */
  openApp?(name: string): Promise<void>;
};

export interface RunOptions {
  goal: string;
  context: string;
  maxSteps: number;
  browser: BrowserLike;
  decider: Decider;
  call: ToolCallContext;
  log(level: "info" | "warn" | "error", message: string): void;
  /** Planner przed pętlą (i przy braku postępu): czy cel już spełniony, etapy, budżet kroków. Bez plannera — stary tryb (maxSteps). */
  planner?: Planner;
  mode?: "browser" | "desktop";
  /** Akcja wymaga potwierdzenia niezależnie od decydenta (desktop: Terminal, Ustawienia) → powód, inaczej null. */
  guard?(d: Decision): string | null;
}

/** Ile razy ta sama akcja bez zmiany strony = pętla. Ile pętli wolno zgłosić (zmiana strategii), zanim kończymy jako partial. */
const LOOP_REPEATS = 3;
const MAX_LOOPS = 3;
const MAX_NOTES = 40;
/** Tyle kroków bez postępu (etap zrobiony / nowa notatka / nowe miejsce) = replan; po MAX_REPLANS — koniec jako partial. */
const NO_PROGRESS = 6;
const MAX_REPLANS = 2;
/** Ta sama intencja (np. „idź na /random”) tyle razy od ostatniego zrobionego etapu = powtarzanie, nawet jeśli strona się zmienia. */
const REPEAT_LIMIT = 3;

/** Notatki „prawie takie same” (model przepisuje ten sam fakt innymi słowami) nie są nową wiedzą. */
const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
function similar(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return a === b;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common) >= 0.6;
}

const describeDecision = (d: Decision) => {
  switch (d.action) {
    case "navigate":
      return `navigate ${d.url}`;
    case "open_app":
      return `open_app ${d.app}`;
    case "click":
      return `click [${d.target}]`;
    case "click_at":
      return `click_at (${d.x.toFixed(2)}, ${d.y.toFixed(2)})`;
    case "hover":
      return d.target !== undefined ? `hover [${d.target}]` : `hover (${(d.x ?? 0).toFixed(2)}, ${(d.y ?? 0).toFixed(2)})`;
    case "type":
      return `type ${d.target !== undefined ? `[${d.target}] ` : ""}"${d.text.slice(0, 40)}"${d.submit ? " + Enter" : ""}`;
    case "press":
      return `press ${d.key}`;
    case "scroll":
      return `scroll ${d.direction}`;
    case "wait":
      return `wait ${d.ms ?? 1000}ms`;
    default:
      return d.action;
  }
};

/** URL bez #fragmentu i końcowego „/” — do liczenia powrotów na tę samą stronę. */
const pageKey = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");
/** Czy akcja coś zmieniła? Porównujemy to, co widać: adres, tytuł, początek tekstu, liczbę elementów. */
const signature = (o: Observation) => `${pageKey(o.url)}|${o.title}|${o.elements.length}|${o.text.slice(0, 400)}`;
/**
 * Intencja akcji niezależna od numeru elementu: navigate i klik w link pod ten sam adres to to samo („go c.xkcd.com/random/comic”),
 * klik w przycisk = rola + nazwa. Inne akcje (scroll, wait, type…) nie są liczone — tym zajmuje się wykrywanie pętli.
 */
function intentKey(d: Decision, o: Observation): string | null {
  const go = (u: string) => `go ${pageKey(u.replace(/^https?:\/\//i, "")).toLowerCase()}`;
  if (d.action === "navigate") return go(d.url);
  if (d.action === "click") {
    const el = o.elements.find((e) => e.id === d.target);
    if (!el) return null;
    return el.href ? go(el.href) : `click ${el.role} ${el.name.slice(0, 50).toLowerCase()}`;
  }
  return null;
}
/** „click [5]” → „click [5] „Graj” (button)” — opis celu z obserwacji, w której zapadła decyzja. */
function describeTarget(d: Decision, o: Observation): string {
  const key = describeDecision(d);
  if (!("target" in d) || d.target === undefined) return key;
  const el = o.elements.find((e) => e.id === d.target);
  return el ? `${key} „${el.name.slice(0, 50) || "bez nazwy"}” (${el.role})` : key;
}

const flatUrl = (u: string) => bareUrl(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
/**
 * Co akcja DAŁA — z faktów, które executor ma (adres przed/po, zmiana treści, błąd, punkt trafienia). Idzie do logu decydenta,
 * do raportu i do UI. Bez tego decydent widział „navigate /random → ok” i stronę /1773, i uznawał, że losowanie nie zadziałało.
 */
function describeOutcome(x: { d: Decision; prev: Observation; obs: Observation; changed: boolean; actionError: string | null; hit?: string }): string {
  const { d, prev, obs, changed, actionError, hit } = x;
  const moved = pageKey(obs.url) !== pageKey(prev.url);
  const here = `${obs.url}${obs.title ? ` „${obs.title.slice(0, 60)}”` : ""}`;
  if (actionError) return moved ? `NIE WYKONANO (${actionError}) — bo strona w międzyczasie przeszła na ${here}: wcześniejsza akcja zadziałała z opóźnieniem. To nie błąd strony; pracuj na nowej obserwacji.` : `BŁĄD: ${actionError}`;
  const tail = hit ? ` · trafiono w: ${hit}` : "";
  if (d.action === "navigate") {
    if (/^chrome-error:/i.test(obs.url)) return "BŁĄD: strona się nie załadowała (błąd sieci albo zły adres)";
    if (flatUrl(d.url) === flatUrl(obs.url)) return `ok — otwarto ${here}`;
    if (!moved && !changed) return `nie zadziałało — adres się nie otworzył, dalej jesteś na ${here}`;
    return `ok — PRZEKIEROWANO na ${here}. To JEST wynik tej akcji (adres ${bareUrl(d.url)} sam przenosi dalej) — nie powtarzaj jej.`;
  }
  if (moved) return `ok — nowa strona: ${here}${tail}`;
  if (changed) return `ok — ta sama strona, widok albo treść się zmieniły${tail}`;
  return `bez zmian (ten sam adres i ta sama treść)${tail}`;
}

/** Ślad zadania: wszystko, co potem trafia do raportu i do promptu decydenta (zamiast tylko ostatnich 10 kroków). */
class Trace {
  /** Strona, na której przeglądarka stała PRZED zadaniem (zostaje po poprzednim) — nie jest częścią tego zadania. */
  start: { url: string; title: string } | null = null;
  visits: { url: string; title: string }[] = [];
  visitCount = new Map<string, number>();
  notes: string[] = [];
  failures: string[] = [];
  handoffs: string[] = [];
  loops: string[] = [];
  steps = 0;
  lastAction = "";
  lastObs: Observation | null = null;
  stages: Stage[] = [];
  /** Każdy wykonany krok z intencją — do raportu (sim widzi przebieg, nie zgaduje). */
  history: { step: number; stage?: number; label: string; think?: string; outcome: string }[] = [];

  constructor(readonly goal: string, public budget: number, readonly mode: "browser" | "desktop" = "browser") {}

  /** Bieżący etap = pierwszy otwarty (ani zrobiony, ani pominięty). */
  get current() {
    return this.stages.find((s) => s.status !== "done" && s.status !== "skipped" && s.status !== "unconfirmed");
  }
  /** stage_done od decydenta → etap zrobiony. Wcześniejsze otwarte etapy ZOSTAJĄ otwarte (kiedyś stawały się „pominięte” — to kłamało). */
  advance(d: Decision): Stage | null {
    if (!d.stage_done || !this.stages.length) return null;
    const s = this.stages.find((x) => x.id === d.stage) ?? this.current;
    if (!s || s.status === "done") return null;
    s.status = "done";
    s.doneBy = "decydent";
    const next = this.current;
    if (next) next.status = "doing";
    return s;
  }
  /** Etapy z warunkiem `check` zalicza executor sam, z obserwacji — bez czekania, aż model przypomni sobie o stage_done. */
  auto(o: Observation): Stage[] {
    const done: Stage[] = [];
    for (const s of this.stages) {
      if (s.status === "done" || !s.check) continue;
      const by = checkStage(s.check, o);
      if (!by) continue;
      s.status = "done";
      s.doneBy = by;
      done.push(s);
    }
    const next = this.current;
    if (done.length && next && next.status === "todo") next.status = "doing";
    return done;
  }
  /** Zadanie skończone „done”: etapy, których nikt nie zaliczył, są NIEPOTWIERDZONE (nie „niepotrzebne”). Zwraca je. */
  closeOpen(): Stage[] {
    const open = this.stages.filter((s) => s.status !== "done" && s.status !== "skipped" && s.status !== "unconfirmed");
    for (const s of open) s.status = "unconfirmed";
    return open;
  }
  planText(): string {
    if (!this.stages.length) return "";
    const cur = this.current;
    const lines = this.stages.map((s) => (s.status === "done" ? `✓ ${s.id}. ${s.title} — ZROBIONY (${s.doneBy ?? "zaliczony"})` : `${s === cur ? "→" : "·"} ${s.id}. ${s.title} — zrobione, gdy: ${s.doneWhen}${s.check ? " [executor sprawdza sam]" : ""}`));
    return `${lines.join("\n")}${cur ? "" : "\nWSZYSTKIE ETAPY ZROBIONE → zwróć \"done\" z raportem."}`;
  }

  visit(o: Observation, start = false) {
    this.lastObs = o;
    if (start) {
      this.start = { url: o.url, title: o.title };
      return;
    }
    if (!o.url || o.url === "about:blank") return;
    const last = this.visits.at(-1);
    if (last && pageKey(last.url) === pageKey(o.url)) {
      if (o.title) last.title = o.title;
      return;
    }
    this.visits.push({ url: o.url, title: o.title });
    const k = pageKey(o.url);
    this.visitCount.set(k, (this.visitCount.get(k) ?? 0) + 1);
  }
  note(text: string | undefined) {
    const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!t || this.notes.some((n) => n === t || similar(n, t))) return false;
    this.notes.push(t);
    if (this.notes.length > MAX_NOTES) this.notes.shift();
    return true;
  }

  /** Dla decydenta: gdzie już był (z licznikami) i co zebrał. */
  memory(): string {
    // bieżąca strona jest na liście, bo właśnie na nią trafiłeś — bez oznaczenia model czytał ją jako „już tu byłem”
    const cur = this.lastObs ? pageKey(this.lastObs.url) : "";
    const here = " ← TU JESTEŚ TERAZ (wynik ostatniej akcji, nie wcześniejsza wizyta)";
    const seen = [...new Map(this.visits.map((v) => [pageKey(v.url), v])).values()]
      .map((v) => { const n = this.visitCount.get(pageKey(v.url)) ?? 1; return `- ${v.title || "(bez tytułu)"} — ${v.url}${n > 1 ? ` (×${n})` : ""}${pageKey(v.url) === cur ? here : ""}`; })
      .join("\n");
    const startHere = !this.visits.length && this.start && this.start.url !== "about:blank";
    return [
      startHere ? `STRONA STARTOWA (otwarta przed zadaniem — została po poprzednim; nie jest wynikiem tego zadania): ${this.start!.title || "(bez tytułu)"} — ${this.start!.url}` : "",
      seen ? `STRONY W TYM ZADANIU (kolejność pierwszych wejść, ×N = ile razy):\n${seen}` : "",
      this.notes.length ? `NOTATKI, KTÓRE JUŻ ZEBRAŁEŚ (nie zbieraj ich drugi raz):\n${this.notes.map((n) => `- ${n}`).join("\n")}` : "NOTATKI: (jeszcze żadnych — zapisuj fakty polem \"note\")",
      this.loops.length ? `WYKRYTE PĘTLE (nie powtarzaj tych strategii):\n${this.loops.map((l) => `- ${l}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  /** Raport końcowy dla sima — zawsze pełny, niezależnie od statusu. */
  report(status: ComputerStatus, headline: string): string {
    const o = this.lastObs;
    const lines = [
      `TRYB: ${this.mode === "desktop" ? "desktop — prawdziwy komputer usera (aplikacje, okna, fokus)" : "przeglądarka wbudowana — własne okno simbota, nie przeglądarka usera; adres i treść czytane wprost ze strony"}`,
      `STATUS: ${status}`,
      `WYNIK: ${headline || "(brak)"}`,
      `KROKI: ${this.steps}/${this.budget}${this.lastAction ? ` · ostatni: ${this.lastAction}` : ""}`,
    ];
    // ✓ zaliczony (w nawiasie: czym) · ? niepotwierdzony — zadanie zakończone bez zaliczenia etapu, nikt tego nie sprawdził · ✗ niezrobiony
    if (this.stages.length) lines.push(`PLAN (✓ zaliczony · ? niepotwierdzony: executor zakończył bez zaliczenia tego etapu — nie wiadomo, czy zrobiony${status === "ok" ? "" : " · ✗ niezrobiony"}):\n${this.stages.map((s) => `${s.status === "done" ? "✓" : s.status === "unconfirmed" || s.status === "skipped" || status === "ok" ? "?" : "✗"} ${s.id}. ${s.title}${s.status === "done" && s.doneBy ? ` (${s.doneBy})` : ""}`).join("\n")}`);
    if (this.history.length) {
      const h = this.history.length > 20 ? [`(… ${this.history.length - 20} wcześniejszych kroków)`, ...this.history.slice(-20).map(fmtStep)] : this.history.map(fmtStep);
      lines.push(`PRZEBIEG (krok · akcja · po co · efekt):\n${h.join("\n")}`);
    }
    if (this.start && this.start.url !== "about:blank") lines.push(`START (strona otwarta przed zadaniem, nie jest częścią wyniku): ${this.start.title || "(bez tytułu)"} — ${this.start.url}`);
    if (this.visits.length) lines.push(`ODWIEDZONE (kolejno):\n${this.visits.map((v, i) => `${i + 1}. ${v.title || "(bez tytułu)"} — ${v.url}`).join("\n")}`);
    if (this.notes.length) lines.push(`ZEBRANE PO DRODZE (surowe notatki z kolejnych kroków — przy różnicach obowiązuje WYNIK):\n${this.notes.map((n) => `- ${n}`).join("\n")}`);
    if (this.handoffs.length) lines.push(`USER: ${this.handoffs.join("; ")}`);
    const bad = [...this.loops.map((l) => `pętla: ${l}`), ...this.failures];
    if (bad.length) lines.push(`NIE ZADZIAŁAŁO:\n${bad.slice(-8).map((b) => `- ${b}`).join("\n")}`);
    if (o && o.url !== "about:blank") {
      const text = o.text.replace(/\n{2,}/g, "\n").trim().slice(0, status === "ok" ? 300 : 700);
      lines.push(`OSTATNI WIDOK: ${o.title || "(bez tytułu)"} — ${o.url}${text ? `\n${text}` : ""}`);
    }
    return lines.join("\n");
  }
}

const fmtStep = (h: Trace["history"][number]) => `${h.step}.${h.stage ? ` [etap ${h.stage}]` : ""} ${h.label}${h.think ? ` — ${h.think}` : ""} → ${h.outcome}`;

export async function runComputerTask(o: RunOptions): Promise<ToolResult> {
  const { call, browser, decider } = o;
  const log: string[] = [];
  const emit = call.emit;
  const mode = o.mode ?? "browser";
  const trace = new Trace(o.goal, o.maxSteps, mode);
  emit("computer.started", { goal: o.goal, maxSteps: o.maxSteps, mode });

  const observe = async (start = false): Promise<Observation> => {
    const obs = await browser.observe();
    const screenshotId = obs.screenshot.length ? call.screenshots.put(obs.screenshot, "image/jpeg") : undefined;
    obs.screenshotId = screenshotId;
    trace.visit(obs, start);
    emit("computer.observation", {
      observationId: obs.observationId,
      url: obs.url,
      title: obs.title,
      screenshotId,
      hints: obs.hints,
      elements: obs.elements.length,
      summary: obs.text.split("\n")[0]?.replace(/^# /, "").slice(0, 120) ?? "",
    });
    return obs;
  };
  const finish = (status: ComputerStatus, headline: string): ToolResult => {
    if (status === "ok") for (const s of trace.closeOpen()) emit("computer.stage", { id: s.id, title: s.title, status: "unconfirmed", next: null });
    const text = trace.report(status, headline);
    const data = { status, steps: trace.steps, url: trace.lastObs?.url, title: trace.lastObs?.title, visited: trace.visits.map((v) => v.url), notes: trace.notes };
    if (status === "ok") emit("computer.completed", { result: headline, steps: trace.steps, url: trace.lastObs?.url, status });
    else if (status === "cancelled_by_user") emit("computer.cancelled", { report: text.slice(0, 600) });
    else emit("computer.failed", { error: headline, steps: trace.steps, status });
    return { ok: status === "ok", status, text, data };
  };
  /** Anulowanie przez usera (Anuluj / ⌃⌥Esc) przychodzi jako wyjątek z checkpoint/waitForUser — zamieniamy na raport. */
  const aborted = () => call.signal.aborted;

  let obs: Observation;
  try {
    obs = await observe(true);
  } catch (e) {
    const what = browser.openApp ? "komputer" : "przeglądarka";
    trace.failures.push(`${what}: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
    return finish("failed", `${what} niedostępny: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
  }

  // PLAN: zanim cokolwiek klikniemy — czy cel już jest spełniony, jakie etapy, ile kroków naprawdę trzeba
  let budget = o.maxSteps;
  let replans = 0;
  const applyPlan = (p: TaskPlan, step: number, replan: boolean) => {
    trace.stages = p.stages.map((s, i) => ({ ...s, status: i === 0 ? "doing" : "todo" }));
    budget = Math.min(o.maxSteps, step + budgetFor(p.estimatedSteps, o.maxSteps));
    trace.budget = budget;
    emit("computer.plan", { replan, alreadyDone: p.alreadyDone, why: p.why, estimatedSteps: p.estimatedSteps, budget, cap: o.maxSteps, stages: trace.stages.map((s) => ({ id: s.id, title: s.title, doneWhen: s.doneWhen, check: s.check, status: s.status })) });
  };
  if (o.planner) {
    try {
      const p = await o.planner.plan({ goal: o.goal, context: o.context, observation: obs, mode, cap: o.maxSteps }, call.signal);
      if (p.alreadyDone) {
        emit("computer.plan", { replan: false, alreadyDone: true, why: p.why, estimatedSteps: 0, budget: 0, cap: o.maxSteps, stages: [] });
        trace.note(p.result);
        return finish("ok", p.result || "Cel był już spełniony — nic nie trzeba było robić.");
      }
      applyPlan(p, 0, false);
    } catch (e) {
      if (aborted()) return finish("cancelled_by_user", "user anulował zadanie przed startem");
      o.log("warn", `[computer] planner: ${(e as Error).message} — lecę bez planu`);
    }
  }
  /** Brak postępu albo koniec budżetu z planu → nowy plan z raportem przebiegu (raz/dwa), potem koniec jako partial. */
  const replan = async (step: number, why: string): Promise<ToolResult | null> => {
    if (!o.planner || replans >= MAX_REPLANS || step >= o.maxSteps) return null;
    replans++;
    try {
      const p = await o.planner.plan({ goal: o.goal, context: o.context, observation: obs, mode, cap: o.maxSteps, previous: { stages: trace.stages, report: trace.report("partial", why), stepsLeft: o.maxSteps - step } }, call.signal);
      if (p.alreadyDone) {
        trace.note(p.result);
        return finish("ok", p.result || "Cel spełniony.");
      }
      applyPlan(p, step, true);
      log.push(`${step}. (PRZEPLANOWANO: ${why}. Nowy plan w sekcji PLAN — NIE powtarzaj poprzedniej strategii.)`);
      expect = undefined;
      return null;
    } catch (e) {
      if (aborted()) throw e;
      o.log("warn", `[computer] replan: ${(e as Error).message}`);
      return null;
    }
  };

  let lastKey = "";
  let streak = 0;
  let deciderErrors = 0;
  let expect: string | undefined;
  let lastProgress = 0;
  /** Ile razy każda intencja padła od ostatniego zrobionego etapu (xkcd: navigate /random i klik „Random” na zmianę). */
  const repeats = new Map<string, number>();
  try {
    for (let step = 1; step <= budget; step++) {
      await call.checkpoint(); // pauza / anuluj między krokami
      let d: Decision;
      try {
        d = await decider.decide({ goal: o.goal, context: o.context, log, memory: trace.memory(), plan: trace.planText() || undefined, expect, observation: obs, step, maxSteps: budget }, call.signal);
      } catch (e) {
        if (aborted()) break;
        o.log("warn", `[computer] decider: ${(e as Error).message}`);
        log.push(`${step}. (decider error: ${(e as Error).message.slice(0, 80)}) — odpowiedz KRÓTKIM, domkniętym JSON-em`);
        if (++deciderErrors >= 3) {
          trace.failures.push(`decydent 3× z rzędu bez poprawnego JSON-a (${(e as Error).message.slice(0, 120)})`);
          return finish(trace.notes.length ? "partial" : "failed", "executor przestał odpowiadać poprawnie — przerwałem");
        }
        continue; // bez wait i bez nowej obserwacji — ta sama strona, nowa próba decyzji
      }
      deciderErrors = 0;
      if (trace.note(d.note)) {
        emit("computer.note", { text: d.note });
        lastProgress = step;
      }
      const doneStage = trace.advance(d);
      if (doneStage) {
        lastProgress = step;
        repeats.clear();
        emit("computer.stage", { id: doneStage.id, title: doneStage.title, status: "done", next: trace.current?.id ?? null });
        log.push(`${step}. ✓ etap ${doneStage.id} „${doneStage.title}” zrobiony${trace.current ? ` — teraz etap ${trace.current.id}` : " — wszystkie etapy zrobione → done"}`);
      }

      // koniec?
      if (d.action === "done") return finish("ok", (d.result || "").trim() || `Zrobione. Strona: ${obs.title || obs.url}`);
      if (d.action === "fail") {
        trace.failures.push(d.error);
        return finish(trace.notes.length ? "partial" : "failed", d.error);
      }
      if (d.action === "needs_user") {
        log.push(`${step}. needs_user (${d.reason}): ${d.message}`);
        await call.waitForUser(d.reason, d.message, { url: obs.url, step, maxSteps: o.maxSteps, screenshotId: obs.screenshotId });
        trace.handoffs.push(`${d.reason === "LOGIN_REQUIRED" ? "logowanie" : d.reason === "CAPTCHA" ? "captcha" : "pomoc"} na ${obs.url} → wznowione`);
        log.push(`${step}. user wznowił po ${d.reason} — sprawdź, czy zrobił swoje (nowa obserwacja)`);
        emit("computer.resumed", { after: d.reason });
        obs = await observe(); // nie zakładamy, że user się zalogował — sprawdzamy stan
        lastProgress = step; // czas usera nie liczy się jako brak postępu
        continue;
      }

      const key = describeDecision(d);
      const label = describeTarget(d, obs);
      const intent = intentKey(d, obs);
      const repeatNo = intent ? (repeats.get(intent) ?? 0) + 1 : 0;
      if (intent) repeats.set(intent, repeatNo);

      // powrót na stronę, na której już był 2× — podpowiedź z notatkami, zamiast kolejnego okrążenia X → Y → Z → X
      // (wyszukiwarki i listy wyników są „hubem” — tam powroty są normalne)
      if (d.action === "navigate" && !/[?&](q|query|search)=|\/search\b/i.test(d.url) && (trace.visitCount.get(pageKey(d.url)) ?? 0) >= 2) {
        const desc = `${pageKey(d.url)} odwiedzone już ${trace.visitCount.get(pageKey(d.url))}×`;
        if (!trace.loops.includes(desc)) {
          trace.loops.push(desc);
          emit("computer.loop", { description: desc, count: trace.visitCount.get(pageKey(d.url)), strategyChange: true });
          log.push(`${step}. (STOP: ${desc}. Masz notatki z tej strony — nie wracaj. Jeśli zebrałeś wszystko, co trzeba do celu → "done" z porównaniem/raportem; jeśli czegoś brakuje — idź tylko tam, gdzie tego brakuje)`);
          if (trace.loops.length >= MAX_LOOPS) return finish("partial", `zatrzymałem się po ${trace.loops.length} pętlach — raport z tego, co zebrane`);
          continue;
        }
      }

      // chroniona aplikacja (Terminal, Ustawienia…): potwierdzenie każdej akcji, nawet jeśli decydent nie poprosił
      const guarded = o.guard?.(d);
      if (guarded && !("confirm" in d && d.confirm)) {
        await call.waitForUser("CONFIRM_ACTION", `${guarded} — potwierdzasz? (${key})`, { url: obs.url, action: key, title: guarded, details: [{ label: "Aplikacja", value: obs.title || obs.url }, { label: "Akcja", value: label }, ...(d.action === "type" ? [{ label: "Tekst", value: d.text.slice(0, 120) }] : [])], step, maxSteps: o.maxSteps, screenshotId: obs.screenshotId });
        trace.handoffs.push(`potwierdził: ${guarded}`);
        emit("computer.resumed", { after: "CONFIRM_ACTION" });
      }
      // wrażliwa operacja → osobne potwierdzenie usera PRZED wykonaniem
      if ("confirm" in d && d.confirm) {
        await call.waitForUser("CONFIRM_ACTION", `${d.confirm} — potwierdzasz? (${key})`, { url: obs.url, action: key, title: d.confirm, details: "details" in d && Array.isArray(d.details) ? d.details.slice(0, 6) : undefined, step, maxSteps: o.maxSteps, screenshotId: obs.screenshotId });
        trace.handoffs.push(`potwierdził: ${d.confirm}`);
        emit("computer.resumed", { after: "CONFIRM_ACTION" });
      }

      const before = signature(obs);
      const prev = obs;
      let hit: string | undefined;
      trace.steps = step;
      trace.lastAction = label;
      emit("computer.action", { step, action: d.action, label: key, think: d.think, stage: d.stage ?? trace.current?.id, expect: d.expect, status: "started" });
      let actionError: string | null = null;
      try {
        switch (d.action) {
          case "navigate":
            await browser.navigate(d.url);
            break;
          case "click":
            await browser.click(d.target);
            break;
          case "click_at":
            hit = (await browser.clickAt(d.x, d.y))?.hit;
            break;
          case "hover":
            await browser.hover(d.target, d.x, d.y);
            break;
          case "type":
            await browser.type(d.target, d.text, d.submit);
            break;
          case "press":
            await browser.press(d.key);
            break;
          case "scroll":
            await browser.scroll(d.direction, d.amount);
            break;
          case "wait":
            await browser.wait(d.ms ?? 1000);
            break;
          case "back":
            await browser.back();
            break;
          case "open_app":
            if (!browser.openApp) throw new Error("open_app działa tylko w trybie desktop");
            await browser.openApp(d.app);
            break;
        }
      } catch (e) {
        actionError = (e as Error).message.split("\n")[0].slice(0, 280);
      }
      if (aborted()) {
        emit("computer.action", { step, action: d.action, label: key, status: actionError ? "failed" : "completed", error: actionError ?? undefined });
        break;
      }
      const visitsBefore = trace.visits.length;
      obs = await observe(); // VERIFY: nowa obserwacja, decyzja w następnej iteracji
      const changed = signature(obs) !== before;
      const outcome = describeOutcome({ d, prev, obs, changed, actionError, hit });
      // „brak elementu”, bo strona zdążyła przejść dalej po wcześniejszym kliknięciu = spóźniona nawigacja, nie porażka
      const late = !!actionError && pageKey(obs.url) !== pageKey(prev.url);
      if (actionError && !late) trace.failures.push(`${label}: ${actionError}`);
      // jeden event po akcji, już z efektem i adresem — panel pokazuje, co akcja dała, a nie tylko, że „się wykonała”
      emit("computer.action", { step, action: d.action, label: key, status: actionError && !late ? "failed" : "completed", error: actionError && !late ? actionError : undefined, outcome, url: obs.url });
      // nowa strona to postęp — chyba że trafiliśmy na nią, powtarzając w kółko tę samą akcję (każde losowanie = „nowa” strona)
      if (trace.visits.length > visitsBefore && repeatNo < REPEAT_LIMIT) lastProgress = step;
      trace.lastAction = `${label} → ${outcome}`;
      const stageNo = d.stage ?? trace.current?.id;
      trace.history.push({ step, stage: stageNo, label, think: d.think, outcome });
      // log z intencją: model w następnym kroku wie, PO CO to zrobił, a nie tylko CO kliknął
      log.push(`${step}.${stageNo ? ` [etap ${stageNo}]` : ""} ${label}${d.think ? ` — po co: ${d.think}` : ""} → ${outcome}`);
      expect = d.expect?.trim() || undefined;
      // etapy z warunkiem zalicza executor (tylko przeglądarka): po akcji, na świeżej obserwacji
      if (mode === "browser") {
        for (const s of trace.auto(obs)) {
          lastProgress = step;
          repeats.clear();
          emit("computer.stage", { id: s.id, title: s.title, status: "done", auto: true, by: s.doneBy, next: trace.current?.id ?? null });
          log.push(`${step}. ✓ etap ${s.id} „${s.title}” ZALICZONY AUTOMATYCZNIE (${s.doneBy}) — ten etap jest zrobiony; NIE powtarzaj akcji, która do niego doprowadziła${trace.current ? ` — teraz etap ${trace.current.id}` : " — wszystkie etapy zrobione → done z raportem"}`);
        }
      }

      // PĘTLA: ta sama akcja na tej samej stronie, a strona się nie zmienia (wait/scroll liczone po typie)
      const loopKey = `${pageKey(obs.url)}|${d.action === "wait" || d.action === "scroll" ? d.action : key}`;
      streak = loopKey !== lastKey ? 0 : !changed || actionError ? streak + 1 : 0;
      lastKey = loopKey;
      if (streak + 1 >= LOOP_REPEATS) {
        const desc = `${label} na ${obs.url} — ${streak + 1}× bez zmiany strony`;
        trace.loops.push(desc);
        emit("computer.loop", { description: desc, count: streak + 1, strategyChange: trace.loops.length < MAX_LOOPS });
        if (trace.loops.length >= MAX_LOOPS) return finish(trace.notes.length || trace.visits.length > 1 ? "partial" : "failed", `utknąłem: ${trace.loops.length} pętle mimo zmian strategii — ostatnia: ${desc}`);
        log.push(`${step}. (PĘTLA: ${desc}. ZMIEŃ STRATEGIĘ — inny element, scroll do celu, inny adres, wyszukiwarka (navigate https://duckduckgo.com/html/?q=…), albo "done" z tym, co już wiesz. NIE powtarzaj „${key}”.)`);
        streak = 0;
        lastKey = "";
      } else if (d.action === "wait" && streak >= 1) {
        log.push(`${step}. (${key} ×${streak + 1} — strona się nie zmienia; czekanie nie pomaga: kliknij, scrolluj, navigate albo zakończ done/fail)`);
      }

      // POWTARZANIE: ta sama intencja N× od ostatniego etapu, choć strona za każdym razem się zmienia — akcja działa, to decydent nie uznaje wyniku
      if (changed && !actionError && repeatNo >= REPEAT_LIMIT && repeatNo % REPEAT_LIMIT === 0) {
        const desc = `${label} powtórzone ${repeatNo}× (strona za każdym razem się zmieniała)`;
        trace.loops.push(desc);
        emit("computer.loop", { description: desc, count: repeatNo, strategyChange: trace.loops.length < MAX_LOOPS });
        if (trace.loops.length >= MAX_LOOPS) return finish(trace.notes.length || trace.visits.length > 1 ? "partial" : "failed", `utknąłem: ${trace.loops.length} pętle — ostatnia: ${desc}`);
        log.push(`${step}. (POWTARZASZ: „${label}” już ${repeatNo}× i za każdym razem strona się zmieniła — ta akcja DZIAŁA. Obecna strona (${obs.title || obs.url}) jest jej wynikiem. Jeśli cel jest losowy/dowolny — odczytaj TĘ stronę i "done". NIE powtarzaj tej akcji ani jej odpowiednika (navigate pod ten sam adres).)`);
      }

      // BRAK POSTĘPU: N kroków bez zrobionego etapu, nowej notatki i nowego miejsca — przeplanuj (różne akcje w kółko też się liczą)
      if (step - lastProgress >= NO_PROGRESS) {
        const why = `${step - lastProgress} kroków bez postępu (ostatnio: ${trace.history.slice(-3).map((h) => h.label).join(", ")})`;
        trace.loops.push(why);
        emit("computer.loop", { description: why, count: step - lastProgress, strategyChange: true });
        const r = await replan(step, why);
        if (r) return r;
        if (!o.planner || replans >= MAX_REPLANS || budget <= step) return finish(trace.notes.length || trace.stages.some((s) => s.status === "done") ? "partial" : "failed", `brak postępu — ${why}`);
        lastProgress = step;
      } else if (step === budget && budget < o.maxSteps) {
        // budżet z planu się skończył, a twardy limit jeszcze nie — jedna szansa na przeplanowanie
        const r = await replan(step, `budżet z planu (${budget} kroków) wyczerpany, ${trace.stages.filter((s) => s.status === "done").length}/${trace.stages.length} etapów zrobionych`);
        if (r) return r;
      }
    }
  } catch (e) {
    if (!aborted()) {
      trace.failures.push((e as Error).message.split("\n")[0].slice(0, 200));
      return finish("failed", (e as Error).message.split("\n")[0].slice(0, 200));
    }
  }
  if (aborted()) return finish("cancelled_by_user", "user anulował zadanie — poniżej to, co zdążyłem zrobić i zobaczyć");
  return finish(trace.notes.length || trace.visits.length > 1 ? "partial" : "failed", `limit ${budget} kroków — cel nieosiągnięty, raport z tego, co zebrane`);
}
