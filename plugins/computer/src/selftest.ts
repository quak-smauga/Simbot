// SELFTEST executora computer.run — atrapa przeglądarki + skryptowany decydent, bez Playwrighta i bez API.
// Sprawdza: raport przy anulowaniu (z wynikiem zebranym po drodze), wykrywanie pętli z opisem i zmianą strategii,
// okrążenia X → Y → Z → X, przekazanie kontroli userowi (czekanie ≠ anulowanie), efekt akcji (przekierowanie, spóźniona nawigacja,
// punkt trafienia click_at), etapy zaliczane z warunku planu, strona startowa poza odwiedzonymi.
import assert from "node:assert/strict";
import type { AgentEvent, ToolCallContext } from "@qwe/core";
import type { Observation } from "./browser.js";
import type { Decider, DeciderInput, Decision } from "./decider.js";
import { runComputerTask, type BrowserLike } from "./executor.js";

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

function fakeBrowser(pages: Record<string, { title: string; text: string }> = {}) {
  let url = "about:blank";
  let seq = 0;
  const page = () => pages[url] ?? { title: url, text: `# ${url}` };
  const b: BrowserLike = {
    async observe(): Promise<Observation> {
      return { url, title: url === "about:blank" ? "" : page().title, text: url === "about:blank" ? "" : page().text, hints: [], elements: [{ id: 1, role: "button", name: "Graj", inViewport: true }], screenshot: Buffer.alloc(0), observationId: `obs_${++seq}`, at: Date.now() };
    },
    async navigate(u: string) { url = /^https?:/.test(u) ? u : `https://${u}`; },
    async click() {},
    async clickAt() {},
    async hover() {},
    async type() {},
    async press() {},
    async scroll() {},
    async wait() {},
    async back() {},
  };
  return b;
}

function fakeCall(ac = new AbortController()) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const waits: string[] = [];
  const call: ToolCallContext = {
    taskId: "task_t",
    signal: ac.signal,
    priorResults: {},
    emit: (type, data = {}) => { events.push({ type, data }); return { seq: events.length, type, at: "", data } as AgentEvent; },
    async waitForUser(reason) { waits.push(reason); if (ac.signal.aborted) throw new Error("anulowano"); },
    async checkpoint() { if (ac.signal.aborted) throw new Error("anulowano"); },
    screenshots: { put: () => "shot_x" },
  };
  return { call, events, waits, ac };
}

const scripted = (fn: (i: DeciderInput) => Decision, seen: DeciderInput[] = []): Decider => ({ async decide(i) { seen.push(i); return fn(i); } });
const run = (browser: BrowserLike, decider: Decider, call: ToolCallContext, maxSteps = 20) => runComputerTask({ goal: "test", context: "", maxSteps, browser, decider, call, log: () => {} });

console.log("computer executor:");

await test("anulowanie → raport cancelled_by_user z wynikiem zebranym po drodze (nie samo „anulowano”)", async () => {
  const { call, ac } = fakeCall();
  const r = await run(fakeBrowser({ "https://quakky.pl": { title: "Quakky", text: "# Koniec gry\nWynik: 333" } }), scripted((i) => {
    if (i.step === 1) return { action: "navigate", url: "https://quakky.pl" };
    if (i.step === 2) return { action: "click", target: 1, note: "Quakky: wynik gry 333" };
    ac.abort(); // user klika Anuluj, a decydent jeszcze „gra dalej”
    return { action: "click", target: 1 };
  }), call);
  assert.equal(r.status, "cancelled_by_user");
  assert.equal(r.ok, false);
  assert.match(r.text, /STATUS: cancelled_by_user/);
  assert.match(r.text, /wynik gry 333/);
  assert.match(r.text, /Wynik: 333/); // ostatni widok też w raporcie
  assert.match(r.text, /ODWIEDZONE \(kolejno\):\n1\. Quakky — https:\/\/quakky\.pl/);
});

