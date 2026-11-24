// BROWSER RUNTIME — Playwright z trwałym profilem (cookies, localStorage, sesje użytkownika).
// Akcje wewnętrzne: navigate / observe / click / type / press / scroll / wait / back. Screenshot to część observe.
// Headless w dockerze; na hoście widoczne okno — user może się zalogować / przejąć kontrolę.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { FRAME_SRC, HIT_SRC, OBSERVE_BASIC_SRC, OBSERVE_SRC } from "./observe-script.js";

export interface Observation {
  url: string;
  title: string;
  /** Interaktywne elementy, indeksowane — click/type celują w `[N]`. */
  elements: PageElement[];
  /** Tekst tego, co TERAZ w widoku (zmienia się po przewinięciu) + nagłówki spod widoku. To dostaje model. */
  text: string;
  /** Cały tekst strony (innerText, przycięty) — tylko dla executora: sprawdzanie warunków etapów. Do modelu nie idzie. */
  fullText?: string;
  /** Heurystyki stanu — podpowiedzi dla decydenta. */
  hints: string[];
  screenshot: Buffer;
  /** Ustawiane przez executor po zapisaniu screenshotu (UI pobiera po id). */
  screenshotId?: string;
  observationId: string;
  at: number;
}

export interface PageElement {
  id: number;
  role: string; // button | link | textbox | checkbox | select | …
  name: string;
  href?: string;
  value?: string;
  /** Atrybut title (dymek po najechaniu) — dla obrazków osobno od alt; xkcd trzyma tam żart („alt text”). */
  tooltip?: string;
  /** Co przechwyci klik w środek elementu (nakładka nad stroną) — opis jak „div.sd-cmp” albo „iframe#ad”. */
  occluded?: string;
  inViewport: boolean;
  /** Ramka w ułamkach viewportu [x, y, w, h] — dla canvas/img/video (cele dla click_at) i dla elementów z ramek. */
  box?: number[];
  /** Element leży WEWNĄTRZ ramki (iframe) — np. „Zamknij X” reklamy. Opis ramki: „iframe#ad”. Klika się go normalnie, po [N]. */
  frame?: string;
}

export interface BrowserOptions {
  dataDir: string;
  headless: boolean;
  /** "chrome" | "msedge" = użyj zainstalowanej przeglądarki zamiast Chromium Playwrighta (bez `playwright install`). */
  channel?: string;
  viewport?: { width: number; height: number };
  log(level: "info" | "warn" | "error", message: string): void;
}

const ATTR = "data-qwe-id";
/** Tyle czekamy na zmianę adresu po kliknięciu w link (zwykła nawigacja kończy się dużo szybciej; to limit dla ociężałych SPA). */
const LINK_NAV_MS = 3000;
/** Najkrótszy oddech po akcji, zanim uznamy stronę za ustaloną. */
const SETTLE_MIN_MS = 250;
/** Pełny tekst strony dla executora (warunki etapów). */
const FULL_TEXT_CHARS = 120_000;
/** Ramki (iframe): ile największych widocznych ramek przeglądamy, ile elementów z każdej, od jakiego numeru idą ich [N]. */
const FRAME_LIMIT = 6;
const FRAME_ELEMENTS = 8;
const FRAME_ID_BASE = 1000;
const FRAME_ID_STEP = 20;
/** Nazwa elementu wyglądająca na zamknięcie (reklamy, okna). */
const CLOSE_NAME = /zamknij|close|dismiss|skip|pomi[nń]|^\s*[x×✕✖]\s*$|ikona: zamknij/i;
const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/**
 * Błąd kliku Playwrighta ma sedno w dalszych liniach logu („<div …> intercepts pointer events”), a pierwsza to tylko „Timeout”.
 * Wyciągamy powód, żeby decydent wiedział, że trzeba zamknąć nakładkę, a nie klikać to samo jeszcze raz.
 */
