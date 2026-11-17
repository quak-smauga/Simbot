// BROWSER RUNTIME — Playwright z trwałym profilem (cookies, localStorage, sesje użytkownika).
// Akcje wewnętrzne: navigate / observe / click / type / press / scroll / wait / back. Screenshot to część observe.
// Headless w dockerze; na hoście widoczne okno — user może się zalogować / przejąć kontrolę.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { OBSERVE_BASIC_SRC, OBSERVE_SRC } from "./observe-script.js";

export interface Observation {
  url: string;
  title: string;
  /** Interaktywne elementy, indeksowane — click/type celują w `[N]`. */
  elements: PageElement[];
  /** Fragment widocznego tekstu (nagłówki + akapity), przycięty. */
  text: string;
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
  inViewport: boolean;
  /** Ramka w ułamkach viewportu [x, y, w, h] — tylko dla canvas/img/video (cele dla click_at). */
  box?: number[];
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

export class BrowserRuntime {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private obsSeq = 0;
  private lock: Promise<void> = Promise.resolve();

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
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(8000);
    this.opts.log("info", `[computer] przeglądarka gotowa (${this.opts.channel ?? "chromium"}, ${this.opts.headless ? "headless" : "okno"}), profil: ${profile}`);
    return this.page;
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
    const page = await this.ensure();
    const loc = page.locator(`[${ATTR}="${target}"]`).first();
    if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 6000 });
    await this.settle();
  }
  async type(target: number | undefined, text: string, submit = false) {
    const page = await this.ensure();
    if (target !== undefined) {
      const loc = page.locator(`[${ATTR}="${target}"]`).first();
      if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
      await loc.click({ timeout: 6000 }).catch(() => {});
      await loc.fill("").catch(() => {});
      await loc.type(text, { delay: 15 });
    } else await page.keyboard.type(text, { delay: 15 });
    if (submit) await page.keyboard.press("Enter");
    await this.settle();
  }
  /** Klik w punkt ze screenshota: x, y w ułamkach 0..1 viewportu (screenshot = viewport). Ostateczny fallback — canvas, obrazki. */
  async clickAt(x: number, y: number) {
    const page = await this.ensure();
    const { px, py } = this.toPx(page, x, y);
    await page.mouse.move(px, py, { steps: 6 });
    await page.waitForTimeout(60);
    await page.mouse.click(px, py);
    await this.settle();
  }
  async hover(target?: number, x?: number, y?: number) {
    const page = await this.ensure();
    if (target !== undefined) {
      const loc = page.locator(`[${ATTR}="${target}"]`).first();
      if (!(await loc.count())) throw new Error(`brak elementu [${target}] — zrób observe`);
      await loc.hover({ timeout: 6000 });
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
    const page = await this.ensure();
    await page.keyboard.press(key);
    await this.settle();
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
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  }

  /** OBSERVE: DOM (elementy + tekst) + screenshot + hinty. Zawsze po akcji. */
  async observe(opts: { maxElements?: number; textChars?: number } = {}): Promise<Observation> {
    const page = await this.ensure();
    const { maxElements = 70, textChars = 1800 } = opts;
    // Skrypt DOM jako STRING: tsx/esbuild w dev owija funkcje helperem __name, którego nie ma w przeglądarce.
    const run = <T,>(src: string, arg: unknown) => page.evaluate<T>(`(${src})(${JSON.stringify(arg)})`);
    const snap = await run<Omit<Observation, "screenshot" | "observationId" | "at">>(OBSERVE_SRC, { ATTR, maxElements, textChars }).catch(async (e: Error) => {
      this.opts.log("warn", `[computer] observe: ${e.message.split("\n")[0]}`);
      // awaryjnie: najprostsza lista linków/przycisków, żeby decydent miał na czym działać
      const basic = await run<{ url: string; title: string; elements: PageElement[]; text: string }>(OBSERVE_BASIC_SRC, ATTR).catch(() => ({ url: page.url(), title: "", elements: [] as PageElement[], text: "" }));
      return { ...basic, hints: [`OBSERVE_FALLBACK: pełna obserwacja padła (${e.message.split("\n")[0].slice(0, 100)}) — lista elementów jest uproszczona, ale prawdziwa; NIE czekaj, działaj na tym, co jest`] };
    });
    const screenshot = await page.screenshot({ type: "jpeg", quality: 55 }).catch(() => Buffer.alloc(0));
    return { ...snap, screenshot, observationId: `obs_${++this.obsSeq}`, at: Date.now() };
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
  const els = o.elements.slice(0, maxEl).map((e) => `[${e.id}] ${e.role} "${e.name}"${e.href ? ` → ${e.href}` : ""}${e.value ? ` (wpisane: "${e.value}")` : ""}${e.box ? ` box=[${e.box.join(",")}]` : ""}${e.inViewport ? "" : " (poza ekranem)"}`);
  return [`URL: ${o.url}`, `TYTUŁ: ${o.title || "(brak)"}`, o.hints.length ? `HINTY: ${o.hints.join(", ")}` : "", `ELEMENTY (${o.elements.length}):`, els.join("\n") || "(brak)", `TEKST:`, o.text || "(brak)"].filter(Boolean).join("\n");
}