await test("pętla: opis (element, URL, liczba), zmiana strategii zamiast błędu; po 3 pętlach partial z raportem", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const r = await run(fakeBrowser(), scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://gra.pl" } : { action: "click", target: 1 }), seen), call, 30);
  const loops = events.filter((e) => e.type === "computer.loop");
  assert.equal(loops.length, 3);
  assert.match(String(loops[0].data.description), /click \[1\] „Graj” \(button\) na https:\/\/gra\.pl — 3× bez zmiany strony/);
  assert.equal(loops[0].data.strategyChange, true);
  assert.ok(seen.some((i) => i.log.some((l) => /PĘTLA: .*ZMIEŃ STRATEGIĘ/.test(l))), "decydent dostaje polecenie zmiany strategii");
  assert.equal(r.status, "failed"); // nic nie zebrał i był na jednej stronie
  assert.match(r.text, /NIE ZADZIAŁAŁO:\n- pętla: click \[1\]/);
});

await test("X → Y → Z → X…: powrót na odwiedzoną stronę zatrzymany podpowiedzią z notatkami; raport ma kolejność i notatki", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const sites = ["https://x.pl", "https://y.pl", "https://z.pl"];
  const r = await run(fakeBrowser(), scripted((i) => ({ action: "navigate", url: sites[(i.step - 1) % 3], note: `${sites[(i.step - 1) % 3]}: cena ${100 + ((i.step - 1) % 3)} zł` }), seen), call, 30);
  assert.ok(events.some((e) => e.type === "computer.loop" && /odwiedzone już 2×/.test(String(e.data.description))));
  const last = seen.at(-1)!;
  assert.match(last.memory ?? "", /STRONY W TYM ZADANIU/);
  assert.match(last.memory ?? "", /x\.pl — https:\/\/x\.pl \(×2\)/);
  assert.match(last.memory ?? "", /NOTATKI, KTÓRE JUŻ ZEBRAŁEŚ \(nie zbieraj ich drugi raz\):\n- https:\/\/x\.pl: cena 100 zł/);
  assert.equal(r.status, "partial");
  assert.match(r.text, /ZEBRANE PO DRODZE[^\n]*:\n- https:\/\/x\.pl: cena 100 zł\n- https:\/\/y\.pl: cena 101 zł\n- https:\/\/z\.pl: cena 102 zł/);
  assert.ok(seen.length < 15, `nie kręci się do limitu kroków (decyzji: ${seen.length})`);
});

