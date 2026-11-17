// DESKTOP DRIVER — cały komputer (macOS) zamiast samej przeglądarki. Ten sam kontrakt co BrowserRuntime (observe + akcje),
// więc executor (pętla, raport, pętle, potwierdzenia, stop) jest wspólny. Ręce i oczy: qwe-helper (Swift) za mostem w Electronie.
//   observe   zrzut wybranego ekranu + elementy z drzewa Accessibility aktywnego okna ([N] jak w DOM) + tekst
//   akcje     click [N] (AXPress / klik w środek) · click_at x,y (ułamki ekranu → punkty) · type · press "cmd+n" · scroll ·
//             open_app · navigate (URL w domyślnej przeglądarce) · back (cmd+[)
// Most: env QWE_DESKTOP_URL + QWE_DESKTOP_TOKEN albo <data>/desktop-bridge.json (zapisuje go simbot przy starcie).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Observation, PageElement } from "./browser.js";
import type { Decision } from "./decider.js";

/** Aplikacje, w których KAŻDA akcja zmieniająca stan wymaga potwierdzenia usera (Terminal, Ustawienia, hasła). */
export const GUARDED_APPS: Record<string, string> = {
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "dev.warp.Warp-Stable": "Warp",
  "com.apple.systempreferences": "Ustawienia systemowe",
  "com.apple.SystemPreferences": "Ustawienia systemowe",
  "com.apple.keychainaccess": "Pęk kluczy",
  "com.apple.Passwords": "Hasła",
  "com.1password.1password": "1Password",
  "com.agilebits.onepassword7": "1Password",
  "com.bitwarden.desktop": "Bitwarden",
};
const GUARDED_NAMES = /terminal|iterm|warp|ustawienia|system settings|system preferences|preferencje|keychain|pęk kluczy|hasła|passwords|1password|bitwarden/i;

interface RawObserve {
  frontmost: { app?: string; bundleId?: string; pid?: number; window?: string; displayId?: number; self?: boolean };
  display: { id: number; name: string; frame: { x: number; y: number; width: number; height: number }; scale: number };
  permissions: { screen: boolean; accessibility: boolean };
  elements?: (PageElement & { disabled?: boolean })[];
  text?: string;
  window?: string;
  screenshot?: { jpeg: string; width: number; height: number };
  screenshotError?: string;
}

export interface DesktopOptions {
  dataDir: string;
  env: Record<string, string | undefined>;
  log(level: "info" | "warn" | "error", message: string): void;
}

export class DesktopDriver {
  private seq = 0;
  private last: RawObserve | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(private o: DesktopOptions) {}

  /** Jeden pulpit, jeden task naraz. */
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

