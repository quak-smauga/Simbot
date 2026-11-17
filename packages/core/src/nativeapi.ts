// NATIVEAPI — jedyny sposób, w jaki model wywołuje świat.
//
//   "Spoko, sprawdzę. <nativeapi><web.query>q</web.query></nativeapi>"            → direct call
//   "Lecę. <nativeapi><plan><web.query id="s1">q</web.query>
//                           <computer.run id="c1" after="s1">…</computer.run></plan></nativeapi>" → plan
//
// Tekst przed <nativeapi> leci na bieżąco (TTS / UI), z wstrzymaniem ogona, który może być początkiem
// tagu ("<", "<nat"). Model ma stop_sequence "</nativeapi>", więc strumień urywa się zaraz po bloku.
// Plan nie jest toolem — to kontener wykonawczy: tag = nazwa toola, `id` i `after` dają zależności.

export const OPEN_TAG = "<nativeapi>";
export const CLOSE_TAG = "</nativeapi>";

export interface NativeCall {
  name: string; // "web.query", "computer.run", …
  args: Record<string, string>; // `_` = treść tagu, reszta = atrybuty
}

export interface PlanStep extends NativeCall {
  id: string;
  after: string[]; // id kroków, na które czeka
}

export type NativeBlock = { kind: "direct"; calls: NativeCall[] } | { kind: "plan"; steps: PlanStep[] };

export class ToolStreamParser {
  private buf = "";
  private inTool = false;
  private toolBuf = "";
  constructor(private onText: (delta: string) => void) {}

  push(delta: string) {
    if (this.inTool) {
      this.toolBuf += delta;
      return;
    }
    this.buf += delta;
    const at = this.buf.indexOf(OPEN_TAG);
    if (at !== -1) {
      const before = this.buf.slice(0, at);
      if (before) this.onText(before);
      this.toolBuf = this.buf.slice(at + OPEN_TAG.length);
      this.buf = "";
      this.inTool = true;
      return;
    }
    const lt = this.buf.lastIndexOf("<");
    if (lt !== -1 && OPEN_TAG.startsWith(this.buf.slice(lt))) {
      const safe = this.buf.slice(0, lt);
      if (safe) this.onText(safe);
      this.buf = this.buf.slice(lt);
    } else {
      this.onText(this.buf);
      this.buf = "";
    }
  }

  /** Koniec strumienia. Zwraca blok (jeśli był). */
  finish(): NativeBlock | null {
    if (!this.inTool) {
      if (this.buf) this.onText(this.buf);
      this.buf = "";
      return null;
    }
    return parseNativeBlock(this.toolBuf);
  }
  get sawTool() {
    return this.inTool;
  }
}

const TAG_RE = /<([a-zA-Z_][\w.-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/\1>)/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of s.matchAll(/([\w-]+)="([^"]*)"/g)) out[a[1]] = decode(a[2]);
  return out;
}

/** Elementy pierwszego poziomu: <name attrs>body</name> albo <name attrs/>. Bez domknięcia → do końca. */
function parseElements(body: string): { name: string; attrs: Record<string, string>; body: string }[] {
  const out: { name: string; attrs: Record<string, string>; body: string }[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body))) out.push({ name: m[1], attrs: parseAttrs(m[2]), body: decode((m[4] ?? "").trim()) });
  if (!out.length) {
    const open = /<([a-zA-Z_][\w.-]*)((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]+)$/.exec(body);
    if (open) out.push({ name: open[1], attrs: parseAttrs(open[2]), body: decode(open[3].trim()) });
  }
  return out;
}

/** Zawartość między <nativeapi> i </nativeapi>. */
export function parseNativeBlock(inner: string): NativeBlock | null {
  const body = inner.replace(CLOSE_TAG, "");
  const els = parseElements(body);
  if (!els.length) return null;
  const plan = els.find((e) => e.name === "plan");
  if (plan) {
    const steps: PlanStep[] = parseElements(plan.body).map((e, i) => {
      const { id, after, ...rest } = e.attrs;
      return {
        name: e.name,
        id: id || `s${i + 1}`,
        after: (after ?? "")
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        args: { _: e.body, ...rest },
      };
    });
    // kroki bez `after` czekają… na nic → mogą iść równolegle; `after="*"` = na wszystko wcześniejsze
    for (let i = 0; i < steps.length; i++) if (steps[i].after.includes("*")) steps[i].after = steps.slice(0, i).map((s) => s.id);
    return { kind: "plan", steps };
  }
  return { kind: "direct", calls: els.map((e) => ({ name: e.name, args: { _: e.body, ...e.attrs } })) };
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pełny tekst odpowiedzi (do historii): tekst + domknięty blok. */
export function withClosedTag(full: string): string {
  if (full.includes(OPEN_TAG) && !full.includes(CLOSE_TAG)) return full.trimEnd() + "\n" + CLOSE_TAG;
  return full;
}

/** Blok <nativeresult> dla modelu. */
export function nativeResult(name: string, text: string, attrs: Record<string, string | number | undefined> = {}): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`)
    .join("");
  return `<nativeresult name="${name}"${a}>\n${text}\n</nativeresult>`;
}
