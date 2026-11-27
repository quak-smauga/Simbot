// PLIKI ROZMOWY — każda rozmowa ma prawdziwy folder na dysku: <data>/sessions/<id>/files/. Trafia tam wszystko, co user
// upuści / wklei w UI (albo wrzuci sam w Finderze). Do modelu:
//   • tura, w której plik przyszedł: pliki w treści (obraz → obraz, PDF → dokument, tekst → tekst), dopóki mieszczą się
//     w budżecie tokenów; reszta jako spis z podpowiedzią, jak zajrzeć,
//   • kolejne tury: tylko odnośnik „[plik: … — zajrzyj przez files.look]” (kontekst nie puchnie, cache zostaje stabilny),
//   • narzędzia simów (lokalne, w chat serverze): files.list, files.read (tekst, zakres linii), files.look (obraz / PDF),
//   • @[ścieżka] w wiadomości usera: plik albo cały folder trafia do tej tury jak załącznik (resolveScope).
// Folder może mieć podfoldery (panel plików w UI). Nazwy w API i w meta wiadomości to ścieżki względne: „szkice/plan.md”.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { escapeXml, nativeResult, type Media, type ModelCaps, type NativeCall } from "@qwe/core";

export type FileKind = "image" | "pdf" | "text" | "other";
export interface FileInfo {
  /** ścieżka względna w folderze rozmowy („szkice/plan.md”) */
  name: string;
  size: number;
  mime: string;
  kind: FileKind;
  w?: number;
  h?: number;
  pages?: number;
  lines?: number;
}

/** Narzędzia plików — wykonywane w chat serverze (mają folder rozmowy), nie w agencie. */
export const FILE_TOOLS = new Set(["files.list", "files.read", "files.look"]);

export const FILES_USAGE = {
  usage: [
    "<files.list></files.list> — pliki w folderze tej rozmowy, z podfolderami (ścieżka, typ, rozmiar); <files.list>szkice</files.list> — tylko ten podfolder",
    '<files.read lines="1-200">szkice/plan.md</files.read> — treść pliku tekstowego (lines opcjonalnie: zakres linii)',
    "<files.look>zdjecia/kot.png</files.look> — obejrzyj obraz albo PDF (trafi do Ciebie w następnym kroku)",
  ].join("\n- "),
  notes:
    "Rozmowa ma swój folder z plikami od usera (upuszczone, wklejone, ułożone w podfoldery). Plik z bieżącej wiadomości zwykle widzisz od razu; starsze są tylko odnośnikami — jak potrzebujesz ich treści, zajrzyj. @[ścieżka] w wiadomości usera to wskazany plik albo folder: jego pliki dostajesz w tej turze. Nie zgaduj zawartości pliku, którego nie widziałeś.",
};

const TEXT_EXT = new Set("txt md markdown csv tsv json jsonl yaml yml xml html htm css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh zsh bash sql log ini toml conf cfg env gitignore dockerfile makefile svg tex srt vtt".split(" "));
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_UPLOAD = 25 * 1024 * 1024;
/** Tyle znaków tekstu oddaje files.read naraz (i tyle maks. pliku tekstowego idzie w turze). */
const READ_CHARS = 40_000;

export const filesDir = (dataDir: string, sessionId: string) => join(dataDir, "sessions", sessionId.replace(/[^\w-]/g, ""), "files");

