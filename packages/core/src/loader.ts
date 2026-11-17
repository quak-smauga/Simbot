// LOADER — instancjonuje capability z AgentSpec. Agent server woła to raz na boot.
// builtin (plugins/<name> w monorepo), plugin (folder agenta) i package (node_modules) — wszystkie przez ścieżkę:
// import(<dir>/{src/index.ts | dist/index.js | index.js}) — dev (tsx) bierze src, zbudowany runtime bierze dist.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CapabilityContext, CapabilityModule, LoadedCapability } from "./capability.js";
import type { AgentSpec, CapabilityRef } from "./manifest.js";

const DEV = import.meta.url.endsWith(".ts");

async function importCapability(ref: CapabilityRef): Promise<CapabilityModule> {
  const dir = ref.dir!;
  const candidates = DEV ? ["src/index.ts", "index.ts", "index.js", "index.mjs", "dist/index.js"] : ["dist/index.js", "index.js", "index.mjs"];
  for (const f of candidates) {
    const p = join(dir, f);
    if (existsSync(p)) return (await import(pathToFileURL(p).href)) as CapabilityModule;
  }
  throw new Error(`capability ${ref.descriptor.name}: brak index.(js|ts) w ${dir}`);
}

export async function loadCapabilities(spec: AgentSpec | AgentSpec[], ctx: CapabilityContext): Promise<LoadedCapability[]> {
  const out: LoadedCapability[] = [];
  const seen = new Set<string>();
  const refs = (Array.isArray(spec) ? spec : [spec]).flatMap((s) => s.capabilities).filter((r) => (seen.has(r.descriptor.name) ? false : (seen.add(r.descriptor.name), true)));
  for (const ref of refs) {
    const mod = await importCapability(ref);
    if (typeof mod.create !== "function") throw new Error(`capability ${ref.descriptor.name}: brak export create()`);
    const tools = await mod.create(ctx);
    // descriptor z yaml jest źródłem prawdy; moduł może go nadpisać (np. wygenerowane usage)
    const descriptor = { ...ref.descriptor, ...(mod.descriptor ?? {}) };
    for (const t of descriptor.tools) if (!tools[t.name]) ctx.log("warn", `capability ${descriptor.name}: tool "${t.name}" w yaml, ale create() go nie zwrócił`);
    out.push({ descriptor, tools, source: `${ref.kind}:${ref.ref}` });
  }
  return out;
}
