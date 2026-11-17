#!/usr/bin/env node
// qwe — jedno CLI na wszystko. Tak piszemy w terminalu: `qwe dev`, `qwe build`, `qwe run`.
//
//   qwe dev [--mock] [--agent]        chat na hoście (tsx), agent wstaje po pierwszej akcji (albo od razu z --agent)
//   qwe up  [--mock]                  jak dev, ale ze zbudowanych dist (pnpm build)
//   qwe chat | qwe agent [--mock]     pojedynczy proces
//   qwe desktop [--mock]              Electron: okno główne + widget nad wszystkim + tray (⌥Space, ⌃⌥Esc)
//   qwe build [agentDir] [--tag T] [--dry-run]   Dockerfile z AgentManifest.yaml + pluginów → docker build
//   qwe build --runtime [--tag T]     obraz bazowy qwe/agent-runtime (monorepo + Chromium)
//   qwe run [agentDir|image] [--name N] [--port P] [--no-chat]   agent w kontenerze + chat na hoście (QWE_AGENT_MODE=url)
//   qwe ps | qwe stop <name> | qwe logs <name>
//   qwe inspect [agentDir]            co widzi manifest: capability, tools, skille, depsy
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, loadAgentSpec, loadDotenv, unionDependencies } from "@qwe/core";
import { dockerBuildAgent, dockerBuildRuntime, planBuild, RUNTIME_IMAGE_DEFAULT } from "./build.js";
import { sh, shOut } from "./sh.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const VALUE_OPTS = new Set(["--tag", "--name", "--port"]);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !VALUE_OPTS.has(arr[i - 1] ?? ""));
const DEV = import.meta.url.endsWith(".ts");
loadDotenv();

const agentDirArg = () => resolve(process.cwd(), positional[0] ?? process.env.QWE_AGENT_DIR ?? resolve(REPO_ROOT, "agents", "sima"));

async function runApp(app: "chat" | "agent", extra: string[] = [], env: Record<string, string> = {}) {
  const dist = resolve(REPO_ROOT, "apps", app, "dist", "index.js");
  const useDist = cmd === "up" || (!DEV && existsSync(dist));
  if (cmd === "up" && !existsSync(dist)) throw new Error(`brak ${dist} — najpierw: pnpm build`);
  const args = useDist ? ["--no-warnings=ExperimentalWarning", dist] : [fileURLToPath(import.meta.resolve("tsx/cli")), "--conditions=development", resolve(REPO_ROOT, "apps", app, "src", "index.ts")];
  await sh(process.execPath, [...args, ...extra], { env: { ...process.env, ...env } });
}

const help = () => console.log(`qwe — chat + agent + komputer

  qwe dev [--mock] [--agent]      chat (http://127.0.0.1:3100), agent wstaje po pierwszej akcji
  qwe up  [--mock]                to samo ze zbudowanych dist (pnpm build)
  qwe chat | qwe agent [--mock]   pojedynczy proces
  qwe desktop [--mock]            Electron: okno + widget + tray (⌥Space widget, ⌃⌥Esc stop)
  qwe inspect [agentDir]          manifest, capability, tools, skille, depsy
  qwe build [agentDir] [--tag T] [--dry-run]
  qwe build --runtime [--tag T]   obraz bazowy (monorepo + Chromium)
  qwe run [agentDir|image] [--name N] [--port P] [--no-chat]
  qwe ps | qwe stop <name> | qwe logs <name>

  --mock = bez kluczy API (skryptowany LLM, ton zamiast głosu, udawany search, skryptowany computer)`);