const extOf = (name: string) => (extname(name).slice(1) || basename(name)).toLowerCase();
export function mimeOf(name: string): string {
  const e = extOf(name);
  if (IMAGE_MIME[e]) return IMAGE_MIME[e];
  if (e === "pdf") return "application/pdf";
  if (e === "svg") return "image/svg+xml";
  if (e === "json") return "application/json";
  if (e === "html" || e === "htm") return "text/html";
  if (TEXT_EXT.has(e)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
function kindOf(name: string, buf?: Buffer): FileKind {
  const e = extOf(name);
  if (IMAGE_MIME[e]) return "image";
  if (e === "pdf") return "pdf";
  if (TEXT_EXT.has(e)) return "text";
  // bez rozszerzenia z listy: tekst, jeśli w pierwszych 8 KB nie ma bajtu zerowego
  if (buf && buf.length && !buf.subarray(0, 8192).includes(0)) return "text";
  return "other";
}

/** Nazwa pliku bez ścieżek i znaków sterujących; pusta → "plik". Bez [ ] — te zarezerwowane na @[ścieżka]. */
export function safeName(name: string): string {
  const n = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*[\]]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return n || "plik";
}
/** Ścieżka względna: każdy segment przez safeName, bez „.”/„..”, bez pustych. "" = korzeń folderu rozmowy. */
export function cleanRel(rel: string): string {
  return (rel ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((x) => x.trim())
    .filter((x) => x && x !== "." && x !== "..")
    .map(safeName)
    .slice(0, 12)
    .join("/");
}
/** Ścieżka bezwzględna w folderze rozmowy (nigdy poza nim). */
function absIn(dir: string, rel: string): string {
  return join(resolve(dir), cleanRel(rel));
}
/** Plik w folderze (bez wychodzenia poza folder). */
function pathIn(dir: string, name: string): string | null {
  const rel = cleanRel(name);
  if (!rel) return null;
  const p = absIn(dir, rel);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}
function head(p: string, n: number): Buffer {
  const fd = openSync(p, "r");
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** Wymiary obrazu z nagłówka (PNG, JPEG, GIF, WebP) — bez bibliotek. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  try {
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const t = b.toString("ascii", 12, 16);
      if (t === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (t === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      if (t === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    /* uszkodzony nagłówek */
  }
  return null;
}

export function fileInfo(dir: string, name: string): FileInfo | null {
  const p = pathIn(dir, name);
  if (!p) return null;
  const size = statSync(p).size;
  const top = head(p, Math.min(size, 512 * 1024));
  const kind = kindOf(name, top);
  const info: FileInfo = { name: cleanRel(name), size, mime: mimeOf(name), kind };
  if (kind === "image") Object.assign(info, imageSize(top) ?? {});
  else if (kind === "pdf") info.pages = Math.max(1, (readFileSync(p).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length);
  else if (kind === "text") info.lines = size > 2_000_000 ? undefined : readFileSync(p, "utf8").split("\n").length;
  return info;
}

/** Wpis w panelu plików (lekki: bez czytania całych plików). */
export interface Entry {
  name: string;
  /** ścieżka względna */
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
  kind?: FileKind;
  w?: number;
  h?: number;
  /** folder: ile elementów w środku */
  items?: number;
}
const visible = (n: string) => !n.startsWith(".");
function entryOf(dir: string, rel: string): Entry | null {
  const p = absIn(dir, rel);
  if (!existsSync(p)) return null;
  const st = statSync(p);
  const name = basename(p);
  if (st.isDirectory()) return { name, path: rel, type: "dir", size: 0, mtime: st.mtime.toISOString(), items: readdirSync(p).filter(visible).length };
  if (!st.isFile()) return null;
  const kind = kindOf(name);
  const e: Entry = { name, path: rel, type: "file", size: st.size, mtime: st.mtime.toISOString(), kind };
  if (kind === "image") Object.assign(e, imageSize(head(p, 256 * 1024)) ?? {});
  return e;
}
/** Zawartość jednego folderu (foldery najpierw). null = nie ma takiego folderu. */
export function listDir(dir: string, rel = ""): Entry[] | null {
  const r = cleanRel(rel);
  const p = absIn(dir, r);
  if (!existsSync(p)) return r ? null : [];
  if (!statSync(p).isDirectory()) return null;
  return readdirSync(p)
    .filter(visible)
    .map((n) => entryOf(dir, r ? `${r}/${n}` : n))
    .filter((x): x is Entry => !!x)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "pl") : a.type === "dir" ? -1 : 1));
}
/** Wszystko pod `rel` (rekurencyjnie), z limitem. */
export function listAll(dir: string, rel = "", max = 2000): Entry[] {
  const out: Entry[] = [];
  const walk = (r: string) => {
    for (const e of listDir(dir, r) ?? []) {
      if (out.length >= max) return;
      out.push(e);
      if (e.type === "dir") walk(e.path);
    }
  };
  walk(cleanRel(rel));
  return out;
}
/** Pliki (pełne FileInfo) pod `rel`, rekurencyjnie. */
export function listFiles(dir: string, rel = "", max = 300): FileInfo[] {
  return listAll(dir, rel)
    .filter((e) => e.type === "file")
    .slice(0, max)
    .map((e) => fileInfo(dir, e.path))
    .filter((x): x is FileInfo => !!x);
}

/** Wolna nazwa w folderze: „x.png”, „x (2).png”… (dla folderów bez rozszerzenia). */
function freeName(parentAbs: string, name: string, isDir = false): string {
  const ext = isDir ? "" : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = name;
  for (let i = 2; existsSync(join(parentAbs, n)); i++) n = `${stem} (${i})${ext}`;
  return n;
}

/** Zapis uploadu do folderu `sub` (względny): unikalna nazwa. */
export function saveFile(dir: string, name: string, data: Buffer, sub = ""): FileInfo {
  if (data.length > MAX_UPLOAD) throw new Error(`plik za duży (maks. ${MAX_UPLOAD / 1024 / 1024} MB)`);
  const r = cleanRel(sub);
  const parent = absIn(dir, r);
  if (existsSync(parent) && !statSync(parent).isDirectory()) throw new Error("to nie jest folder");
  mkdirSync(parent, { recursive: true });
  const n = freeName(parent, safeName(name));
  writeFileSync(join(parent, n), data);
  return fileInfo(dir, r ? `${r}/${n}` : n)!;
}

/** Nowy folder w `parent` (unikalna nazwa). Zwraca ścieżkę względną. */
export function makeDir(dir: string, parent: string, name = "nowy folder"): string {
  const r = cleanRel(parent);
  const p = absIn(dir, r);
  mkdirSync(p, { recursive: true });
  const n = freeName(p, safeName(name), true);
  mkdirSync(join(p, n));
  return r ? `${r}/${n}` : n;
}

/** Zmiana nazwy albo przeniesienie (pliku lub folderu). `to` = pełna nowa ścieżka względna. */
export function movePath(dir: string, from: string, to: string): string {
  const f = cleanRel(from);
  const t = cleanRel(to);
  if (!f || !t) throw new Error("pusta ścieżka");
  if (f === t) return t;
  const src = absIn(dir, f);
  const dst = absIn(dir, t);
  if (!existsSync(src)) throw new Error(`nie ma: ${f}`);
  if (t.startsWith(f + "/")) throw new Error("nie można przenieść folderu do jego środka");
  if (existsSync(dst) && f.toLowerCase() !== t.toLowerCase()) throw new Error(`„${basename(t)}” już tam jest`);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
  return t;
}

/** Usunięcie plików / folderów (rekurencyjnie). Korzenia nie da się usunąć. */
export function removePaths(dir: string, paths: string[]): number {
  let n = 0;
  for (const x of paths) {
    const r = cleanRel(x);
    if (!r) continue;
    const p = absIn(dir, r);
    if (!existsSync(p)) continue;
    rmSync(p, { recursive: true, force: true });
    n++;
  }
  return n;
}

/** Ścieżka bezwzględna (do „Pokaż w Finderze”) — tylko gdy istnieje. */
export function absPath(dir: string, rel: string): string | null {
  const p = absIn(dir, rel);
  return existsSync(p) ? p : null;
}

/** @[ścieżka] w tekście usera → pliki do tej tury (folder = wszystkie pliki w środku, rekurencyjnie). */
export const SCOPE_RE = /@\[([^\]\n]{1,300})\]/g;
export interface Scope {
  refs: { path: string; type: "dir" | "file"; count: number }[];
  files: string[];
  missing: string[];
}
export function resolveScope(dir: string, text: string, maxFiles = 200): Scope {
  const out: Scope = { refs: [], files: [], missing: [] };
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(SCOPE_RE.source, "g"))) {
    const r = cleanRel(m[1]);
    if (!r || out.refs.some((x) => x.path === r)) continue;
    const p = absIn(dir, r);
    if (!existsSync(p)) {
      out.missing.push(r);
      continue;
    }
    const files = statSync(p).isDirectory() ? listAll(dir, r).filter((e) => e.type === "file").map((e) => e.path) : [r];
    out.refs.push({ path: r, type: statSync(p).isDirectory() ? "dir" : "file", count: files.length });
    for (const f of files) if (!seen.has(f) && out.files.length < maxFiles) (seen.add(f), out.files.push(f));
  }
  return out;
}

