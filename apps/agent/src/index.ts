// AGENT SERVER — proces w tle na maszynie (dev: node na hoście; prod: docker). Endpointy:
//   GET  /health                     docker healthcheck, bez zależności
//   GET  /api/identity /api/status   kto / stan
//   GET  /api/capabilities[/:name]   descriptory + tools (chat buduje z tego prompt)
//   POST /api/tasks                  { sessionId?, block: NativeBlock } → 202 { taskId }
//   GET  /api/tasks[/:id]            inspekcja
//   POST /api/tasks/:id/cancel|pause|resume
//   GET  /api/events?since&sessionId&taskId      log, cursor
//   GET  /api/events/stream?since&sessionId      SSE
//   GET  /api/screenshots/:id
//   GET  /api/mcp                    stan serwerów MCP (połączenie, liczba narzędzi)
//   POST /api/mcp/reload             czyta <data>/mcp.json od nowa i łączy (woła chat po zmianie w UI)
//   POST /api/mcp/:name/reconnect    zamyka i łączy jeden serwer od nowa
//   GET/POST /api/llm                wybrane modele (rozmowa / zadania) — chat server wysyła po starcie agenta i przy każdej zmianie
//   GET  /dashboard/                 podgląd na żywo (pulse rail)
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, Router, builtinPluginDir, commonConfig, createLlm, json, listAgents, loadAgentSpec, loadCapabilities, readCapabilityYaml, readJson, serveStatic, sse, type LlmSelection, type NativeBlock } from "@qwe/core";
import { McpManager } from "@qwe/mcp";
import { AgentRuntime } from "./runtime.js";

const cfg = commonConfig();
const log = (level: "info" | "warn" | "error", message: string) => console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](message);

// Jeden agent server obsługuje WSZYSTKIE boty z agents/ — ładuje unię ich capability (+ skills i memory dla każdego).
// Który bot widzi które narzędzia, decyduje jego manifest (prompt w chacie). W dockerze (jeden bot) agents/ = /agent/workspace/..
const specs = listAgents(cfg.agentsDir);
// Bez simów (świeża instalacja): runtime z wbudowanymi capability, żeby sim dodany później w UI od razu miał narzędzia.
const fallback = (): ReturnType<typeof loadAgentSpec> => {
  if (existsSync(join(cfg.agentDir, "AgentManifest.yaml"))) return loadAgentSpec(cfg.agentDir);
  const caps = ["web", "computer", "skills"].map((name) => ({ kind: "builtin" as const, ref: name, dir: builtinPluginDir(name), descriptor: readCapabilityYaml(builtinPluginDir(name)) }));
  return { dir: cfg.agentsDir, manifest: { apiVersion: "qwe/v1", kind: "Agent", name: "qwe", version: "0.1.0", capabilities: { builtin: ["web", "computer", "skills"] } }, capabilities: caps, skills: [], persona: "", memory: [] };
};
const spec = specs.find((s) => s.manifest.name === cfg.defaultAgent) ?? specs[0] ?? fallback();
if (!specs.length) specs.push(spec);
// wybór modeli z UI: przy spawnie w env (QWE_LLM, JSON), potem POST /api/llm od chat servera
const initialSel = ((): LlmSelection | null => {
  try {
    return process.env.QWE_LLM ? (JSON.parse(process.env.QWE_LLM) as LlmSelection) : null;
  } catch {
    return null;
  }
})();
const llm = createLlm({ apiKey: cfg.anthropicKey, chatModel: cfg.chatModel, executorModel: cfg.executorModel, mock: cfg.mock, chatThinking: cfg.chatThinking, ollamaUrl: cfg.ollamaUrl, ollamaNumCtx: cfg.ollamaNumCtx, selection: initialSel });
const capabilities = await loadCapabilities(specs, { mock: cfg.mock, dataDir: cfg.dataDir, agentsDir: cfg.agentsDir, env: process.env, llm, log });

// Serwery MCP: jeden menedżer na proces, połączenia żyją między zadaniami. Zmiana stanu/katalogu → event mcp.catalog (chat odświeża prompty).
const mcp = new McpManager({
  dataDir: cfg.dataDir,
  agentsDir: cfg.agentsDir,
  cwd: REPO_ROOT,
  log,
  onChange: (s) => void rt.events.append({ type: "mcp.catalog", data: { ...s } }),
});

const rt: AgentRuntime = new AgentRuntime({
  identity: {
    instanceId: process.env.QWE_INSTANCE_ID ?? hostname(),
    name: spec.manifest.name,
    version: spec.manifest.version,
    description: spec.manifest.description,
    buildHash: process.env.QWE_BUILD_HASH,
  },
  capabilities,
  dataDir: cfg.dataDir,
  log,
  dynamicTool: (name) => mcp.tool(name),
  dynamicToolNames: () => mcp.toolNames(),
});
// w tle: agent jest gotowy od razu, a pierwsze wywołanie narzędzia MCP i tak czeka na swoje połączenie
void mcp.reload().catch((e: Error) => log("warn", `[mcp] ${e.message}`));

const PUBLIC = resolve(import.meta.dirname, "..", "public");
const r = new Router();