/** „<div tabindex="0" role="button" aria-label="Play" class="mejs__overlay …” → „<div.mejs__overlay „Play”>” (cały znacznik bywa ucięty i nieczytelny). */
function describeTag(raw: string): string {
  const tag = /^<([a-z0-9-]+)/i.exec(raw)?.[1]?.toLowerCase();
  if (!tag) return raw.slice(0, 80);
  const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`, "i").exec(raw)?.[1]?.trim();
  const id = attr("id"), cls = attr("class")?.split(/\s+/)[0], label = attr("aria-label") || attr("title");
  return `<${tag}${id ? `#${id}` : cls ? `.${cls}` : ""}${label ? ` „${label.slice(0, 40)}”` : ""}>`;
}
export function explainActionError(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  const lines = msg.split("\n").map((l) => l.trim());
  const icpt = lines.reverse().find((l) => /intercepts pointer events/.test(l));
  if (icpt) {
    const raw = icpt.replace(/^[-\s]+/, "").replace(/\s*(from .*)?(subtree )?intercepts pointer events.*$/, "");
    const who = describeTag(raw);
    // przechwytuje element, który SAM jest na liście (np. przycisk Play leżący na filmie) → to nie reklama, tylko właściwy cel
    const listed = new RegExp(`${ATTR}="(\\d+)"`).exec(raw)?.[1];
    if (listed) return new Error(`w tym miejscu na wierzchu leży inny element z listy: [${listed}] ${who} — kliknij [${listed}] zamiast tego`);
    return new Error(`klik zasłonięty — ${who} przechwytuje kliknięcie (nakładka: reklama/baner/modal). Zamknij ją (przycisk z listy albo click_at w X na zrzucie), nie klikaj tego samego.`);
  }
  if (lines.some((l) => /element is not visible/.test(l))) return new Error("element niewidoczny — przewiń do niego albo wybierz inny");
  if (lines.some((l) => /outside of the viewport/.test(l))) return new Error("element poza ekranem — przewiń (scroll) albo wybierz inny");
  return e instanceof Error ? e : new Error(msg);
}

export class BrowserRuntime {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private obsSeq = 0;
  private lock: Promise<void> = Promise.resolve();
  /** [N] elementu z ramki → ramka, w której trzeba go szukać (z ostatniej obserwacji). */
  private frameOf = new Map<number, Frame>();
  /** Widoczne ramki z ostatniej obserwacji (do „w co trafił click_at” wewnątrz ramki). */
  private frameBoxes: { frame: Frame; name: string; x: number; y: number; w: number; h: number }[] = [];
  /** > 0, gdy trwa akcja executora — tylko wtedy nowa karta to „popup po kliknięciu” (kart otwartych przez usera nie ruszamy). */
  private acting = 0;
  private popups: string[] = [];
  private popupWork: Promise<void>[] = [];

  constructor(private opts: BrowserOptions) {}

  /** Jedna przeglądarka, jeden task naraz — computer.run z różnych sesji ustawia się w kolejce. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    // macOS: zamknięcie okna nie kończy Chromium — kontekst (i blokada profilu) żyje dalej, więc nowa karta zamiast nowego startu
    if (this.ctx) {
      try {
        this.page = this.ctx.pages().find((p) => !p.isClosed()) ?? (await this.ctx.newPage());
        this.page.setDefaultTimeout(8000);
        return this.page;
      } catch {
        await this.ctx.close().catch(() => {});
        this.ctx = null;
      }
    }
    const { chromium } = await import("playwright");
    if (!this.opts.channel) {
      const { existsSync } = await import("node:fs");
      if (!existsSync(chromium.executablePath()))
        throw new Error(`brak Chromium dla Playwrighta (${chromium.executablePath()}). Zainstaluj: pnpm --filter @qwe/plugin-computer exec playwright install chromium — albo ustaw QWE_COMPUTER_CHANNEL=chrome, żeby użyć zainstalowanego Chrome'a.`);
    }
    const profile = join(this.opts.dataDir, "browser-profile");
    mkdirSync(profile, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(profile, {
      headless: this.opts.headless,
      channel: this.opts.channel || undefined,
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      locale: "pl-PL",
      args: this.opts.headless ? [] : ["--disable-blink-features=AutomationControlled"],
    });
    this.ctx.on("close", () => {
      this.ctx = null;
      this.page = null;
    });
    this.ctx.on("page", (p) => this.onNewPage(p));
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(8000);
    this.opts.log("info", `[computer] przeglądarka gotowa (${this.opts.channel ?? "chromium"}, ${this.opts.headless ? "headless" : "okno"}), profil: ${profile}`);
    return this.page;
  }

  /**
   * Klik otworzył nową kartę/okno (reklama, target=_blank): executor pracuje na jednej stronie, więc kartę zamykamy i zgłaszamy
   * w efekcie akcji — decydent wie, co się stało, i może wejść pod ten adres przez navigate, jeśli to był cel.
   * Karty otwarte poza akcją executora (user loguje się w okienku OAuth, sam otwiera kartę) zostają nietknięte.
   */
  private onNewPage(p: Page) {
    if (!this.acting || p === this.page) return;
    this.popupWork.push(
      (async () => {
        await p.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
        const url = p.url();
        const title = await p.title().catch(() => "");
        await p.close().catch(() => {});
        this.popups.push(`${url}${title ? ` „${title.slice(0, 60)}”` : ""}`);
      })(),
    );
  }
  /** Nowe karty otwarte przez ostatnią akcję (już zamknięte). Executor woła po każdej akcji. */
  async takePopups(): Promise<string[]> {
    await Promise.all(this.popupWork.splice(0));
    return this.popups.splice(0);
  }
  private async act<T>(fn: () => Promise<T>): Promise<T> {
    this.acting++;
    try {
      return await fn();
    } finally {
      this.acting--;
    }
  }
  /** Gdzie szukać elementu [N]: w ramce, z której przyszedł, albo na stronie. */
  private scope(page: Page, target: number): Page | Frame {
    const f = this.frameOf.get(target);
    return f && !f.isDetached() ? f : page;
  }

  async navigate(url: string) {
    const page = await this.ensure();
    const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 }).catch((e) => this.opts.log("warn", `[computer] goto: ${(e as Error).message}`));
    await this.settle();
  }
  async back() {
    const page = await this.ensure();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.settle();
  }
  async click(target: number) {
    return this.act(async () => {
      const page = await this.ensure();
      const loc = this.scope(page, target).locator(`[${ATTR}="${target}"]`).first();
      if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      // link, który ma zmienić adres: po kliknięciu czekamy na tę zmianę (SPA robi to z opóźnieniem — bez tego obserwacja
      // pokazuje jeszcze starą stronę, a następny klik trafia w elementy, których już nie ma)
      const before = page.url();
      const inFrame = this.frameOf.has(target);
      const href = inFrame ? "" : await loc.evaluate((el) => { const a = (el as Element).closest("a[href]") as HTMLAnchorElement | null; return a && a.target !== "_blank" ? a.href : ""; }).catch(() => "");
      await loc.click({ timeout: 6000 }).catch((e) => { throw explainActionError(e); });
      if (href && /^https?:/i.test(href) && href !== before) await page.waitForURL((u) => u.href !== before, { timeout: LINK_NAV_MS, waitUntil: "commit" }).catch(() => {});
      await this.settle();
    });
  }
  async type(target: number | undefined, text: string, submit = false) {
    return this.act(async () => {
      const page = await this.ensure();
      if (target !== undefined) {
        const loc = this.scope(page, target).locator(`[${ATTR}="${target}"]`).first();
        if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
        await loc.click({ timeout: 6000 }).catch(() => {});
        await loc.fill("").catch(() => {});
        await loc.type(text, { delay: 15 });
      } else await page.keyboard.type(text, { delay: 15 });
      if (submit) await page.keyboard.press("Enter");
      await this.settle();
    });
  }
  /**
   * Klik w punkt ze screenshota: x, y w ułamkach 0..1 viewportu (screenshot = viewport). Ostateczny fallback — canvas, obrazki.
   * Zwraca `hit`: co leżało w tym punkcie tuż przed kliknięciem („a.close „Zamknij x””, „div — NIC KLIKALNEGO”); gdy punkt
   * wypada w ramce — co było w tym punkcie WEWNĄTRZ ramki („ramka iframe#ad → div.close „Zamknij X” = [1001] z listy”).
   */
  async clickAt(x: number, y: number): Promise<{ hit?: string }> {
    return this.act(async () => {
      const page = await this.ensure();
      const { px, py } = this.toPx(page, x, y);
      let hit = await page.evaluate<string>(`(${HIT_SRC})(${JSON.stringify({ x: px, y: py, ATTR })})`).catch(() => undefined);
      if (hit && /^iframe/.test(hit)) {
        // najmniejsza (najgłębsza) widoczna ramka, w której leży punkt
        const f = this.frameBoxes.filter((b) => !b.frame.isDetached() && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
        const inner = f ? await withTimeout(f.frame.evaluate<string>(`(${HIT_SRC})(${JSON.stringify({ x: px - f.x, y: py - f.y, ATTR })})`), 700, "") : "";
        if (f && inner && !/^iframe/.test(inner)) hit = `ramka ${f.name} → ${inner}`;
      }
      await page.mouse.move(px, py, { steps: 6 });
      await page.waitForTimeout(60);
      await page.mouse.click(px, py);
      await this.settle();
      return { hit };
    });
  }
  async hover(target?: number, x?: number, y?: number) {
    const page = await this.ensure();
    if (target !== undefined) {
      const loc = this.scope(page, target).locator(`[${ATTR}="${target}"]`).first();
      if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
      await loc.hover({ timeout: 6000 }).catch((e) => { throw explainActionError(e); });
    } else {
      const { px, py } = this.toPx(page, x ?? 0.5, y ?? 0.5);
      await page.mouse.move(px, py, { steps: 8 });
    }
    await page.waitForTimeout(300);
  }
  private toPx(page: Page, x: number, y: number) {
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
    return { px: Math.round(clamp(x) * vp.width), py: Math.round(clamp(y) * vp.height) };
  }
  async press(key: string) {
    return this.act(async () => {
      const page = await this.ensure();
      await page.keyboard.press(key);
      await this.settle();
    });
  }
  async scroll(direction: "up" | "down", amount = 600) {
    const page = await this.ensure();
    await page.mouse.wheel(0, direction === "down" ? amount : -amount);
    await page.waitForTimeout(250);
  }
  async wait(ms: number) {
    const page = await this.ensure();
    await page.waitForTimeout(Math.min(ms, 10000));
  }
  private async settle() {
    const page = await this.ensure();
    // skutek kliknięcia bywa o ułamek sekundy spóźniony (zamknięcie reklamy idzie wiadomością z ramki, animacja zwijania) —
    // bez tego obserwacja łapała stan sprzed skutku i efekt akcji brzmiał „bez zmian” po udanym kliknięciu
    await page.waitForTimeout(SETTLE_MIN_MS);
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  }

  /** OBSERVE: DOM (elementy + tekst) + screenshot + hinty. Zawsze po akcji. */
  async observe(opts: { maxElements?: number; textChars?: number } = {}): Promise<Observation> {
    const page = await this.ensure();
    const { maxElements = 70, textChars = 2400 } = opts;
    // Skrypt DOM jako STRING: tsx/esbuild w dev owija funkcje helperem __name, którego nie ma w przeglądarce.
    const run = <T,>(src: string, arg: unknown) => page.evaluate<T>(`(${src})(${JSON.stringify(arg)})`);
    const snap = await run<Omit<Observation, "screenshot" | "observationId" | "at">>(OBSERVE_SRC, { ATTR, maxElements, textChars, fullChars: FULL_TEXT_CHARS }).catch(async (e: Error) => {
      this.opts.log("warn", `[computer] observe: ${e.message.split("\n")[0]}`);
      // awaryjnie: najprostsza lista linków/przycisków, żeby decydent miał na czym działać
      const basic = await run<{ url: string; title: string; elements: PageElement[]; text: string }>(OBSERVE_BASIC_SRC, ATTR).catch(() => ({ url: page.url(), title: "", elements: [] as PageElement[], text: "" }));
      return { ...basic, hints: [`OBSERVE_FALLBACK: pełna obserwacja padła (${e.message.split("\n")[0].slice(0, 100)}) — lista elementów jest uproszczona, ale prawdziwa; NIE czekaj, działaj na tym, co jest`] };
    });
    const framed = await this.observeFrames(page).catch(() => [] as PageElement[]);
    // elementy z ramek: te wyglądające na „zamknij” idą na początek listy (po to są), reszta na koniec — w ramach limitu
    const closers = framed.filter((e) => CLOSE_NAME.test(e.name));
    const rest = framed.filter((e) => !CLOSE_NAME.test(e.name));
    const elements = [...closers, ...snap.elements.slice(0, Math.max(0, maxElements - framed.length)), ...rest];
    const screenshot = await page.screenshot({ type: "jpeg", quality: 55 }).catch(() => Buffer.alloc(0));
    return { ...snap, elements, screenshot, observationId: `obs_${++this.obsSeq}`, at: Date.now() };
  }

  /**
   * Elementy z widocznych ramek (iframe) jako zwykłe [N] — reklamy trzymają „Zamknij X” w ramce, której główny dokument nie widzi.
   * Bierzemy kilka największych ramek w widoku, z każdej po kilka elementów; numery od 1001, żeby nie mieszały się ze stroną.
   */
  private async observeFrames(page: Page): Promise<PageElement[]> {
    this.frameOf.clear();
    this.frameBoxes = [];
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const frames = page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached()).slice(0, 40);
    if (!frames.length) return [];
    const boxes = await Promise.all(
      frames.map((frame) =>
        withTimeout(
          (async () => {
            const fe = await frame.frameElement();
            const box = await fe.boundingBox();
            if (!box || box.width < 60 || box.height < 30) return null;
            if (box.x >= vp.width || box.y >= vp.height || box.x + box.width <= 0 || box.y + box.height <= 0) return null;
            if (!(await fe.isVisible())) return null;
            const name = await fe.evaluate((node) => { const el = node as Element; const c = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : ""; return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : c ? `.${c}` : ""); });
            return { frame, name: name.slice(0, 40), x: box.x, y: box.y, w: box.width, h: box.height };
          })(),
          800,
          null,
        ),
      ),
    );
    this.frameBoxes = boxes.filter((b): b is NonNullable<typeof b> => !!b);
    const top = [...this.frameBoxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, FRAME_LIMIT);
    const out: PageElement[] = [];
    await Promise.all(
      top.map(async (f, i) => {
        const startId = FRAME_ID_BASE + i * FRAME_ID_STEP;
        const items = await withTimeout(f.frame.evaluate<{ id: number; role: string; name: string; href?: string; x: number; y: number; w: number; h: number }[]>(`(${FRAME_SRC})(${JSON.stringify({ ATTR, startId, max: FRAME_ELEMENTS })})`), 800, []);
        for (const it of items) {
          const cx = f.x + it.x + it.w / 2, cy = f.y + it.y + it.h / 2;
          if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) continue;
          this.frameOf.set(it.id, f.frame);
          const r2 = (v: number) => Math.round(v * 100) / 100;
          out.push({ id: it.id, role: it.role, name: it.name, href: it.href, inViewport: true, frame: f.name, box: [r2((f.x + it.x) / vp.width), r2((f.y + it.y) / vp.height), r2(it.w / vp.width), r2(it.h / vp.height)] });
        }
      }),
    );
    return out.sort((a, b) => a.id - b.id);
  }

  async close() {
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.page = null;
  }
  get browser(): Browser | null {
    return this.ctx?.browser() ?? null;
  }
}

/** Tekstowa postać obserwacji dla modelu (bez screenshotu). */
export function describeObservation(o: Observation, maxEl = 70): string {
  const els = o.elements.slice(0, maxEl).map((e) => `[${e.id}] ${e.role} "${e.name}"${e.href ? ` → ${e.href}` : ""}${e.value ? ` (wpisane: "${e.value}")` : ""}${e.tooltip ? ` dymek(title): "${e.tooltip}"` : ""}${e.box ? ` box=[${e.box.join(",")}]` : ""}${e.frame ? ` (w ramce ${e.frame} — klikaj normalnie po numerze)` : ""}${e.occluded ? ` (zasłonięty przez ${e.occluded})` : ""}${e.inViewport ? "" : " (poza ekranem)"}`);
  return [`URL: ${o.url}`, `TYTUŁ: ${o.title || "(brak)"}`, o.hints.length ? `HINTY: ${o.hints.join(", ")}` : "", `ELEMENTY (${o.elements.length}):`, els.join("\n") || "(brak)", `TEKST (to, co teraz w widoku — po przewinięciu będzie inny):`, o.text || "(brak)"].filter(Boolean).join("\n");
}
