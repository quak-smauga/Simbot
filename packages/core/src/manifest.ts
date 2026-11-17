// MANIFEST — AgentManifest.yaml opisuje, z czego zbudowany jest agent. Plan opisuje, co chce zrobić.
// Capability opisuje, jak wykonać robotę. Trzy różne odpowiedzialności. YAML = deklaratywna konfiguracja, nie drugi język.
//
// agents/<name>/
//   AgentManifest.yaml
//   plugins/<cap>/capability.yaml + index.(ts|js)     ← lokalne capability (dev)
//   skills/<skill>.md                                  ← instrukcje (frontmatter + markdown) do promptu
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { CapabilityDescriptor } from "./capability.js";

export interface AgentManifest {
  apiVersion: "qwe/v1";
  kind: "Agent";
  name: string;
  version: string;
  description?: string;
  runtime?: { base?: string };
  capabilities: {
    /** Wbudowane paczki z monorepo: "web", "computer" → @qwe/plugin-<name>. */
    builtin?: string[];
    /** Folder z lokalnymi pluginami (każdy podfolder = capability). */
    plugins?: string;
    /** Paczki npm z capability (plugin jako paczka: "@acme/qwe-plugin-x@^1"). */
    packages?: string[];
    skills?: string;
    /** Serwery MCP (nazwy z <data>/mcp.json), do których ten sim ma dostęp. */
    mcp?: string[];
  };
  dependencies?: { npm?: string[]; system?: string[] };
  model?: { provider?: "anthropic"; chat?: string; executor?: string };
  server?: { port?: number };
  /** Persona chatu: plik .md (względem folderu agenta) dopinany do kontraktu systemowego. */
  persona?: string;
  /** Wygląd / tożsamość sima w UI: kolor, awatar (kształt, oczy, usta, akcesoria…), głos (ElevenLabs voiceId), tempo. */
  look?: { color?: string; emoji?: string; voice?: string; tempo?: "calm" | "normal" | "lively"; avatar?: AvatarConfig };
  /** Pamięć: czy bot zbiera fakty po turze (memory.md). Domyślnie tak. */
  memory?: { enabled?: boolean; max?: number };
}

/** Konfiguracja awatara (komponent avatar.js w UI). Każdy klucz opcjonalny — brak = domyślny. */
export interface AvatarConfig {
  shape?: string;
  eyes?: string;
  mouth?: string;
  acc?: string[];
  pattern?: string;
  idle?: string;
}

export interface Skill {
  name: string;
  description: string;
  uses: string[];
  body: string;
  path: string;
}

export interface CapabilityRef {
  kind: "builtin" | "plugin" | "package";
  /** builtin: "web"; plugin: ścieżka absolutna; package: specifier npm */
  ref: string;
  descriptor: CapabilityDescriptor;
  /** Ścieżka do descriptor yaml (plugin) — do build. */
  dir?: string;
}

export interface AgentSpec {
  dir: string;
  manifest: AgentManifest;
  capabilities: CapabilityRef[];
  skills: Skill[];
  persona: string;
  /** memory.md — jedna linia = jeden fakt ("- 2026-11-02 · …"). */
  memory: string[];
}

export function readManifest(agentDir: string): AgentManifest {
  const p = join(agentDir, "AgentManifest.yaml");
  if (!existsSync(p)) throw new Error(`Brak ${p}`);
  const m = parseYaml(readFileSync(p, "utf8")) as AgentManifest;
  if (!m?.name) throw new Error(`${p}: brak name`);
  m.capabilities ??= {};
  return m;
}

export function readCapabilityYaml(dir: string): CapabilityDescriptor {
  const p = join(dir, "capability.yaml");
  if (!existsSync(p)) throw new Error(`Brak ${p}`);
  const d = parseYaml(readFileSync(p, "utf8")) as CapabilityDescriptor;
  if (!d?.name || !Array.isArray(d.tools)) throw new Error(`${p}: wymagane name i tools[]`);
  d.version ??= "0.0.0";
  d.description ??= "";
  return d;
}