await test("logowanie: czekanie na usera i wznowienie → ok, w raporcie przekazanie kontroli", async () => {
  const { call, waits } = fakeCall();
  const r = await run(fakeBrowser(), scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://konto.pl" } : i.step === 2 ? { action: "needs_user", reason: "LOGIN_REQUIRED", message: "zaloguj się" } : { action: "done", result: "Zalogowany, saldo 12 zł" })), call);
  assert.deepEqual(waits, ["LOGIN_REQUIRED"]);
  assert.equal(r.status, "ok");
  assert.match(r.text, /WYNIK: Zalogowany, saldo 12 zł/);
  assert.match(r.text, /USER: logowanie na https:\/\/konto\.pl → wznowione/);
});

await test("anulowanie w trakcie czekania na usera → cancelled_by_user z raportem, nie wyjątek", async () => {
  const { call, ac } = fakeCall();
  const r = await run(fakeBrowser(), scripted((i) => { if (i.step === 1) return { action: "navigate", url: "https://konto.pl" }; ac.abort(); return { action: "needs_user", reason: "LOGIN_REQUIRED", message: "zaloguj się" }; }), call);
  assert.equal(r.status, "cancelled_by_user");
  assert.match(r.text, /konto\.pl/);
});

await test("desktop: chroniona aplikacja (Terminal) → każda akcja czeka na potwierdzenie; scroll/done bez pytania", async () => {
  const { call, waits, events } = fakeCall();
  const { DesktopDriver } = await import("./desktop.js");
  const drv = new DesktopDriver({ dataDir: "/nonexistent", env: {}, log: () => {} });
  Object.defineProperty(drv, "frontmost", { get: () => ({ app: "Terminal", bundleId: "com.apple.Terminal" }) });
  const opened: string[] = [];
  const b = { ...fakeBrowser(), openApp: async (n: string) => { opened.push(n); } };
  const r = await runComputerTask({ goal: "test", context: "", maxSteps: 10, browser: b, decider: scripted((i) => (i.step === 1 ? { action: "open_app", app: "Terminal" } : i.step === 2 ? { action: "type", text: "ls", submit: true } : i.step === 3 ? { action: "scroll", direction: "down" } : { action: "done", result: "ok" })), call, log: () => {}, guard: (d) => drv.guard(d) });
  assert.deepEqual(opened, ["Terminal"]);
  assert.deepEqual(waits, ["CONFIRM_ACTION", "CONFIRM_ACTION"]); // open_app + type; scroll i done bez pytania
  assert.equal(r.status, "ok");
  assert.match(r.text, /USER: potwierdził: Otworzyć Terminal\?.*; potwierdził: Terminal: wpisać „ls” \+ Enter/);
  assert.ok(events.some((e) => e.type === "computer.action" && e.data.label === "open_app Terminal"));
});

await test("desktop: brak mostu → failed z jasnym komunikatem (nie wyjątek)", async () => {
  const { call } = fakeCall();
  const { DesktopDriver } = await import("./desktop.js");
  const drv = new DesktopDriver({ dataDir: "/nonexistent", env: {}, log: () => {} });
  const r = await runComputerTask({ goal: "test", context: "", maxSteps: 5, browser: drv, decider: scripted(() => ({ action: "done", result: "x" })), call, log: () => {} });
  assert.equal(r.status, "failed");
  assert.match(r.text, /komputer niedostępny: komputer \(desktop\) niedostępny — uruchom aplikację simbot/);
});

// ───────── planner ─────────
const { budgetFor, normalizePlan } = await import("./planner.js");
type PlannerT = import("./planner.js").Planner;
type PlanIn = import("./planner.js").PlannerInput;
const fixedPlanner = (plans: ReturnType<typeof normalizePlan>[], seen: PlanIn[] = []): PlannerT => ({ async plan(i) { seen.push(i); return plans[Math.min(seen.length - 1, plans.length - 1)]; } });

await test("planner: cel już spełniony na starcie (Brave ma już nową kartę) → ok bez ani jednej akcji", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const r = await runComputerTask({ goal: "wejdź do nowej karty w Brave", context: "", maxSteps: 30, browser: fakeBrowser(), decider: scripted(() => ({ action: "open_app", app: "Brave Browser" }), seen), planner: fixedPlanner([normalizePlan({ already_done: true, result: "Brave ma otwartą kartę Nowa karta." })]), mode: "desktop", call, log: () => {} });
  assert.equal(r.status, "ok");
  assert.equal(seen.length, 0); // decydent w ogóle nie był pytany
  assert.match(r.text, /WYNIK: Brave ma otwartą kartę Nowa karta\./);
  assert.ok(events.some((e) => e.type === "computer.plan" && e.data.alreadyDone === true));
});

await test("planner: budżet z szacunku (3 kroki → 7), a nie sztywne 30; plan i etap w promptcie decydenta", async () => {
  const { call } = fakeCall();
  const seen: DeciderInput[] = [];
  const plan = normalizePlan({ estimated_steps: 3, stages: [{ title: "Notatki na wierzchu", done_when: "APLIKACJA = Notatki" }, { title: "Nowa notatka", done_when: "pusta notatka" }] });
  const r = await runComputerTask({ goal: "nowa notatka", context: "", maxSteps: 30, browser: fakeBrowser(), decider: scripted((i) => (i.step === 1 ? { action: "press", key: "cmd+n", stage: 1, stage_done: true, think: "nowa notatka", expect: "pusta notatka" } : { action: "done", result: "jest", stage: 2, stage_done: true }), seen), planner: fixedPlanner([plan]), call, log: () => {} });
  assert.equal(budgetFor(3, 30), 7);
  assert.equal(seen[0].maxSteps, 7);
  assert.match(seen[0].plan ?? "", /→ 1\. Notatki na wierzchu/);
  assert.match(seen[1].plan ?? "", /✓ 1\. Notatki.*\n→ 2\. Nowa notatka/);
  assert.equal(seen[1].expect, "pusta notatka");
  assert.match(seen[1].log.join("\n"), /\[etap 1\] press cmd\+n — po co: nowa notatka/);
  assert.equal(r.status, "ok");
  assert.match(r.text, /PLAN[^\n]*:\n✓ 1\. Notatki na wierzchu \(decydent\)\n✓ 2\. Nowa notatka \(decydent\)/);
  assert.match(r.text, /PRZEBIEG.*\n1\. \[etap 1\] press cmd\+n — nowa notatka → /);
});