export function readFile(dir: string, name: string): Buffer | null {
  const p = pathIn(dir, name);
  return p ? readFileSync(p) : null;
}

export function removeDir(dataDir: string, sessionId: string) {
  rmSync(join(dataDir, "sessions", sessionId.replace(/[^\w-]/g, "")), { recursive: true, force: true });
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function describe(f: FileInfo): string {
  if (f.kind === "image") return `obraz${f.w ? ` ${f.w}×${f.h}` : ""}, ${kb(f.size)}`;
  if (f.kind === "pdf") return `PDF, ${f.pages} str., ${kb(f.size)}`;
  if (f.kind === "text") return `tekst${f.lines ? `, ${f.lines} linii` : ""}, ${kb(f.size)}`;
  return `plik, ${kb(f.size)}`;
}

/** Jak zajrzeć do pliku (dla modelu). */
function howToOpen(f: FileInfo, caps: ModelCaps): string {
  if (f.kind === "image") return caps.vision ? `zajrzyj: <files.look>${f.name}</files.look>` : "ten model nie widzi obrazów";
  if (f.kind === "pdf") return caps.provider === "anthropic" ? `zajrzyj: <files.look>${f.name}</files.look>` : "ten model nie czyta PDF";
  if (f.kind === "text") return `przeczytaj: <files.read>${f.name}</files.read>`;
  return "tego formatu nie umiesz otworzyć";
}
export const refLine = (f: FileInfo, caps: ModelCaps) => `[plik w folderze rozmowy: ${f.name} — ${describe(f)}; ${howToOpen(f, caps)}]`;

/** Szacowany koszt pliku w tokenach dla danego modelu (Infinity = model tego nie przyjmie). */
function cost(f: FileInfo, caps: ModelCaps): number {
  if (f.kind === "image") {
    if (!caps.vision) return Infinity;
    // Claude: ~w·h/750 (maks. ~1600 po przeskalowaniu); Gemma i inne lokalne: stała liczba tokenów na obraz
    if (caps.provider === "anthropic") return Math.min(1600, f.w && f.h ? Math.ceil((f.w * f.h) / 750) : 1600);
    return 300;
  }
  if (f.kind === "pdf") return caps.provider === "anthropic" ? (f.pages ?? 1) * 2000 : Infinity;
  if (f.kind === "text") return Math.ceil(Math.min(f.size, READ_CHARS) / 3.5);
  return Infinity;
}
/** Budżet na pliki w jednej turze: Claude ~20k tokenów, lokalne ~25% kontekstu (num_ctx). */
export function filesBudget(caps: ModelCaps, numCtx = 16384): number {
  if (caps.provider === "anthropic") return 20_000;
  return Math.floor(Math.min(caps.ctx ?? numCtx, numCtx) / 4);
}

/**
 * Pliki z wiadomości usera → kawałki tury. `inline` = to bieżąca tura (pliki w treści, w budżecie); inaczej same odnośniki.
 * Zwraca kawałki do wstawienia PRZED tekstem usera.
 */
export function fileParts(dir: string, names: string[], caps: ModelCaps, inline: boolean, budget: number): (string | Media)[] {
  const infos = names.map((n) => fileInfo(dir, n) ?? null);
  const missing = names.filter((_, i) => !infos[i]);
  const out: (string | Media)[] = [];
  const refs: string[] = [];
  let left = budget;
  for (const f of infos) {
    if (!f) continue;
    const c = cost(f, caps);
    if (!inline || c > left) {
      refs.push(refLine(f, caps));
      continue;
    }
    left -= c;
    const data = readFile(dir, f.name)!;
    if (f.kind === "image") out.push(`[obraz: ${f.name}]`, { kind: "image", data, mime: f.mime, name: f.name });
    else if (f.kind === "pdf") out.push(`[PDF: ${f.name}]`, { kind: "pdf", data, mime: f.mime, name: f.name });
    else out.push(`<plik name="${escapeXml(f.name)}"${f.lines ? ` lines="${f.lines}"` : ""}>\n${data.toString("utf8").slice(0, READ_CHARS)}${f.size > READ_CHARS ? "\n… (ucięte — resztę przeczytaj przez files.read z lines)" : ""}\n</plik>`);
  }
  if (refs.length) out.push((inline ? "Załączone pliki, które nie zmieściły się w tej wiadomości (sięgnij po nie narzędziami, jeśli są potrzebne):\n" : "Załączone pliki:\n") + refs.join("\n"));
  if (missing.length) out.push(`[usunięte z folderu: ${missing.join(", ")}]`);
  return out;
}

/** files.* — lokalne narzędzia simów. `files` w wyniku = pliki do pokazania modelowi w następnym kroku (files.look). */
export function runFileTool(dir: string, call: NativeCall, caps: ModelCaps): { text: string; files?: string[] } {
  const name = (call.args._ ?? call.args.name ?? "").trim();
  if (call.name === "files.list") {
    const sub = cleanRel(name);
    if (sub && !listDir(dir, sub)) return { text: nativeResult("files.list", `Nie ma folderu „${escapeXml(sub)}”. Sprawdź <files.list></files.list>.`, { ok: "false" }) };
    const all = listAll(dir, sub, 400);
    const lines = all.map((e) => {
      if (e.type === "dir") return `- ${e.path}/ (folder, ${e.items} el.)`;
      const f = fileInfo(dir, e.path);
      return f ? `- ${f.name} — ${describe(f)}` : `- ${e.path}`;
    });
    return { text: nativeResult("files.list", lines.length ? lines.join("\n") : sub ? `Folder ${sub} jest pusty.` : "Folder rozmowy jest pusty.", { ok: "true", count: String(all.filter((e) => e.type === "file").length) }) };
  }
  const f = name ? fileInfo(dir, name) : null;
  if (!f) return { text: nativeResult(call.name, `Nie ma pliku „${escapeXml(name)}” w folderze rozmowy. Sprawdź <files.list></files.list>.`, { ok: "false" }) };
  if (call.name === "files.look") {
    if (f.kind === "text") return runFileTool(dir, { ...call, name: "files.read" }, caps);
    if (f.kind === "image" && !caps.vision) return { text: nativeResult("files.look", `${f.name}: ten model nie widzi obrazów. Powiedz userowi, że do obrazów potrzebny jest model z vision.`, { ok: "false" }) };
    if (f.kind === "pdf" && caps.provider !== "anthropic") return { text: nativeResult("files.look", `${f.name}: ten model nie czyta PDF.`, { ok: "false" }) };
    if (f.kind === "other") return { text: nativeResult("files.look", `${f.name}: nie umiesz otworzyć tego formatu (${describe(f)}).`, { ok: "false" }) };
    return { text: nativeResult("files.look", `${f.name} (${describe(f)}) — poniżej.`, { ok: "true" }), files: [f.name] };
  }
  if (call.name === "files.read") {
    if (f.kind !== "text") return f.kind === "other" ? { text: nativeResult("files.read", `${f.name}: to nie jest plik tekstowy (${describe(f)}).`, { ok: "false" }) } : runFileTool(dir, { ...call, name: "files.look" }, caps);
    const all = readFile(dir, f.name)!.toString("utf8").split("\n");
    const m = /^(\d+)\s*-\s*(\d+)?$/.exec((call.args.lines ?? "").trim());
    const from = m ? Math.max(1, Number(m[1])) : 1;
    let to = m && m[2] ? Math.min(all.length, Number(m[2])) : all.length;
    let body = all.slice(from - 1, to).join("\n");
    if (body.length > READ_CHARS) {
      body = body.slice(0, READ_CHARS);
      to = from + body.split("\n").length - 1;
    }
    const more = to < all.length ? `\n… linie ${from}–${to} z ${all.length}. Dalej: <files.read lines="${to + 1}-${Math.min(all.length, to + 400)}">${f.name}</files.read>` : "";
    return { text: nativeResult("files.read", `${body}${more}`, { ok: "true", file: f.name, lines: `${from}-${to}` }) };
  }
  return { text: nativeResult(call.name, `Nieznane narzędzie: ${call.name}`, { ok: "false" }) };
}