/** Katalog wbudowanych pluginów (plugins/* w monorepo) — rozwiązywany względem tego pliku. */
export function builtinPluginDir(name: string): string {
  // packages/core/{src|dist}/manifest.js → ../../../plugins/<name>
  const here = resolve(import.meta.dirname, "..", "..", "..", "plugins", name);
  if (!existsSync(here)) throw new Error(`Nieznana wbudowana capability "${name}" (brak ${here})`);
  return here;
}

export function readSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let file = p;
    if (statSync(p).isDirectory()) {
      file = join(p, "SKILL.md");
      if (!existsSync(file)) continue;
    } else if (!f.endsWith(".md")) continue;
    const raw = readFileSync(file, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const meta = (fm ? parseYaml(fm[1]) : {}) as Partial<Skill>;
    out.push({
      name: meta.name ?? basename(f, ".md"),
      description: meta.description ?? "",
      uses: meta.uses ?? [],
      body: (fm ? fm[2] : raw).trim(),
      path: file,
    });
  }
  return out;
}

/** Cała specyfikacja agenta — bez instancjonowania capability (to robi agent server przez loader). */
export function loadAgentSpec(agentDir: string): AgentSpec {
  const dir = resolve(agentDir);
  const manifest = readManifest(dir);
  const caps: CapabilityRef[] = [];
  for (const name of manifest.capabilities.builtin ?? []) {
    const d = builtinPluginDir(name);
    caps.push({ kind: "builtin", ref: name, dir: d, descriptor: readCapabilityYaml(d) });
  }
  if (manifest.capabilities.plugins) {
    const pdir = resolve(dir, manifest.capabilities.plugins);
    if (existsSync(pdir))
      for (const f of readdirSync(pdir)) {
        const d = join(pdir, f);
        if (statSync(d).isDirectory() && existsSync(join(d, "capability.yaml"))) caps.push({ kind: "plugin", ref: d, dir: d, descriptor: readCapabilityYaml(d) });
      }
  }
  for (const spec of manifest.capabilities.packages ?? []) {
    // paczka npm: descriptor czytamy z node_modules/<pkg>/capability.yaml (po instalacji)
    const pkg = spec.replace(/@[^@/]+$/, "");
    const d = resolve(dir, "node_modules", pkg);
    if (existsSync(join(d, "capability.yaml"))) caps.push({ kind: "package", ref: pkg, dir: d, descriptor: readCapabilityYaml(d) });
    else console.warn(`[manifest] paczka ${spec} nie zainstalowana w ${d} — pomijam`);
  }
  const skills = readSkills(resolve(dir, manifest.capabilities.skills ?? "skills"));
  const persona = manifest.persona && existsSync(resolve(dir, manifest.persona)) ? readFileSync(resolve(dir, manifest.persona), "utf8") : "";
  return { dir, manifest, capabilities: caps, skills, persona, memory: readMemory(dir) };
}

// ───────── boty: wiele agentów w jednym katalogu (agents/<name>) + CRUD plików ─────────