await test("brak postępu (open_app / cmd+tab / click_at na zmianę, jak z Brave) → replan z raportem, potem partial — nie 14 kroków", async () => {
  const { call, events } = fakeCall();
  const seenPlans: PlanIn[] = [];
  const rot: Decision[] = [{ action: "open_app", app: "Brave Browser" }, { action: "press", key: "cmd+tab" }, { action: "click_at", x: 0.8, y: 0.1 }];
  const b = { ...fakeBrowser(), openApp: async () => {} };
  const plan = normalizePlan({ estimated_steps: 10, stages: [{ title: "Brave na wierzchu", done_when: "APLIKACJA = Brave" }] });
  const r = await runComputerTask({ goal: "nowa karta w Brave", context: "", maxSteps: 30, browser: b, decider: scripted((i) => ({ ...rot[i.step % 3], note: "Brave z kartą New tab widoczny po prawej stronie ekranu" })), planner: fixedPlanner([plan], seenPlans), mode: "desktop", call, log: () => {} });
  assert.equal(seenPlans.length, 3); // start + 2 replany
  assert.match(seenPlans[1].previous?.report ?? "", /PRZEBIEG/);
  assert.ok(events.filter((e) => e.type === "computer.plan" && e.data.replan).length === 2);
  assert.ok(trSteps(r.text) <= 19, r.text);
  assert.equal(r.status, "partial"); // notatka (jedna — kolejne podobne odrzucone) jest, więc partial
  assert.equal((r.data as { notes: string[] }).notes.length, 1);
});