r.get("/health", (_q, res) => json(res, { ok: true }));
r.get("/api/identity", (_q, res) => json(res, { ...rt.opts.identity, startedAt: rt.startedAt, mock: cfg.mock }));
r.get("/api/status", (_q, res) => json(res, { identity: rt.opts.identity, state: "ready", mock: cfg.mock, tasks: rt.stats(), tools: rt.toolNames(), events: rt.events.size }));
r.get("/api/capabilities", (_q, res) => json(res, { name: spec.manifest.name, agents: specs.map((s) => s.manifest.name), capabilities: rt.descriptors(), skills: spec.skills.map((s) => ({ name: s.name, description: s.description })) }));
r.get("/api/capabilities/:name", (q, res) => {
  const d = rt.descriptors().find((d) => d.name === q.params.name);
  d ? json(res, d) : json(res, { error: `brak capability "${q.params.name}"` }, 404);
});

r.post("/api/tasks", async (q, res) => {
  const body = await readJson<{ sessionId?: string; requestedBy?: string; agent?: string; block?: NativeBlock }>(q);
  const b = body.block;
  if (!b || (b.kind === "direct" && !b.calls?.length) || (b.kind === "plan" && !b.steps?.length)) return json(res, { error: "wymagane block: {kind:'direct',calls:[…]} | {kind:'plan',steps:[…]}" }, 400);
  const task = rt.submit(b, { sessionId: body.sessionId, requestedBy: body.requestedBy, agent: body.agent });
  json(res, { taskId: task.id, state: task.state }, 202);
});
r.get("/api/tasks", (q, res) => json(res, { tasks: rt.list().filter((t) => !q.query.get("sessionId") || t.sessionId === q.query.get("sessionId")).slice(0, 100) }));
r.get("/api/tasks/:id", (q, res) => {
  const t = rt.get(q.params.id);
  t ? json(res, t) : json(res, { error: "nieznany task" }, 404);
});
for (const op of ["cancel", "pause", "resume"] as const)
  r.post(`/api/tasks/:id/${op}`, (q, res) => {
    const t = rt[op](q.params.id);
    t ? json(res, { taskId: t.id, state: t.state }) : json(res, { error: "nieznany task" }, 404);
  });

r.get("/api/events", (q, res) =>
  json(res, {
    events: rt.events.list({ since: Number(q.query.get("since") ?? 0), limit: Math.min(Number(q.query.get("limit") ?? 200), 1000), sessionId: q.query.get("sessionId") ?? undefined, taskId: q.query.get("taskId") ?? undefined }),
  }),
);
r.get("/api/events/stream", (q, res) => {
  const sessionId = q.query.get("sessionId") ?? undefined;
  const since = Number(q.query.get("since") ?? 0);
  const s = sse(q, res);
  for (const e of rt.events.list({ since, limit: 500, sessionId })) s.send(e.seq, e);
  s.onClose(rt.events.subscribe((e) => (!sessionId || e.sessionId === sessionId) && s.send(e.seq, e)));
});
r.get("/api/screenshots/:id", (q, res) => {
  const s = rt.screenshots.get(q.params.id);
  if (!s) return json(res, { error: "brak" }, 404);
  res.writeHead(200, { "content-type": s.mime, "content-length": s.buf.length, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" });
  res.end(s.buf);
});
r.get("/api/llm", (_q, res) => json(res, { selection: llm.selection(), chat: llm.caps("chat"), tools: llm.caps("tools") }));
r.post("/api/llm", async (q, res) => {
  const body = await readJson<{ selection?: LlmSelection | null }>(q);
  llm.select(body.selection ?? null);
  log("info", `[llm] zadania: ${llm.caps("tools").provider}/${llm.caps("tools").model}`);
  json(res, { chat: llm.caps("chat"), tools: llm.caps("tools") });
});
r.get("/api/mcp", (_q, res) => json(res, { servers: mcp.status() }));
r.post("/api/mcp/reload", async (_q, res) => json(res, { servers: await mcp.reload() }));
r.post("/api/mcp/:name/reconnect", async (q, res) => {
  const s = await mcp.reconnect(q.params.name);
  s ? json(res, { server: s }) : json(res, { error: `brak serwera MCP "${q.params.name}"` }, 404);
});

r.get("/", (_q, res) => void res.writeHead(302, { location: "/dashboard/" }).end());
r.get("/dashboard/*", (q, res) => serveStatic(PUBLIC, res, q.params["*"] || "index.html"));

const srv = r.listen(cfg.agentPort, process.env.QWE_IN_DOCKER ? "0.0.0.0" : cfg.host);
srv.on("listening", () => {
  console.log(`qwe agent ${cfg.mock ? "(MOCK) " : ""}→ http://${cfg.host}:${cfg.agentPort}/dashboard/ · boty: ${specs.map((s) => s.manifest.name).join(", ")}`);
  console.log(`  tools: ${rt.toolNames().join(", ") || "(brak)"} · skills: ${spec.skills.map((s) => s.name).join(", ") || "(brak)"} · dane: ${cfg.dataDir}`);
});

const shutdown = () => {
  console.log("agent: zamykam");
  srv.close();
  // serwery stdio to nasze podprocesy — zamykamy je, zanim wyjdziemy
  void mcp.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
