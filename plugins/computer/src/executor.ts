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
//   computer.stage niesie też kind (state|action|info), by (dowód) i why (czemu nie zaliczono); status: done|unconfirmed|unmet
//   computer.verify { ok, repair, unmet[] } — executor sprawdził „done” decydenta: czego brakuje i czy daje jedno podejście naprawcze
//
// WERYFIKACJA (tylko przeglądarka): status „ok” nie zależy już od słowa decydenta. Każdy etap ma typ i dowód sprawdzany w kodzie:
// stan → warunek na adres/tekst · akcja → krok (klik/wpisanie), po którym strona się zmieniła · informacja → dosłowny cytat z tekstu strony.
// „done” z niespełnionym etapem → jedno podejście naprawcze (kilka kroków), potem koniec jako partial z listą, czego nie zrobiono.
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
import type { Decider, Decision, StageClaim } from "./decider.js";
import { bareUrl, budgetFor, checkStage, type Planner, type Stage, type StageKind, type TaskPlan } from "./planner.js";

export type ComputerStatus = "ok" | "partial" | "cancelled_by_user" | "failed";

/** To, czego executor potrzebuje od przeglądarki (testy podstawiają atrapę). */
export type BrowserLike = Pick<BrowserRuntime, "observe" | "navigate" | "click" | "hover" | "type" | "press" | "scroll" | "wait" | "back"> & {
  /** przeglądarka zwraca `hit` — co leżało w klikanym punkcie; desktop i atrapy mogą nie zwracać nic */
  clickAt(x: number, y: number): Promise<{ hit?: string } | void>;
  /** nowe karty otwarte przez ostatnią akcję (przeglądarka już je zamknęła) — idą do efektu akcji */
  takePopups?(): Promise<string[]>;
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
  /** Wymagania od zlecającego (<done_when> w celu) — każde musi być etapem planu i przejść weryfikację. */
  required?: string[];
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
/** Tyle kroków dostaje decydent na jedno podejście naprawcze po odrzuconym „done”. */
const REPAIR_STEPS = 8;
/** Akcje, które mogą być dowodem etapu typu „akcja” (nawigacja, scroll i czekanie niczego nie ustawiają). */
const INTERACT = new Set(["click", "click_at", "type", "press"]);
const KIND_PL: Record<StageKind, string> = { state: "stan", action: "akcja", info: "informacja" };
const kindOf = (s: Stage): StageKind => s.kind ?? "state";
/** Tekst do porównywania cytatów: małe litery, same litery i cyfry (interpunkcja, spacje i cudzysłowy nie mają znaczenia). */
const normText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Wymaganie od zlecającego, którego planner nie ujął w planie: typ z treści („kliknij filtr” = akcja, „podaj cenę” = informacja). */
const guessKind = (t: string): StageKind => (/klikn|filtr|ustaw|wybierz|wpisz|posortuj|zaznacz|wyślij|użyj|przełącz/i.test(t) ? "action" : /podaj|podan|odczyt|opisz|wypisz|ile |cen[aęy]|list[aęy] /i.test(t) ? "info" : "state");
type Verdict = { ok: true; by: string; step?: number } | { ok: false; why: string };
type Problem = { stage: Stage; status: "unmet" | "unconfirmed"; why: string; blocked: boolean };
/** „Miękki” problem nie psuje statusu ok: informacja podana bez cytatu (np. odczytana z obrazu) — raport ją oznacza, sim ocenia. */
const isSoft = (p: Problem) => kindOf(p.stage) === "info" && p.status === "unconfirmed";

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
const overlayOf = (o: Observation) => o.hints.find((h) => h.startsWith("OVERLAY:"));
const overlayPct = (h: string | undefined) => /(\d+)% ekranu/.exec(h ?? "")?.[1] ?? "?";
/** Czy akcja coś zmieniła? To, co widać: adres, tytuł, początek tekstu, liczba elementów — i czy stronę zasłania nakładka (ile elementów). */
const signature = (o: Observation) => `${pageKey(o.url)}|${o.title}|${o.elements.length}|${overlayOf(o) ? "overlay" : ""}|${o.elements.filter((e) => e.occluded).length}|${o.text.slice(0, 400)}`;
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
function describeOutcome(x: { d: Decision; prev: Observation; obs: Observation; changed: boolean; actionError: string | null; hit?: string; popups?: string[] }): string {
  const { d, prev, obs, changed, actionError, hit, popups } = x;
  const moved = pageKey(obs.url) !== pageKey(prev.url);
  const here = `${obs.url}${obs.title ? ` „${obs.title.slice(0, 60)}”` : ""}`;
  if (actionError) return moved ? `NIE WYKONANO (${actionError}) — bo strona w międzyczasie przeszła na ${here}: wcześniejsza akcja zadziałała z opóźnieniem. To nie błąd strony; pracuj na nowej obserwacji.` : `BŁĄD: ${actionError}`;
  // nakładka: zamknięcie reklamy nie zmienia adresu ani tekstu strony — bez tego decydent słyszał „bez zmian” po udanym kliknięciu w X
  const was = overlayOf(prev), is = overlayOf(obs);
  const overlay = was && !is ? " · NAKŁADKA ZNIKNĘŁA — strona jest odsłonięta, nie zamykaj jej drugi raz" : was && is ? ` · nakładka DALEJ zasłania ${overlayPct(is)}% ekranu` : !was && is ? ` · pojawiła się nakładka (${overlayPct(is)}% ekranu)` : "";
  const popup = popups?.length ? ` · klik otworzył nową kartę: ${popups[0]} — zamknąłem ją (zwykle reklama; jeśli to był cel, wejdź tam przez navigate)` : "";
  const tail = `${hit ? ` · trafiono w: ${hit}` : ""}${overlay}${popup}`;
  if (d.action === "navigate") {
    if (/^chrome-error:/i.test(obs.url)) return "BŁĄD: strona się nie załadowała (błąd sieci albo zły adres)";
    if (flatUrl(d.url) === flatUrl(obs.url)) return `ok — otwarto ${here}${overlay}`;
    if (!moved && !changed) return `nie zadziałało — adres się nie otworzył, dalej jesteś na ${here}`;
    return `ok — PRZEKIEROWANO na ${here}. To JEST wynik tej akcji (adres ${bareUrl(d.url)} sam przenosi dalej) — nie powtarzaj jej.${overlay}`;
  }
  if (moved) return `ok — nowa strona: ${here}${tail}`;
  if (was && !is) return `ok${tail}`;
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
  history: { step: number; stage?: number; label: string; think?: string; outcome: string; action: string; ok: boolean; changed: boolean }[] = [];
  /** Pełny tekst odwiedzonych stron (ostatni stan każdej) — tylko do sprawdzania cytatów; do modelu nie idzie. */
  texts = new Map<string, { url: string; text: string; norm: string }>();
  /** Potwierdzone cytaty z kontekstem — sekcja DOWODY Z EKRANU w raporcie. */
  proofs: { stage: number; quote: string; url: string; context: string }[] = [];

  constructor(readonly goal: string, public budget: number, readonly mode: "browser" | "desktop" = "browser") {}
  /** Weryfikacja dowodów działa w przeglądarce; desktop zostaje przy słowie decydenta (osobny etap prac). */
  get strict() {
    return this.mode === "browser";
  }

  /** Bieżący etap = pierwszy otwarty (ani zrobiony, ani pominięty). */
  get current() {
    return this.stages.find((s) => s.status === "todo" || s.status === "doing");
  }
  /** Czy cytat jest w tekście którejś odwiedzonej strony? Zwraca adres i kontekst (do DOWODÓW) albo null. */
  findQuote(quote: string): { url: string; context: string } | null {
    const q = normText(quote);
    if (q.length < 3) return null;
    for (const p of [...this.texts.values()].reverse()) {
      if (!p.norm.includes(q)) continue;
      // kontekst z oryginalnego tekstu: szukamy pierwszego słowa cytatu, bierzemy okolicę
      const first = quote.trim().split(/\s+/)[0].toLowerCase();
      const at = Math.max(0, p.text.toLowerCase().indexOf(first));
      return { url: p.url, context: p.text.slice(Math.max(0, at - 60), at + quote.length + 100).replace(/\s+/g, " ").trim() };
    }
    return null;
  }
  /**
   * Czy dowód decydenta wystarcza, żeby zaliczyć etap? Zależy od typu:
   * stan — warunek `check` na bieżącej stronie; bez warunku wystarcza słowo decydenta (asserted) ·
   * akcja — krok K istnieje, był kliknięciem/wpisaniem, zmienił stronę i nie jest już dowodem innego etapu ·
   * informacja — cytat jest w tekście którejś odwiedzonej strony.
   */
  verifyClaim(s: Stage, c: { step?: number; quote?: string; asserted?: boolean }): Verdict {
    const kind = kindOf(s);
    const byStep = (n: number): Verdict => {
      const h = this.history.find((x) => x.step === n);
      if (!h) return { ok: false, why: `nie ma kroku ${n} w przebiegu` };
      if (!INTERACT.has(h.action)) return { ok: false, why: `krok ${n} (${h.label}) to nie kliknięcie ani wpisanie — niczego na stronie nie ustawił` };
      if (!h.ok || !h.changed) return { ok: false, why: `krok ${n} (${h.label}) nic nie zmienił na stronie` };
      const other = this.stages.find((x) => x !== s && x.status === "done" && x.doneStep === n);
      if (other) return { ok: false, why: `krok ${n} (${h.label}) zaliczył już etap ${other.id} „${other.title}” — jedna akcja nie jest dowodem dwóch wymagań` };
      return { ok: true, by: `krok ${n}: ${h.label}`, step: n };
    };
    const byQuote = (q: string): Verdict => {
      const hit = this.findQuote(q);
      if (!hit) return { ok: false, why: `cytatu „${q.slice(0, 60)}” nie ma w tekście odwiedzonych stron` };
      if (!this.proofs.some((p) => p.stage === s.id && p.quote === q)) this.proofs.push({ stage: s.id, quote: q.slice(0, 120), url: hit.url, context: hit.context });
      return { ok: true, by: `cytat „${q.slice(0, 60)}”` };
    };
    const step = Number.isInteger(c.step) ? (c.step as number) : undefined;
    const quote = typeof c.quote === "string" && c.quote.trim() ? c.quote.trim() : undefined;
    if (kind === "action") return step === undefined ? { ok: false, why: "brak dowodu: nie wskazano kroku, w którym to kliknięto/ustawiono" } : byStep(step);
    if (kind === "info") return quote ? byQuote(quote) : { ok: false, why: "bez cytatu z tekstu strony (np. odczytane tylko ze zrzutu)" };
    if (s.check) {
      const by = this.lastObs ? checkStage(s.check, this.lastObs) : null;
      return by ? { ok: true, by } : { ok: false, why: "warunek etapu nie jest spełniony na bieżącej stronie" };
    }
    if (quote) return byQuote(quote);
    if (step !== undefined) return byStep(step);
    return c.asserted ? { ok: true, by: "decydent" } : { ok: false, why: "nierozliczony: decydent zakończył bez słowa o tym etapie" };
  }
  private markDone(s: Stage, v: Extract<Verdict, { ok: true }>) {
    s.status = "done";
    s.doneBy = v.by;
    if (v.step !== undefined) s.doneStep = v.step;
    s.why = undefined;
    const next = this.current;
    if (next) next.status = "doing";
  }
  /**
   * stage_done od decydenta. W przeglądarce etap jest zaliczony dopiero, gdy dowód przejdzie weryfikację — inaczej wraca powód odrzucenia.
   * Wcześniejsze otwarte etapy ZOSTAJĄ otwarte (kiedyś stawały się „pominięte” — to kłamało).
   */
  advance(d: Decision): { done: Stage } | { rejected: Stage; why: string } | null {
    if (!d.stage_done || !this.stages.length) return null;
    const s = this.stages.find((x) => x.id === d.stage) ?? this.current;
    if (!s || s.status === "done") return null;
    const v: Verdict = this.strict ? this.verifyClaim(s, { step: d.proof_step, quote: d.proof_quote, asserted: true }) : { ok: true, by: "decydent" };
    if (!v.ok) {
      s.why = v.why;
      return { rejected: s, why: v.why };
    }
    this.markDone(s, v);
    return { done: s };
  }
  /**
   * Rozliczenie przy „done”: każdy niezaliczony etap dostaje werdykt z dowodu decydenta (pole stages) albo z samej strony.
   * final=false — tylko sprawdzamy (przed podejściem naprawczym), final=true — statusy idą do raportu.
   */
  settle(claims: StageClaim[] | undefined, final: boolean): { fresh: Stage[]; problems: Problem[] } {
    const fresh: Stage[] = [], problems: Problem[] = [];
    for (const s of this.stages) {
      if (s.status === "done") continue;
      const c = (Array.isArray(claims) ? claims : []).find((x) => x && Number(x.id) === s.id);
      let p: Problem;
      if (c && c.met === false) p = { stage: s, status: "unmet", why: (c.why || "decydent: nie zrobione").slice(0, 200), blocked: c.blocked === true };
      else {
        const v = this.verifyClaim(s, { step: c?.step, quote: c?.quote, asserted: !!c });
        if (v.ok) {
          this.markDone(s, v);
          fresh.push(s);
          continue;
        }
        p = { stage: s, status: c ? "unconfirmed" : "unmet", why: v.why, blocked: false };
      }
      s.why = p.why;
      if (final) {
        s.status = p.status;
        s.blocked = p.blocked;
      }
      problems.push(p);
    }
    return { fresh, problems };
  }
  /** Etapy z warunkiem `check` zalicza executor sam, z obserwacji — bez czekania, aż model przypomni sobie o stage_done. */
  auto(o: Observation, step: number): Stage[] {
    const done: Stage[] = [];
    for (const s of this.stages) {
      if (s.status === "done" || !s.check || kindOf(s) !== "state") continue;
      const by = checkStage(s.check, o);
      if (!by) continue;
      s.status = "done";
      s.doneBy = by;
      s.doneStep = step;
      s.why = undefined;
      done.push(s);
    }
    const next = this.current;
    if (done.length && next && next.status === "todo") next.status = "doing";
    return done;
  }
  /** Zadanie skończone „done”: etapy, których nikt nie zaliczył, są NIEPOTWIERDZONE (nie „niepotrzebne”). Zwraca je. */
  closeOpen(): Stage[] {
    const open = this.stages.filter((s) => s.status === "todo" || s.status === "doing");
    for (const s of open) s.status = "unconfirmed";
    return open;
  }
  planText(): string {
    if (!this.stages.length) return "";
    const cur = this.current;
    const tag = (s: Stage) => (this.strict ? ` [${KIND_PL[kindOf(s)]}]` : "");
    const lines = this.stages.map((s) => (s.status === "done" ? `✓ ${s.id}. ${s.title}${tag(s)} — ZROBIONY (${s.doneBy ?? "zaliczony"})` : `${s === cur ? "→" : "·"} ${s.id}. ${s.title}${tag(s)} — zrobione, gdy: ${s.doneWhen}${s.check ? " [executor sprawdza sam]" : ""}${s.why ? ` (NIE ZALICZONO: ${s.why})` : ""}`));
    return `${lines.join("\n")}${cur ? "" : "\nWSZYSTKIE ETAPY ZROBIONE → zwróć \"done\" z raportem."}`;
  }

  visit(o: Observation, start = false) {
    this.lastObs = o;
    if (o.url && o.url !== "about:blank") {
      const text = o.fullText ?? o.text;
      const k = pageKey(o.url);
      this.texts.delete(k); // na koniec kolejki — najświeższe strony zostają
      this.texts.set(k, { url: o.url, text, norm: normText(text) });
      if (this.texts.size > 12) this.texts.delete(this.texts.keys().next().value as string);
    }
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
    if (this.stages.length && this.strict) {
      // przeglądarka: każdy etap to wymaganie z dowodem sprawdzonym w kodzie — sim widzi, co potwierdzone, a co tylko zadeklarowane
      const row = (s: Stage) => {
        const k = ` [${KIND_PL[kindOf(s)]}]`;
        if (s.status === "done") return `✓ ${s.id}. ${s.title}${k}${s.doneBy ? ` — ${s.doneBy}` : ""}`;
        if (s.status === "unconfirmed") return `? ${s.id}. ${s.title}${k} — NIEPOTWIERDZONE: ${s.why ?? "brak dowodu"}`;
        return `✗ ${s.id}. ${s.title}${k} — NIEZROBIONE${s.blocked ? " (nie da się)" : ""}: ${s.why ?? "zadanie skończyło się wcześniej"}`;
      };
      lines.push(`WYMAGANIA (✓ potwierdzone dowodem · ? zadeklarowane, ale niepotwierdzone — nie traktuj jako pewne · ✗ niezrobione):\n${this.stages.map(row).join("\n")}`);
      if (this.proofs.length) lines.push(`DOWODY Z EKRANU (cytaty znalezione w tekście strony):\n${this.proofs.slice(-8).map((p) => `- [${p.stage}] „${p.quote}” — ${p.url}\n  …${p.context}…`).join("\n")}`);
    } else if (this.stages.length) {
      // desktop: bez weryfikacji dowodów — ✓ zaliczony · ? niepotwierdzony (zakończone bez zaliczenia etapu) · ✗ niezrobiony
      lines.push(`PLAN (✓ zaliczony · ? niepotwierdzony: executor zakończył bez zaliczenia tego etapu — nie wiadomo, czy zrobiony${status === "ok" ? "" : " · ✗ niezrobiony"}):\n${this.stages.map((s) => `${s.status === "done" ? "✓" : s.status === "unconfirmed" || s.status === "skipped" || status === "ok" ? "?" : "✗"} ${s.id}. ${s.title}${s.status === "done" && s.doneBy ? ` (${s.doneBy})` : ""}`).join("\n")}`);
    }
    if (this.history.length) {
      const h = this.history.length > 20 ? [`(… ${this.history.length - 20} wcześniejszych kroków)`, ...this.history.slice(-20).map(fmtStep)] : this.history.map(fmtStep);
      lines.push(`PRZEBIEG (krok · akcja · po co · efekt):\n${h.join("\n")}`);
    }
    if (this.start && this.start.url !== "about:blank") lines.push(`START (strona otwarta przed zadaniem, nie jest częścią wyniku): ${this.start.title || "(bez tytułu)"} — ${this.start.url}`);
    if (this.visits.length) lines.push(`ODWIEDZONE (kolejno):\n${this.visits.map((v, i) => `${i + 1}. ${v.title || "(bez tytułu)"} — ${v.url}`).join("\n")}`);
    if (this.notes.length) lines.push(`ZEBRANE PO DRODZE (surowe notatki z kolejnych kroków — przy różnicach obowiązuje WYNIK):\n${this.notes.map((n) => `- ${n}`).join("\n")}`);
    if (this.handoffs.length) lines.push(`USER: ${this.handoffs.join("; ")}`);
    const bad = [...this.loops.map((l) => `pętla: ${l}`), ...this.failures];
    if (bad.length) lines.push(`NIE ZADZIAŁAŁO (potknięcia WYKONAWCY — celowanie, pętle, kolejność; to nie są cechy tej strony i nie nadają się na nauczkę o niej):\n${bad.slice(-8).map((b) => `- ${b}`).join("\n")}`);
    if (o && o.url !== "about:blank") {
      const text = o.text.replace(/\n{2,}/g, "\n").trim().slice(0, 700);
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
  /** fromDone: decydent zgłosił „done”, weryfikacja znalazła braki → partial, ale to dalej wynik (computer.completed), nie awaria. */
  const finish = (status: ComputerStatus, headline: string, fromDone = false): ToolResult => {
    if (status === "ok") for (const s of trace.closeOpen()) emit("computer.stage", { id: s.id, title: s.title, status: "unconfirmed", next: null });
    const text = trace.report(status, headline);
    const requirements = trace.stages.map((s) => ({ id: s.id, title: s.title, kind: kindOf(s), status: s.status, by: s.doneBy, why: s.why, req: s.req }));
    const data = { status, steps: trace.steps, url: trace.lastObs?.url, title: trace.lastObs?.title, visited: trace.visits.map((v) => v.url), notes: trace.notes, requirements };
    if (status === "ok" || (status === "partial" && fromDone)) emit("computer.completed", { result: headline, steps: trace.steps, url: trace.lastObs?.url, status, unmet: trace.stages.filter((s) => s.status === "unmet" || s.status === "unconfirmed").map((s) => ({ id: s.id, title: s.title, status: s.status, why: s.why })) });
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
    // replan nie kasuje tego, co już potwierdzone dowodem: zaliczone wymagania zlecającego przechodzą do nowego planu
    const kept = trace.stages.filter((s) => s.status === "done" && s.req);
    const planned = p.stages.filter((s) => !kept.some((k) => k.req === s.req && s.req));
    // wymaganie zlecającego, którego planner nie ujął (albo zgubił przy replanie), wraca jako osobny etap — nie da się go pominąć
    const missing: Stage[] = (o.required ?? []).map((r, i) => ({ r, n: i + 1 })).filter(({ n }) => ![...kept, ...planned].some((s) => s.req === n)).map(({ r, n }) => ({ id: 0, title: r.slice(0, 120), doneWhen: r.slice(0, 200), kind: guessKind(r), req: n, status: "todo" as const }));
    let firstOpen = true;
    trace.stages = [...kept, ...planned, ...missing].map((s, i) => {
      if (s.status === "done") return { ...s, id: i + 1 };
      // warunek spełniony już na obserwacji, na której powstał plan, niczego nie sprawdza („tytuł zawiera »serenad«” na stronie,
      // na której już jesteśmy) — zaliczyłby etap po pierwszej dowolnej akcji. Taki etap zostaje bez warunku: zalicza go decydent.
      const check = s.check && mode === "browser" && kindOf(s) === "state" && !checkStage(s.check, obs) ? s.check : undefined;
      const status = firstOpen ? ("doing" as const) : ("todo" as const);
      firstOpen = false;
      return { ...s, id: i + 1, check, status };
    });
    budget = Math.min(o.maxSteps, step + budgetFor(p.estimatedSteps, o.maxSteps));
    trace.budget = budget;
    emit("computer.plan", { replan, alreadyDone: p.alreadyDone, why: p.why, estimatedSteps: p.estimatedSteps, budget, cap: o.maxSteps, stages: trace.stages.map((s) => ({ id: s.id, title: s.title, doneWhen: s.doneWhen, kind: kindOf(s), check: s.check, req: s.req, by: s.doneBy, status: s.status })) });
  };
  if (o.planner) {
    try {
      const p = await o.planner.plan({ goal: o.goal, context: o.context, observation: obs, mode, cap: o.maxSteps, required: o.required }, call.signal);
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
      const p = await o.planner.plan({ goal: o.goal, context: o.context, observation: obs, mode, cap: o.maxSteps, required: o.required, previous: { stages: trace.stages, report: trace.report("partial", why), stepsLeft: o.maxSteps - step } }, call.signal);
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
  /** Podejście naprawcze po odrzuconym „done” — najwyżej jedno. pendingResult = wynik z tamtego „done” (gdyby zabrakło kroków). */
  let repaired = false;
  let pendingResult: string | undefined;
  /** Ostateczne rozliczenie „done”: statusy etapów do raportu, ok tylko gdy nie ma twardych braków. */
  const finishDone = (result: string, claims: StageClaim[] | undefined): ToolResult => {
    const { fresh, problems } = trace.settle(claims, true);
    for (const s of fresh) emit("computer.stage", { id: s.id, title: s.title, kind: kindOf(s), status: "done", by: s.doneBy, next: null });
    for (const p of problems) emit("computer.stage", { id: p.stage.id, title: p.stage.title, kind: kindOf(p.stage), status: p.status, why: p.why, blocked: p.blocked || undefined, next: null });
    const hard = problems.filter((p) => !isSoft(p));
    emit("computer.verify", { ok: !hard.length, repair: false, unmet: problems.map((p) => ({ id: p.stage.id, title: p.stage.title, kind: kindOf(p.stage), status: p.status, why: p.why })) });
    return finish(hard.length ? "partial" : "ok", result, true);
  };
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
      const adv = trace.advance(d);
      if (adv && "done" in adv) {
        const doneStage = adv.done;
        lastProgress = step;
        repeats.clear();
        emit("computer.stage", { id: doneStage.id, title: doneStage.title, kind: kindOf(doneStage), status: "done", by: doneStage.doneBy, next: trace.current?.id ?? null });
        log.push(`${step}. ✓ etap ${doneStage.id} „${doneStage.title}” zrobiony (${doneStage.doneBy})${trace.current ? ` — teraz etap ${trace.current.id}` : " — wszystkie etapy zrobione → done"}`);
      } else if (adv && d.action !== "done") {
        // dowód nie przeszedł: etap zostaje otwarty, decydent dostaje powód (przy „done” powie mu to weryfikacja niżej)
        log.push(`${step}. ✗ etap ${adv.rejected.id} „${adv.rejected.title}” NIE zaliczony — ${adv.why}. ${kindOf(adv.rejected) === "action" ? "Najpierw wykonaj tę akcję na stronie, potem zalicz etap z \"proof_step\": numer tego kroku." : kindOf(adv.rejected) === "info" ? "Podaj \"proof_quote\": dosłowny fragment tekstu strony." : ""}`);
      }

      // koniec? W przeglądarce „done” przechodzi weryfikację: braki → jedno podejście naprawcze, potem partial z listą.
      if (d.action === "done") {
        const result = (d.result || "").trim() || `Zrobione. Strona: ${obs.title || obs.url}`;
        if (!trace.strict || !trace.stages.length) return finish("ok", result);
        const canRepair = !repaired && step < o.maxSteps;
        const dry = trace.settle(d.stages, false);
        const fixable = dry.problems.filter((p) => !p.blocked && !isSoft(p));
        for (const s of dry.fresh) emit("computer.stage", { id: s.id, title: s.title, kind: kindOf(s), status: "done", by: s.doneBy, next: trace.current?.id ?? null });
        if (fixable.length && canRepair) {
          repaired = true;
          pendingResult = result;
          budget = Math.min(o.maxSteps, Math.max(budget, step + REPAIR_STEPS));
          trace.budget = budget;
          lastProgress = step;
          emit("computer.verify", { ok: false, repair: true, steps: budget - step, unmet: fixable.map((p) => ({ id: p.stage.id, title: p.stage.title, kind: kindOf(p.stage), why: p.why })) });
          log.push(`${step}. (WERYFIKACJA: "done" odrzucone — zadanie NIE jest skończone. Brakuje: ${fixable.map((p) => `etap ${p.stage.id} „${p.stage.title}” [${KIND_PL[kindOf(p.stage)]}] — ${p.why}`).join(" · ")}. Masz jeszcze ${budget - step} kroków: zrób to, czego brakuje (albo podaj poprawny dowód), potem "done" z polem "stages". Jeśli się nie da — w "stages" daj "met":false,"blocked":true i powód.)`);
          continue;
        }
        return finishDone(result, d.stages);
      }
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
      const popups = (await browser.takePopups?.().catch(() => [] as string[])) ?? [];
      const visitsBefore = trace.visits.length;
      obs = await observe(); // VERIFY: nowa obserwacja, decyzja w następnej iteracji
      const changed = signature(obs) !== before;
      const outcome = describeOutcome({ d, prev, obs, changed, actionError, hit, popups });
      // „brak elementu”, bo strona zdążyła przejść dalej po wcześniejszym kliknięciu = spóźniona nawigacja, nie porażka
      const late = !!actionError && pageKey(obs.url) !== pageKey(prev.url);
      if (actionError && !late) trace.failures.push(`${label}: ${actionError}`);
      // jeden event po akcji, już z efektem i adresem — panel pokazuje, co akcja dała, a nie tylko, że „się wykonała”
      emit("computer.action", { step, action: d.action, label: key, status: actionError && !late ? "failed" : "completed", error: actionError && !late ? actionError : undefined, outcome, url: obs.url });
      // nowa strona to postęp — chyba że trafiliśmy na nią, powtarzając w kółko tę samą akcję (każde losowanie = „nowa” strona)
      if (trace.visits.length > visitsBefore && repeatNo < REPEAT_LIMIT) lastProgress = step;
      trace.lastAction = `${label} → ${outcome}`;
      const stageNo = d.stage ?? trace.current?.id;
      trace.history.push({ step, stage: stageNo, label, think: d.think, outcome, action: d.action, ok: !actionError, changed });
      // log z intencją: model w następnym kroku wie, PO CO to zrobił, a nie tylko CO kliknął
      log.push(`${step}.${stageNo ? ` [etap ${stageNo}]` : ""} ${label}${d.think ? ` — po co: ${d.think}` : ""} → ${outcome}`);
      expect = d.expect?.trim() || undefined;
      // etapy z warunkiem zalicza executor (tylko przeglądarka): po akcji, na świeżej obserwacji
      if (mode === "browser") {
        for (const s of trace.auto(obs, step)) {
          lastProgress = step;
          repeats.clear();
          emit("computer.stage", { id: s.id, title: s.title, kind: kindOf(s), status: "done", auto: true, by: s.doneBy, next: trace.current?.id ?? null });
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
  if (pendingResult) return finishDone(pendingResult, undefined);
  return finish(trace.notes.length || trace.visits.length > 1 ? "partial" : "failed", `limit ${budget} kroków — cel nieosiągnięty, raport z tego, co zebrane`);
}
