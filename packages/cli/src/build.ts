// qwe build — AgentManifest.yaml + pluginy → Dockerfile + capability-deps → docker build.
// Pierwsza wersja potrzebuje parsera YAML i wypełniacza szablonu, nie kompilatora. DSL wtedy, gdy manifest
// naprawdę będzie musiał wyrazić coś, czego struktura danych nie umie.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, loadAgentSpec, unionDependencies, type AgentSpec } from "@qwe/core";
import { sh } from "./sh.js";

export const RUNTIME_IMAGE_DEFAULT = "qwe/agent-runtime:0.1.0";

export interface BuildPlan {
  spec: AgentSpec;
  image: string;
  runtimeImage: string;
  buildHash: string;
  dockerfile: string;
  outDir: string;
  deps: { npm: string[]; system: string[] };
}

function hashDir(dir: string, h: ReturnType<typeof createHash>) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).sort()) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) hashDir(p, h);
    else {
      h.update(relative(dir, p));
      h.update(readFileSync(p));
    }
  }
}

export function planBuild(agentDir: string, opts: { tag?: string; runtimeImage?: string } = {}): BuildPlan {
  const spec = loadAgentSpec(agentDir);
  const deps = unionDependencies(spec);
  if (deps.conflicts.length) throw new Error(`konflikt zależności:\n  ${deps.conflicts.join("\n  ")}`);
  // depsy pluginów WBUDOWANYCH są już w obrazie runtime — do capability-deps idą tylko lokalne pluginy i paczki
  const builtinDeps = new Set(spec.capabilities.filter((c) => c.kind === "builtin").flatMap((c) => c.descriptor.dependencies?.npm ?? []));
  const npm = deps.npm.filter((d) => !builtinDeps.has(d));

  const h = createHash("sha256");
  h.update(readFileSync(join(spec.dir, "AgentManifest.yaml")));
  h.update(JSON.stringify({ npm, system: deps.system }));
  if (spec.manifest.capabilities.plugins) hashDir(resolve(spec.dir, spec.manifest.capabilities.plugins), h);
  hashDir(resolve(spec.dir, spec.manifest.capabilities.skills ?? "skills"), h);
  if (spec.manifest.persona) h.update(spec.persona);
  const buildHash = h.digest("hex").slice(0, 12);

  const runtimeImage = opts.runtimeImage ?? spec.manifest.runtime?.base ?? RUNTIME_IMAGE_DEFAULT;
  const image = opts.tag ?? `qwe/agent-${spec.manifest.name}:${spec.manifest.version}`;
  const pkgJson = { name: `qwe-agent-${spec.manifest.name}-deps`, private: true, type: "module", dependencies: Object.fromEntries(npm.map((d) => splitDep(d))) };
  const outDir = join(spec.dir, ".qwe", "build");
  mkdirSync(join(outDir, "capability-deps"), { recursive: true });
  writeFileSync(join(outDir, "capability-deps", "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const tpl = readFileSync(resolve(import.meta.dirname, "..", "templates", "agent.Dockerfile.template"), "utf8");
  const rel = (p?: string) => (p ? relative(spec.dir, resolve(spec.dir, p)).replace(/\\/g, "/") : "");
  const vars: Record<string, string> = {
    RUNTIME_IMAGE: runtimeImage,
    APT_PACKAGES: deps.system.join(" "),
    NAME: spec.manifest.name,
    VERSION: spec.manifest.version,
    BUILD_HASH: buildHash,
    PERSONA: rel(spec.manifest.persona),
    PLUGINS: rel(spec.manifest.capabilities.plugins),
    SKILLS: rel(spec.manifest.capabilities.skills ?? "skills"),
  };
  const flags: Record<string, boolean> = {
    IF_APT: deps.system.length > 0,
    IF_PERSONA: !!spec.manifest.persona && existsSync(resolve(spec.dir, spec.manifest.persona)),
    IF_PLUGINS: !!spec.manifest.capabilities.plugins && existsSync(resolve(spec.dir, spec.manifest.capabilities.plugins)),
    IF_SKILLS: existsSync(resolve(spec.dir, spec.manifest.capabilities.skills ?? "skills")),
  };
  let dockerfile = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) => (flags[k] ? body : ""));
  dockerfile = dockerfile.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  dockerfile = dockerfile.replace(/\n{3,}/g, "\n\n");
  writeFileSync(join(outDir, "Dockerfile"), dockerfile);
  return { spec, image, runtimeImage, buildHash, dockerfile, outDir, deps: { npm, system: deps.system } };
}

function splitDep(d: string): [string, string] {
  const m = /^(@?[^@]+)(?:@(.+))?$/.exec(d)!;
  return [m[1], m[2] ?? "*"];
}

export async function dockerBuildAgent(plan: BuildPlan, opts: { dryRun?: boolean } = {}) {
  console.log(`qwe build · ${plan.spec.manifest.name} v${plan.spec.manifest.version} · hash ${plan.buildHash}`);
  console.log(`  runtime: ${plan.runtimeImage}`);
  console.log(`  capability: ${plan.spec.capabilities.map((c) => `${c.descriptor.name}(${c.kind})`).join(", ")}`);
  console.log(`  deps npm: ${plan.deps.npm.join(", ") || "—"} · system: ${plan.deps.system.join(", ") || "—"}`);
  console.log(`  skills: ${plan.spec.skills.map((s) => s.name).join(", ") || "—"}`);
  console.log(`  → ${relative(process.cwd(), join(plan.outDir, "Dockerfile"))}`);
  if (opts.dryRun) return;
  // kontekst = folder agenta; Dockerfile z .qwe/build
  await sh("docker", ["build", "-f", join(plan.outDir, "Dockerfile"), "-t", plan.image, "--label", `org.qwe.build.hash=${plan.buildHash}`, plan.spec.dir]);
  console.log(`✓ obraz ${plan.image}`);
}

export async function dockerBuildRuntime(tag = RUNTIME_IMAGE_DEFAULT, opts: { dryRun?: boolean } = {}) {
  console.log(`qwe build --runtime → ${tag} (kontekst: ${REPO_ROOT})`);
  if (opts.dryRun) return;
  await sh("docker", ["build", "-f", join(REPO_ROOT, "docker", "runtime.Dockerfile"), "-t", tag, REPO_ROOT]);
  console.log(`✓ obraz ${tag}`);
}