await test("przeglądarka: done bez zaliczenia etapów → „?” niepotwierdzony (nie „pominięty, niepotrzebny”), bez kaskady na wcześniejsze; TRYB w raporcie", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const plan = normalizePlan({ estimated_steps: 2, stages: [{ title: "Etap nie do sprawdzenia", done_when: "coś, czego w przeglądarce nie widać" }, { title: "Strona otwarta", done_when: "URL to quak.com.pl" }, { title: "Stopka odczytana", done_when: "widać stopkę" }] });
  const r = await runComputerTask({ goal: "otwórz quak.com.pl", context: "", maxSteps: 20, browser: fakeBrowser(), decider: scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://quak.com.pl", stage: 2 } : { action: "done", result: "Strona otwarta.", stage: 2, stage_done: true }), seen), planner: fixedPlanner([plan]), mode: "browser", call, log: () => {} });
  assert.equal(r.status, "ok");
  assert.match(r.text, /^TRYB: przeglądarka wbudowana/);
  assert.match(r.text, /PLAN \(✓ zaliczony · \? niepotwierdzony[^\n]*:\n\? 1\. Etap nie do sprawdzenia\n✓ 2\. Strona otwarta \(decydent\)\n\? 3\. Stopka odczytana/);
  assert.ok(!/✗/.test(r.text), r.text);
  assert.equal(events.find((e) => e.type === "computer.started")?.data.mode, "browser");
  assert.deepEqual(events.filter((e) => e.type === "computer.stage").map((e) => `${e.data.id}:${e.data.status}`), ["2:done", "1:unconfirmed", "3:unconfirmed"]);
});

await test("desktop: zadanie nieudane → niezrobione etapy zostają „✗”; TRYB desktop", async () => {
  const { call } = fakeCall();
  const plan = normalizePlan({ estimated_steps: 2, stages: [{ title: "Notatki na wierzchu", done_when: "APLIKACJA = Notatki" }] });
  const r = await runComputerTask({ goal: "nowa notatka", context: "", maxSteps: 20, browser: { ...fakeBrowser(), openApp: async () => {} }, decider: scripted(() => ({ action: "fail", error: "Notatki nie wychodzą na wierzch" })), planner: fixedPlanner([plan]), mode: "desktop", call, log: () => {} });
  assert.equal(r.status, "failed");
  assert.match(r.text, /^TRYB: desktop/);
  assert.match(r.text, /✗ 1\. Notatki na wierzchu/);
});

await test("planner: osobne prompty — przeglądarka nie dostaje aplikacji ani fokusu, desktop tak", async () => {
  const { llmPlanner } = await import("./planner.js");
  const systems: string[] = [];
  const llm = { json: async (system: string) => { systems.push(system); return { value: { already_done: false, estimated_steps: 1, stages: [{ title: "x", done_when: "y" }] } }; } } as unknown as import("@qwe/core").LlmAdapter;
  const obs = await fakeBrowser().observe();
  const p = llmPlanner(llm, { vision: false });
  await p.plan({ goal: "g", context: "", observation: obs, mode: "browser", cap: 10 }, new AbortController().signal);
  await p.plan({ goal: "g", context: "", observation: obs, mode: "desktop", cap: 10 }, new AbortController().signal);
  assert.match(systems[0], /trybie PRZEGLĄDARKA/);
  assert.ok(!/SELF_FRONTMOST|APLIKACJA na wierzchu/.test(systems[0]), "prompt przeglądarki nie może uczyć o fokusie");
  assert.match(systems[1], /trybie DESKTOP/);
  assert.match(systems[1], /SELF_FRONTMOST/);
});
/** xkcd: /random przekierowuje na losowy komiks — każde wejście i każdy klik „Random” daje NOWĄ stronę. */
function randomComicBrowser() {
  let url = "about:blank";
  let n = 100;
  let seq = 0;
  const go = () => { url = `https://xkcd.com/${n++}/`; };
  const b: BrowserLike = {
    async observe(): Promise<Observation> {
      const blank = url === "about:blank";
      return { url, title: blank ? "" : `xkcd: Komiks ${url}`, text: blank ? "" : `Archive\n# Komiks ${url}\n< Prev\nRandom`, hints: [], elements: blank ? [] : [{ id: 18, role: "link", name: "Random", href: "https://c.xkcd.com/random/comic/", inViewport: true }], screenshot: Buffer.alloc(0), observationId: `obs_${++seq}`, at: Date.now() };
    },
    async navigate(u: string) { if (/random/.test(u)) go(); else url = u; },
    async click() { go(); },
    async clickAt() {}, async hover() {}, async type() {}, async press() {}, async scroll() {}, async wait() {}, async back() {},
  };
  return b;
}

await test("xkcd: navigate /random i klik „Random” na zmianę (strona zmienia się za każdym razem) → POWTARZASZ, nie 19 kroków", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const r = await run(randomComicBrowser(), scripted((i) => (i.step % 2 ? { action: "navigate", url: "https://c.xkcd.com/random/comic/", note: `komiks ${i.observation.url}` } : { action: "click", target: 18, note: `komiks ${i.observation.url}` }), seen), call, 25);
  const rep = events.filter((e) => e.type === "computer.loop" && /powtórzone \d+×/.test(String(e.data.description)));
  assert.ok(rep.length >= 1, "wykryte powtarzanie mimo zmian strony");
  assert.ok(seen.some((i) => i.log.some((l) => /POWTARZASZ: .*ta akcja DZIAŁA/.test(l))), "decydent dostaje informację, że akcja działa");
  assert.equal(r.status, "partial");
  assert.ok(trSteps(r.text) <= 10, `kończy się szybko, a nie na limicie (${trSteps(r.text)} kroków)`);
});

await test("xkcd: decydent słucha podpowiedzi POWTARZASZ → done na obecnym komiksie", async () => {
  const { call } = fakeCall();
  const r = await run(randomComicBrowser(), scripted((i) => (i.log.some((l) => l.includes("POWTARZASZ")) ? { action: "done", result: `Komiks: ${i.observation.title}` } : i.step % 2 ? { action: "navigate", url: "c.xkcd.com/random/comic" } : { action: "click", target: 18 })), call, 25);
  assert.equal(r.status, "ok");
  assert.match(r.text, /WYNIK: Komiks: xkcd: Komiks https:\/\/xkcd\.com\/102\//);
});

await test("błąd kliku: „intercepts pointer events” z logu Playwrighta → „klik zasłonięty — <div …>”, a nie sam Timeout", async () => {
  const { explainActionError } = await import("./browser.js");
  const pw = new Error(`locator.click: Timeout 6000ms exceeded.\nCall log:\n  - waiting for locator('[data-qwe-id="64"]').first()\n  -   locator resolved to <a href="/art/1">Polska</a>\n  - attempting click action\n  -   element is visible, enabled and stable\n  -   <div class="sd-cmp-MtHO2">…</div> from <div id="sd-cmp">…</div> subtree intercepts pointer events\n  - retrying click action`);
  assert.equal(explainActionError(pw).message.split("\n").length, 1);
  assert.match(explainActionError(pw).message, /^klik zasłonięty — <div class="sd-cmp-MtHO2"> przechwytuje kliknięcie/);
  assert.equal(explainActionError(new Error("locator.click: Timeout 6000ms exceeded.")).message, "locator.click: Timeout 6000ms exceeded.");
});

await test("obserwacja: zasłonięty element i OVERLAY trafiają do opisu dla decydenta", async () => {
  const { describeObservation } = await import("./browser.js");
  const d = describeObservation({ url: "https://joemonster.org/", title: "JM", text: "", hints: ["OVERLAY: div.sd-cmp zasłania 100% ekranu i 36 elementów, box=[0,0,1,1]"], elements: [{ id: 262, role: "button", name: "Zaakceptuj wszystkie", inViewport: true }, { id: 1, role: "link", name: "Główna", inViewport: true, occluded: "div.sd-cmp" }], screenshot: Buffer.alloc(0), observationId: "o", at: 0 });
  assert.match(d, /HINTY: OVERLAY: div\.sd-cmp/);
  assert.match(d, /\[262\] button "Zaakceptuj wszystkie"\n\[1\] link "Główna" \(zasłonięty przez div\.sd-cmp\)/);
});

// ───────── faza 1 z design/computer-flow-review.md: decydent dostaje prawdziwe informacje ─────────

await test("xkcd: navigate /random → efekt „PRZEKIEROWANO na …”, bieżąca strona „TU JESTEŚ”, event z outcome i url", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  await run(randomComicBrowser(), scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://c.xkcd.com/random/comic/" } : { action: "done", result: i.observation.title }), seen), call);
  assert.match(seen[1].log.join("\n"), /1\. navigate https:\/\/c\.xkcd\.com\/random\/comic\/ → ok — PRZEKIEROWANO na https:\/\/xkcd\.com\/100\/ „xkcd: Komiks[^\n]*To JEST wynik tej akcji/);
  assert.match(seen[1].memory ?? "", /https:\/\/xkcd\.com\/100\/ ← TU JESTEŚ TERAZ/);
  const acts = events.filter((e) => e.type === "computer.action");
  assert.deepEqual(acts.map((e) => e.data.status), ["started", "completed"], "jeden event po akcji, nie dwa");
  assert.match(String(acts[1].data.outcome), /PRZEKIEROWANO na https:\/\/xkcd\.com\/100\//);
  assert.equal(acts[1].data.url, "https://xkcd.com/100/");
});

await test("xkcd: etap z warunkiem (url_matches) zalicza executor po pierwszej akcji → decydent kończy w 1 kroku, bez drugiego losowania", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const plan = normalizePlan({ estimated_steps: 2, stages: [{ title: "Losowy komiks załadowany", done_when: "URL to xkcd.com/<numer>", check: { url_matches: "^xkcd[.]com/[0-9]+" } }] });
  assert.deepEqual(plan.stages[0].check, { urlMatches: "^xkcd[.]com/[0-9]+" });
  const r = await runComputerTask({ goal: "losowy komiks xkcd", context: "", maxSteps: 20, browser: randomComicBrowser(), decider: scripted((i) => (/✓ 1\./.test(i.plan ?? "") ? { action: "done", result: `Komiks: ${i.observation.url}` } : { action: "navigate", url: "https://c.xkcd.com/random/comic/" }), seen), planner: fixedPlanner([plan]), mode: "browser", call, log: () => {} });
  assert.equal(seen.length, 2, "jedna akcja + done");
  assert.match(seen[0].plan ?? "", /→ 1\. Losowy komiks załadowany — zrobione, gdy: [^\n]*\[executor sprawdza sam\]/);
  assert.match(seen[1].plan ?? "", /✓ 1\. Losowy komiks załadowany — ZROBIONY \(URL xkcd\.com\/100\/\)/);
  assert.match(seen[1].log.join("\n"), /etap 1 „Losowy komiks załadowany” ZALICZONY AUTOMATYCZNIE \(URL xkcd\.com\/100\/\)/);
  const st = events.filter((e) => e.type === "computer.stage");
  assert.deepEqual(st.map((e) => [e.data.id, e.data.status, e.data.auto, e.data.by]), [[1, "done", true, "URL xkcd.com/100/"]]);
  assert.equal(r.status, "ok");
  assert.match(r.text, /✓ 1\. Losowy komiks załadowany \(URL xkcd\.com\/100\/\)/);
  assert.equal(trSteps(r.text), 1);
});

/** Przeglądarka, która przed zadaniem stoi na jakiejś stronie (została po poprzednim zadaniu). */
function startedBrowser(start: string, hooks: { click?: (n: number, go: (u: string) => void) => void; clickAt?: () => { hit?: string } | void } = {}) {
  let url = start, seq = 0, clicks = 0;
  const b: BrowserLike = {
    async observe(): Promise<Observation> {
      return { url, title: `T ${url}`, text: `# ${url}`, fullText: `cały tekst ${url} Gelato THC 21%`, hints: [], elements: [{ id: 65, role: "link", name: "see all", inViewport: true }], screenshot: Buffer.alloc(0), observationId: `obs_${++seq}`, at: Date.now() };
    },
    async navigate(u: string) { url = u; },
    async click() { hooks.click?.(++clicks, (u) => { url = u; }); },
    async clickAt() { return hooks.clickAt?.(); },
    async hover() {}, async type() {}, async press() {}, async scroll() {}, async wait() {}, async back() {},
  };
  return b;
}

await test("strona startowa (po poprzednim zadaniu) nie trafia do ODWIEDZONE ani do visited; warunek etapu nie zalicza się na niej przed pierwszą akcją", async () => {
  const { call } = fakeCall();
  const seen: DeciderInput[] = [];
  const plan = normalizePlan({ estimated_steps: 2, stages: [{ title: "Komiks", done_when: "xkcd", check: { url_contains: "xkcd.com" } }, { title: "Leafly", done_when: "leafly", check: { url_contains: "https://www.leafly.com", text_contains: "gelato" } }] });
  const r = await runComputerTask({ goal: "leafly", context: "", maxSteps: 20, browser: startedBrowser("https://xkcd.com/309/"), decider: scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://www.leafly.com/" } : { action: "done", result: "leafly" }), seen), planner: fixedPlanner([plan]), mode: "browser", call, log: () => {} });
  assert.match(seen[0].plan ?? "", /→ 1\. Komiks/, "etap prawdziwy już na starcie NIE jest zaliczony bez akcji");
  assert.match(seen[0].memory ?? "", /STRONA STARTOWA \(otwarta przed zadaniem[^\n]*xkcd\.com\/309/);
  assert.match(r.text, /START \(strona otwarta przed zadaniem, nie jest częścią wyniku\): T https:\/\/xkcd\.com\/309\/ — https:\/\/xkcd\.com\/309\//);
  assert.match(r.text, /ODWIEDZONE \(kolejno\):\n1\. T https:\/\/www\.leafly\.com\/ — https:\/\/www\.leafly\.com\/\n/);
  assert.deepEqual((r.data as { visited: string[] }).visited, ["https://www.leafly.com/"]);
  // warunek z url_contains (z protokołem i www — normalizowany) + text_contains w pełnym tekście strony
  assert.match(r.text, /\? 1\. Komiks\n✓ 2\. Leafly \(URL leafly\.com\/, tekst „gelato”\)/);
});

await test("leafly: klik z błędem „brak elementu”, gdy strona zdążyła przejść dalej → „NIE WYKONANO … wcześniejsza akcja zadziałała z opóźnieniem”, nie porażka", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  // 1. klik: nic (SPA jeszcze nie przeszło) · 2. klik: strona już inna → brak elementu
  const b = startedBrowser("https://www.leafly.com/strains/lists", { click: (n, go) => { if (n === 2) { go("https://www.leafly.com/strains"); throw new Error("brak elementu [65] — zrób observe"); } } });
  const r = await run(b, scripted((i) => (i.step <= 2 ? { action: "click", target: 65 } : { action: "done", result: "ok" }), seen), call);
  assert.match(seen[1].log.join("\n"), /1\. click \[65\] „see all” \(link\) → bez zmian \(ten sam adres i ta sama treść\)/);
  assert.match(seen[2].log.join("\n"), /2\. click \[65\][^\n]*→ NIE WYKONANO \(brak elementu \[65\][^\n]*strona w międzyczasie przeszła na https:\/\/www\.leafly\.com\/strains /);
  assert.ok(!/NIE ZADZIAŁAŁO/.test(r.text), "spóźniona nawigacja nie ląduje w NIE ZADZIAŁAŁO");
  assert.deepEqual(events.filter((e) => e.type === "computer.action" && e.data.status !== "started").map((e) => e.data.status), ["completed", "completed"]);
});

await test("click_at: efekt mówi, w co trafił klik („NIC KLIKALNEGO”), a prawdziwy błąd akcji dalej jest porażką", async () => {
  const { call, events } = fakeCall();
  const seen: DeciderInput[] = [];
  const b = startedBrowser("https://joemonster.org/", { clickAt: () => ({ hit: "div.wrap — NIC KLIKALNEGO w tym punkcie" }), click: () => { throw new Error("klik zasłonięty — <div id=\"ad\"> przechwytuje kliknięcie"); } });
  const r = await run(b, scripted((i) => (i.step === 1 ? { action: "click_at", x: 0.99, y: 0.03 } : i.step === 2 ? { action: "click", target: 65 } : { action: "done", result: "x" }), seen), call);
  assert.match(seen[1].log.join("\n"), /1\. click_at \(0\.99, 0\.03\) → bez zmian \(ten sam adres i ta sama treść\) · trafiono w: div\.wrap — NIC KLIKALNEGO/);
  assert.match(String(events.filter((e) => e.type === "computer.action")[1].data.outcome), /trafiono w: div\.wrap/);
  assert.match(r.text, /NIE ZADZIAŁAŁO:\n- click \[65\] „see all” \(link\): klik zasłonięty/);
  assert.equal(events.filter((e) => e.type === "computer.action" && e.data.status === "failed").length, 1);
});

await test("warunki etapów: normalizacja odpowiedzi plannera i porównywanie (URL bez protokołu/www, zły regex odpada, wszystkie pola naraz)", async () => {
  const { checkStage, bareUrl } = await import("./planner.js");
  assert.equal(bareUrl("https://WWW.Leafly.com/Strains/Gelato?x=1"), "leafly.com/Strains/Gelato?x=1");
  const p = normalizePlan({ stages: [{ title: "A", check: { url_matches: "([", text_contains: "  " } }, { title: "B", check: { url_contains: "leafly.com/strains/gelato", text_contains: "THC" } }, { title: "C" }] });
  assert.equal(p.stages[0].check, undefined, "niekompilujący się regex i pusty tekst → brak warunku");
  assert.equal(p.stages[2].check, undefined);
  const o = { url: "https://www.leafly.com/strains/gelato", title: "Gelato", text: "menu", fullText: "menu … thc 21% …" };
  assert.equal(checkStage(p.stages[1].check, o), "URL leafly.com/strains/gelato, tekst „THC”");
  assert.equal(checkStage(p.stages[1].check, { ...o, fullText: "bez tego słowa" }), null, "jedno pole nie pasuje → warunek niespełniony");
  assert.equal(checkStage({ titleContains: "gelato" }, o), "tytuł „Gelato”");
  assert.equal(checkStage(undefined, o), null);
});

await test("desktop: warunków etapów executor nie zalicza sam (zakres fazy 1 to przeglądarka)", async () => {
  const { call, events } = fakeCall();
  const plan = normalizePlan({ estimated_steps: 2, stages: [{ title: "Okno", done_when: "x", check: { url_contains: "leafly" } }] });
  await runComputerTask({ goal: "x", context: "", maxSteps: 20, browser: { ...startedBrowser("app://finder"), openApp: async () => {} }, decider: scripted((i) => (i.step === 1 ? { action: "navigate", url: "https://www.leafly.com/" } : { action: "done", result: "x" })), planner: fixedPlanner([plan]), mode: "desktop", call, log: () => {} });
  assert.deepEqual(events.filter((e) => e.type === "computer.stage").map((e) => e.data.status), ["unconfirmed"]);
});

function trSteps(t: string) { return Number(/KROKI: (\d+)/.exec(t)?.[1] ?? 99); }

console.log(`computer: ${passed} testów OK`);