  private bridge(): { url: string; token: string } {
    const { QWE_DESKTOP_URL: url, QWE_DESKTOP_TOKEN: token } = this.o.env;
    if (url && token) return { url, token };
    const f = join(this.o.dataDir, "desktop-bridge.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8")) as { url: string; token: string };
      if (j.url && j.token) return j;
    }
    throw new Error("komputer (desktop) niedostępny — uruchom aplikację simbot (qwe desktop); sam serwer go nie ma");
  }
  async rpc<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const b = this.bridge();
    const r = await fetch(`${b.url}/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${b.token}` }, body: JSON.stringify({ cmd, args }), signal: AbortSignal.timeout(35000) }).catch((e: Error) => {
      throw new Error(`most do komputera nie odpowiada (${e.message}) — czy simbot działa?`);
    });
    const j = (await r.json()) as { ok: boolean; result?: T; error?: string };
    if (!j.ok) throw new Error(j.error || `${cmd}: błąd`);
    return j.result as T;
  }

  /** Aplikacja na wierzchu przy ostatniej obserwacji — do pilnowania Terminala / Ustawień. */
  get frontmost() {
    return this.last?.frontmost ?? null;
  }

  async observe(): Promise<Observation> {
    const raw = await this.rpc<RawObserve>("observe", { maxSide: 1400, quality: 0.6, maxElements: 90 });
    if (!raw.permissions.screen && !raw.permissions.accessibility) throw new Error("brak zgód macOS (Nagrywanie ekranu i Dostępność) — tray simbot → Ustawienia → Komputer: uprawnienia");
    this.last = raw;
    const f = raw.frontmost;
    const win = raw.window || f.window || "";
    const hints: string[] = [];
    if (!raw.permissions.accessibility) hints.push("AX_UNAVAILABLE: brak zgody Dostępność — nie ma listy elementów; klikaj click_at ze zrzutu, a zgłoś userowi, że zgoda by pomogła");
    if (!raw.permissions.screen) hints.push("NO_SCREENSHOT: brak zgody Nagrywanie ekranu — widzisz tylko elementy i tekst");
    if (raw.screenshotError) hints.push(`SCREENSHOT_ERROR: ${raw.screenshotError.slice(0, 120)}`);
    if (raw.permissions.accessibility && !(raw.elements ?? []).length) hints.push("NO_ELEMENTS: aktywne okno nie wystawia elementów (Electron/gra/canvas) — click_at ze zrzutu albo skróty klawiszowe");
    if (f.self) hints.push("SELF_FRONTMOST: na wierzchu jest simbot (okno, z którego user zlecił zadanie) — to NIE jest aplikacja docelowa; jeśli cel dotyczy innej aplikacji, najpierw open_app na nią (klikanie w okno simbot nic nie da)");
        if (f.bundleId && GUARDED_APPS[f.bundleId]) hints.push(`GUARDED_APP: ${GUARDED_APPS[f.bundleId]} — każda akcja idzie do potwierdzenia usera`);
    return {
      url: `app://${f.bundleId || f.app || "?"}${win ? `/${encodeURIComponent(win)}` : ""}`,
      title: [f.self ? `${f.app} (simbot — nie cel)` : f.app, win].filter(Boolean).join(" — "),
      elements: (raw.elements ?? []).map((e) => ({ ...e, name: e.disabled ? `${e.name} (nieaktywny)` : e.name })),
      text: [`EKRAN: ${raw.display.name} ${raw.display.frame.width}×${raw.display.frame.height}`, raw.text ?? ""].filter(Boolean).join("\n").slice(0, 2400),
      hints,
      screenshot: raw.screenshot ? Buffer.from(raw.screenshot.jpeg, "base64") : Buffer.alloc(0),
      observationId: `dobs_${++this.seq}`,
      at: Date.now(),
    };
  }

  /** Ułamki 0..1 wybranego ekranu (tak, jak model widzi zrzut) → punkty globalne (tak, jak klika macOS). Retina i drugi monitor tu. */
  private toPoint(x: number, y: number) {
    const d = this.last?.display.frame;
    if (!d) throw new Error("brak obserwacji ekranu — najpierw observe");
    const c = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
    return { x: d.x + c(x) * d.width, y: d.y + c(y) * d.height };
  }
  private settle(ms = 450) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async navigate(url: string) {
    if (/^https?:\/\//i.test(url) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url)) await this.rpc("openURL", { url: /^https?:/i.test(url) ? url : `https://${url}` });
    else await this.openApp(url);
    await this.settle(900);
  }
  /** Uruchom / przełącz i SPRAWDŹ, że aplikacja jest na wierzchu — inaczej błąd (cichy „ok” prowadził do pętli open_app). */
  async openApp(name: string) {
    const r = await this.rpc<{ activated?: boolean; reason?: string; app?: string; after?: { app?: string; self?: boolean } }>("openApp", /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(name) ? { bundleId: name } : { name });
    await this.settle(400);
    if (r && r.activated === false) {
      const front = r.after?.app ? `${r.after.app}${r.after.self ? " (simbot)" : ""}` : "?";
      throw new Error(`${r.app || name} nie wyszedł na wierzch (${r.reason || "macOS zablokował aktywację"}; na wierzchu: ${front}) — nie ponawiaj open_app; poproś usera (needs_user), żeby kliknął w okno ${r.app || name}`);
    }
  }
  async click(target: number) {
    await this.rpc("press", { element: target });
    await this.settle();
  }
  async clickAt(x: number, y: number) {
    await this.rpc("click", this.toPoint(x, y));
    await this.settle();
  }
  async hover(target?: number, x?: number, y?: number) {
    if (target !== undefined) {
      const e = this.last?.elements?.find((el) => el.id === target);
      if (!e?.box) throw new Error(`brak elementu [${target}]`);
      await this.rpc("move", this.toPoint(e.box[0] + e.box[2] / 2, e.box[1] + e.box[3] / 2));
    } else await this.rpc("move", this.toPoint(x ?? 0.5, y ?? 0.5));
    await this.settle(300);
  }
  async type(target: number | undefined, text: string, submit = false) {
    if (target !== undefined) await this.rpc("focus", { element: target });
    await this.rpc("type", { text });
    if (submit) await this.rpc("key", { combo: "enter" });
    await this.settle();
  }
  async press(key: string) {
    // nazwy z Playwrighta („Control+A”, „Meta+N”, „ArrowDown”) i nasze („cmd+n”) — helper rozumie małe litery
    const combo = key.replace(/Meta|Command/gi, "cmd").replace(/Control/gi, "ctrl").replace(/Alt|Option/gi, "alt").toLowerCase();
    await this.rpc("key", { combo });
    await this.settle();
  }
  async scroll(direction: "up" | "down", amount = 500) {
    const d = this.last?.display.frame;
    const at = d ? { x: d.x + d.width / 2, y: d.y + d.height / 2 } : {};
    await this.rpc("scroll", { ...at, dy: direction === "down" ? -amount : amount });
    await this.settle(300);
  }
  async wait(ms: number) {
    await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
  }
  async back() {
    await this.rpc("key", { combo: "cmd+[" });
    await this.settle();
  }

  /**
   * Terminal, Ustawienia systemowe, hasła: każda akcja zmieniająca stan → potwierdzenie usera (zwraca powód) albo null.
   * Patrzymy na aplikację na wierzchu i na cel otwierania (open_app „Terminal”).
   */
  guard(d: Decision): string | null {
    if (["done", "fail", "needs_user", "wait", "scroll", "hover"].includes(d.action)) return null;
    if (d.action === "open_app" && GUARDED_NAMES.test(d.app)) return `Otworzyć ${d.app}? (aplikacja chroniona — każda akcja za Twoim OK)`;
    const b = this.frontmost?.bundleId;
    if (b && GUARDED_APPS[b]) return `${GUARDED_APPS[b]}: ${d.action === "type" ? `wpisać „${d.text.slice(0, 60)}”${d.submit ? " + Enter" : ""}` : d.action === "press" ? `nacisnąć ${d.key}` : d.action === "click" ? `kliknąć element [${d.target}]` : d.action}`;
    return null;
  }
}