export const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function listAgents(root: string): AgentSpec[] {
  if (!existsSync(root)) return [];
  const out: AgentSpec[] = [];
  for (const f of readdirSync(root).sort()) {
    const d = join(root, f);
    if (!statSync(d).isDirectory() || !existsSync(join(d, "AgentManifest.yaml"))) continue;
    try {
      out.push(loadAgentSpec(d));
    } catch (e) {
      console.warn(`[agents] ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function writeManifest(dir: string, m: AgentManifest) {
  writeFileSync(join(dir, "AgentManifest.yaml"), toYaml(m, { lineWidth: 0 }));
}
export function writePersona(dir: string, m: AgentManifest, text: string) {
  writeFileSync(resolve(dir, m.persona ?? "persona.md"), text.trimEnd() + "\n");
}
export function writeSkill(dir: string, m: AgentManifest, name: string, body: string, meta: { description?: string; uses?: string[] } = {}) {
  if (!SAFE_NAME.test(name)) throw new Error(`zła nazwa skilla: ${name}`);
  const sdir = resolve(dir, m.capabilities?.skills ?? "skills");
  mkdirSync(sdir, { recursive: true });
  const fm = toYaml({ name, description: meta.description ?? "", uses: meta.uses ?? [] }).trimEnd();
  const clean = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  writeFileSync(join(sdir, `${name}.md`), `---\n${fm}\n---\n\n${clean}\n`);
  return join(sdir, `${name}.md`);
}
export function deleteSkill(dir: string, m: AgentManifest, name: string) {
  const p = resolve(dir, m.capabilities?.skills ?? "skills", `${name}.md`);
  if (existsSync(p)) rmSync(p);
}
export function readMemory(dir: string): string[] {
  const p = join(dir, "memory.md");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}
export function writeMemory(dir: string, lines: string[]) {
  writeFileSync(join(dir, "memory.md"), `# Pamięć\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

/** Nowy bot: minimalny folder z manifestem, personą i pustymi skills/plugins. */
export function createAgent(root: string, name: string, opts: { description?: string; persona?: string; look?: AgentManifest["look"]; builtin?: string[] } = {}): AgentSpec {
  if (!SAFE_NAME.test(name)) throw new Error("nazwa: małe litery, cyfry, myślniki (max 40)");
  const dir = join(root, name);
  if (existsSync(dir)) throw new Error(`bot "${name}" już istnieje`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "plugins"), { recursive: true });
  const m: AgentManifest = {
    apiVersion: "qwe/v1",
    kind: "Agent",
    name,
    version: "0.1.0",
    description: opts.description ?? "",
    runtime: { base: "qwe/agent-runtime:0.1.0" },
    capabilities: { builtin: opts.builtin ?? ["web", "computer", "skills"], plugins: "./plugins", packages: [], skills: "./skills" },
    dependencies: { npm: [], system: [] },
    model: { provider: "anthropic" },
    persona: "./persona.md",
    look: { color: "#3A7BD5", avatar: { shape: "circle", eyes: "round", mouth: "smile", acc: [], pattern: "none", idle: "bob" }, ...(opts.look ?? {}) },
    memory: { enabled: true, max: 200 },
  };
  writeManifest(dir, m);
  writePersona(dir, m, opts.persona ?? `# ${name}\n\nJesteś ${name}. Mówisz po polsku, krótko i konkretnie.`);
  writeMemory(dir, []);
  return loadAgentSpec(dir);
}
export function deleteAgent(root: string, name: string) {
  if (!SAFE_NAME.test(name)) throw new Error("zła nazwa");
  rmSync(join(root, name), { recursive: true, force: true });
}

/** Unia zależności (agent + wszystkie capability). `qwe build` fail-uje głośno na konflikty zakresów. */
export function unionDependencies(spec: AgentSpec): { npm: string[]; system: string[]; conflicts: string[] } {
  const npm = new Map<string, string>();
  const conflicts: string[] = [];
  const system = new Set<string>(spec.manifest.dependencies?.system ?? []);
  const add = (dep: string, from: string) => {
    const m = /^(@?[^@]+)(?:@(.+))?$/.exec(dep);
    if (!m) return;
    const [, name, range = "*"] = m;
    const prev = npm.get(name);
    if (prev && prev !== range && prev !== "*" && range !== "*") conflicts.push(`${name}: ${prev} vs ${range} (${from})`);
    if (!prev || prev === "*") npm.set(name, range);
  };
  for (const d of spec.manifest.dependencies?.npm ?? []) add(d, "manifest");
  for (const c of spec.capabilities) {
    for (const d of c.descriptor.dependencies?.npm ?? []) add(d, c.descriptor.name);
    for (const s of c.descriptor.dependencies?.system ?? []) system.add(s);
  }
  return { npm: [...npm].map(([n, r]) => (r === "*" ? n : `${n}@${r}`)), system: [...system], conflicts };
}