try {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      help();
      break;

    case "dev":
    case "up": {
      const mock = flag("mock") ? ["--mock"] : [];
      if (flag("agent")) {
        // agent od razu, chat obok — oba na hoście
        const a = runApp("agent", mock);
        await new Promise((r) => setTimeout(r, 800));
        await Promise.all([a, runApp("chat", mock, { QWE_AGENT_MODE: "url" })]);
      } else await runApp("chat", mock);
      break;
    }
    case "chat":
      await runApp("chat", flag("mock") ? ["--mock"] : []);
      break;
    case "desktop": {
      // Electron (apps/desktop): okno główne + widget + tray; chat startuje sam albo podpina się pod działający `qwe dev`
      const electronCli = resolve(REPO_ROOT, "apps", "desktop", "node_modules", "electron", "cli.js");
      if (!existsSync(electronCli)) throw new Error("brak Electrona — najpierw: pnpm install (apps/desktop)");
      await sh(process.execPath, [electronCli, resolve(REPO_ROOT, "apps", "desktop"), ...(flag("mock") ? ["--mock"] : [])], { env: { ...process.env, QWE_NODE: process.execPath } });
      break;
    }
    case "agent":
      await runApp("agent", flag("mock") ? ["--mock"] : []);
      break;

    case "inspect": {
      const spec = loadAgentSpec(agentDirArg());
      const deps = unionDependencies(spec);
      console.log(`${spec.manifest.name} v${spec.manifest.version} — ${spec.manifest.description ?? ""}\n  dir: ${spec.dir}`);
      for (const c of spec.capabilities) console.log(`  capability ${c.descriptor.name}@${c.descriptor.version} [${c.kind}]\n    tools: ${c.descriptor.tools.map((t) => t.name).join(", ")}\n    deps: ${(c.descriptor.dependencies?.npm ?? []).join(", ") || "—"}`);
      console.log(`  skills: ${spec.skills.map((s) => `${s.name} (${s.path})`).join(", ") || "—"}`);
      console.log(`  deps razem: npm ${deps.npm.join(", ") || "—"} · system ${deps.system.join(", ") || "—"}${deps.conflicts.length ? `\n  KONFLIKTY: ${deps.conflicts.join("; ")}` : ""}`);
      break;
    }

    case "build": {
      if (flag("runtime")) {
        await dockerBuildRuntime(opt("tag") ?? RUNTIME_IMAGE_DEFAULT, { dryRun: flag("dry-run") });
        break;
      }
      const plan = planBuild(agentDirArg(), { tag: opt("tag") });
      await dockerBuildAgent(plan, { dryRun: flag("dry-run") });
      if (!flag("dry-run")) console.log(`\nuruchom:  qwe run ${positional[0] ?? ""} --name ${plan.spec.manifest.name}`);
      break;
    }

    case "run": {
      // agent w kontenerze: wolumen z danymi per instancja (przeżywa rebuildy), .env z kluczami, port
      const target = positional[0];
      let image: string;
      let name: string;
      if (target && existsSync(resolve(process.cwd(), target, "AgentManifest.yaml"))) {
        const spec = loadAgentSpec(resolve(process.cwd(), target));
        image = `qwe/agent-${spec.manifest.name}:${spec.manifest.version}`;
        name = opt("name") ?? spec.manifest.name;
      } else if (target) {
        image = target;
        name = opt("name") ?? target.replace(/^qwe\/agent-/, "").replace(/[:/]/g, "-");
      } else {
        const spec = loadAgentSpec(agentDirArg());
        image = `qwe/agent-${spec.manifest.name}:${spec.manifest.version}`;
        name = opt("name") ?? spec.manifest.name;
      }
      const port = opt("port") ?? "7777";
      const dataDir = resolve(homedir(), ".qwe", "instances", name);
      mkdirSync(dataDir, { recursive: true });
      const envFile = resolve(REPO_ROOT, ".env");
      await shOut("docker", ["rm", "-f", `qwe-${name}`]).catch(() => "");
      const args = ["run", "-d", "--name", `qwe-${name}`, "-p", `${port}:7777`, "-v", `${dataDir}:/agent/data`, "-e", `QWE_INSTANCE_ID=${name}`, "--label", "org.qwe.instance=1"];
      if (existsSync(envFile)) args.push("--env-file", envFile);
      args.push(image);
      await sh("docker", args);
      console.log(`✓ kontener qwe-${name} → http://127.0.0.1:${port}/dashboard/  (dane: ${dataDir})`);
      if (!flag("no-chat")) {
        console.log("chat na hoście → agent w kontenerze (QWE_AGENT_MODE=url)");
        console.log("uwaga: computer w kontenerze jest headless — logowanie przez usera wymaga agenta na hoście (qwe dev)");
        await runApp("chat", flag("mock") ? ["--mock"] : [], { QWE_AGENT_MODE: "url", QWE_AGENT_URL: `http://127.0.0.1:${port}` });
      }
      break;
    }
    case "ps":
      await sh("docker", ["ps", "-a", "--filter", "label=org.qwe.instance=1", "--format", "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"]);
      break;
    case "stop":
      await sh("docker", ["rm", "-f", `qwe-${positional[0] ?? "default"}`]);
      break;
    case "logs":
      await sh("docker", ["logs", "-f", `qwe-${positional[0] ?? "default"}`]);
      break;

    default:
      console.error(`nieznana komenda: ${cmd}\n`);
      help();
      process.exit(1);
  }
} catch (e) {
  console.error(`qwe: ${(e as Error).message}`);
  process.exit(1);
}
