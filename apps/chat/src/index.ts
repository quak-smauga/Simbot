// CHAT SERVER — rozmowy (sqlite) + simy + UI + WS. Agent server wstaje dopiero po pierwszej akcji z chatu (AgentLink.ensure()).
//   GET    /                          UI
//   GET    /api/config                mock, modele, agent url, user, simy
//   GET/PUT /api/me                   profil usera (imię, awatar)
//   GET/PUT /api/me/memory            wspólna pamięć o userze (fakty, które znają wszystkie simy)
//   GET/POST /api/bots · GET/PATCH/DELETE /api/bots/:name · skills · memory     simy (CRUD dookoła agents/<name>)
//   GET/POST /api/workflows · PATCH/DELETE /api/workflows/:id                    workflowy (jak simy mają się zachowywać w rozmowie)
//   GET    /api/sessions              lista (sidebar) — ze stanem, snippetem, nieprzeczytanymi
//   POST   /api/sessions              { bots?: [...], workflowId? }   (bez bots → Sima)
//   GET    /api/sessions/:id          wiadomości + eventy (odtworzenie wątku)
//   PATCH  /api/sessions/:id          { title?, bots?, workflowId? }
//   DELETE /api/sessions/:id
//   POST   /api/sessions/:id/control  { op: pause|resume|cancel, taskId? }
//   GET    /api/sessions/:id/files?dir=…   folder rozmowy: zawartość folderu (?all=1 — wszystko, rekurencyjnie)
//   POST   /api/sessions/:id/files?name=…&dir=…   (surowe bajty) dodaje · GET …/files/:path serwuje (ścieżka zakodowana)
//   POST   /api/sessions/:id/files/{mkdir,move,delete,open}   panel plików: nowy folder, zmiana nazwy / przeniesienie,
//          usunięcie, „Pokaż w Finderze” (tylko z naszego UI)
//   GET    /api/mcp · PUT/DELETE /api/mcp/:name · POST /api/mcp/:name/reconnect   serwery MCP (tylko z naszego UI)
//   GET/PUT /api/llm · POST /api/llm/ollama/start|pull   wybór modeli (rozmowa / zadania), Ollama: status, modele, pobieranie
//   GET    /api/agent/status          czy agent żyje
//   GET    /api/screenshots/:id       proxy do agenta (UI nie musi znać jego adresu)
//   WS     /ws?session=<id>|lobby
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { Router, commonConfig, createLlm, json, readJson, serveStatic, userSlug, type AvatarConfig, type LlmSelection, type Req } from "@qwe/core";
import { voiceConfigFromEnv } from "@qwe/voice";
import { BotRegistry, DEFAULT_USER, SIMA, botView, type UserProfile } from "./bots.js";
import { SessionHub } from "./hub.js";
import { Store } from "./store.js";
import { attachWs } from "./ws.js";
import { registerMcpRoutes } from "./mcp.js";
import { LLM_SETTING, registerModelRoutes } from "./models.js";
import { absPath, filesDir, listAll, listDir, makeDir, mimeOf, movePath, readFile, removeDir, removePaths, saveFile } from "./files.js";
import { fromOwnUi } from "./mcp.js";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const cfg = commonConfig();
const DEV = import.meta.url.endsWith(".ts");
const PUBLIC = resolve(import.meta.dirname, "..", "public");
const log = (level: "info" | "warn" | "error", message: string) => console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](message);

const store = new Store(cfg.dataDir);
// wybór modeli z UI (settings "llm") nadpisuje env; agent dostaje go przy starcie i po każdej zmianie
const llm = createLlm({ apiKey: cfg.anthropicKey, chatModel: cfg.chatModel, executorModel: cfg.executorModel, mock: cfg.mock, chatThinking: cfg.chatThinking, ollamaUrl: cfg.ollamaUrl, ollamaNumCtx: cfg.ollamaNumCtx, selection: store.getSetting<LlmSelection | null>(LLM_SETTING, null) });
const bots = new BotRegistry(cfg.agentsDir, cfg.defaultAgent, llm);
const voiceCfg = voiceConfigFromEnv(process.env, cfg.mock);
bots.setUser(store.getSetting<UserProfile>("me", DEFAULT_USER));
// wspólna pamięć o userze (dla wszystkich simów) — w settings
bots.setUserMemoryStore({ get: () => store.getSetting<string[]>("me.memory", []), set: (lines) => store.setSetting("me.memory", lines) });
bots.setDataDir(cfg.dataDir);
const hub = new SessionHub(store, llm, voiceCfg, bots, cfg.chatMaxTokens, cfg.mock, { url: cfg.agentUrl, mode: cfg.agentMode, port: cfg.agentPort, host: cfg.host, mock: cfg.mock, dev: DEV, log, llm: () => llm.selection() }, cfg.dataDir);

const r = new Router();
const bad = (res: Parameters<typeof json>[0], e: unknown, code = 400) => json(res, { error: (e as Error).message }, code);
const me = () => bots.getUser();

r.get("/api/config", (_q, res) =>
  json(res, {
    mock: cfg.mock,
    llm: llm.mock ? "mock" : llm.caps("chat").model,
    voice: voiceCfg.mock ? "mock" : "elevenlabs",
    agent: { url: cfg.agentUrl, mode: cfg.agentMode, status: hub.link.status },
    me: me(),
    bots: bots.visible().map(botView),
    sima: botView(bots.sima()),
    builtinAvailable: bots.builtinAvailable,
    workflows: store.listWorkflows().map((w) => ({ id: w.id, name: w.name })),
  }),
);

// ───────── user ─────────
r.get("/api/me", (_q, res) => json(res, me()));
r.put("/api/me", async (q, res) => {
  const body = await readJson<{ name?: string; look?: { color?: string; avatar?: AvatarConfig } }>(q);
  const cur = me();
  const name = (body.name ?? cur.name).trim().slice(0, 40);
  const next: UserProfile = { name, slug: userSlug(name), look: { color: body.look?.color ?? cur.look.color, avatar: { ...cur.look.avatar, ...(body.look?.avatar ?? {}) } } };
  store.setSetting("me", next);
  bots.setUser(next);
  json(res, next);
});

r.get("/api/me/memory", (_q, res) => json(res, { lines: bots.userMemory() }));
r.put("/api/me/memory", async (q, res) => {
  const body = await readJson<{ lines?: string[] }>(q);
  bots.setUserMemory(body.lines ?? []);
  json(res, { lines: bots.userMemory() });
});

// ───────── simy: CRUD dookoła agents/<name> ─────────
const botOr404 = (name: string, res: Parameters<typeof json>[0]) => {
  const b = bots.get(name);
  if (!b) json(res, { error: `nieznany sim "${name}"` }, 404);
  return b;
};
r.get("/api/bots", (_q, res) => json(res, { bots: bots.visible().map(botView), sima: botView(bots.sima()), builtinAvailable: bots.builtinAvailable }));
r.post("/api/bots", async (q, res) => {
  const body = await readJson<{ name?: string; description?: string; persona?: string; look?: Record<string, unknown>; builtin?: string[] }>(q);
  try {
    const b = bots.create((body.name ?? "").trim().toLowerCase(), { description: body.description, persona: body.persona, look: body.look as never, builtin: body.builtin });
    json(res, botView(b), 201);
  } catch (e) {
    bad(res, e);
  }
});
r.get("/api/bots/:name", (q, res) => {
  const b = botOr404(q.params.name, res);
  if (b) json(res, botView(b));
});
r.patch("/api/bots/:name", async (q, res) => {
  if (!botOr404(q.params.name, res)) return;
  const body = await readJson<Parameters<typeof bots.update>[1]>(q);
  try {
    json(res, botView(bots.update(q.params.name, body)));
  } catch (e) {
    bad(res, e);
  }
});
r.delete("/api/bots/:name", (q, res) => {
  try {
    bots.remove(q.params.name);
    // rozmowy zostają, sim z nich znika
    for (const s of store.listSessions()) if (s.members.includes(q.params.name)) hub.open(s.id)?.removeMember(q.params.name);
    json(res, { ok: true });
  } catch (e) {
    bad(res, e);
  }
});
r.post("/api/bots/:name/skills", async (q, res) => {
  if (!botOr404(q.params.name, res)) return;
  const body = await readJson<{ name?: string; body?: string; description?: string }>(q);
  try {
    bots.saveSkill(q.params.name, (body.name ?? "").trim().toLowerCase(), body.body ?? "", body.description);
    json(res, botView(bots.get(q.params.name)!));
  } catch (e) {
    bad(res, e);
  }
});
r.delete("/api/bots/:name/skills/:skill", (q, res) => {
  if (!botOr404(q.params.name, res)) return;
  bots.removeSkill(q.params.name, q.params.skill);
  json(res, botView(bots.get(q.params.name)!));
});
r.put("/api/bots/:name/memory", async (q, res) => {
  if (!botOr404(q.params.name, res)) return;
  const body = await readJson<{ lines?: string[] }>(q);
  bots.setMemory(q.params.name, (body.lines ?? []).map((l) => String(l).trim()).filter(Boolean));
  json(res, botView(bots.get(q.params.name)!));
});

// ───────── workflowy ─────────
r.get("/api/workflows", (_q, res) => json(res, { workflows: store.listWorkflows() }));
r.post("/api/workflows", async (q, res) => {
  const body = await readJson<{ name?: string; body?: string }>(q);
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) return json(res, { error: "podaj nazwę" }, 400);
  json(res, store.createWorkflow(name, body.body ?? ""), 201);
});
r.patch("/api/workflows/:id", async (q, res) => {
  const body = await readJson<{ name?: string; body?: string }>(q);
  const w = store.updateWorkflow(q.params.id, { name: body.name?.trim().slice(0, 60), body: body.body });
  w ? json(res, w) : json(res, { error: "nieznany workflow" }, 404);
});
r.delete("/api/workflows/:id", (q, res) => {
  store.deleteWorkflow(q.params.id);
  for (const s of hub.listView()) hub.announce(s.id);
  json(res, { ok: true });
});

// ───────── serwery MCP ─────────
registerMcpRoutes(r, { dataDir: cfg.dataDir, bots, link: hub.link, log });
registerModelRoutes(r, { llm, store, link: hub.link, hasAnthropicKey: !!cfg.anthropicKey, mock: cfg.mock, log });

// ───────── agent ─────────
r.get("/api/agent/status", async (_q, res) => {
  let up = false;
  try {
    up = (await fetch(`${cfg.agentUrl}/health`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    /* down */
  }
  json(res, { status: up ? "up" : hub.link.status, url: cfg.agentUrl });
});
r.post("/api/agent/start", async (_q, res) => {
  try {
    await hub.link.ensure();
    json(res, { status: "up" });
  } catch (e) {
    bad(res, e, 500);
  }
});

// ───────── rozmowy ─────────
r.get("/api/sessions", (_q, res) => json(res, { sessions: hub.listView() }));
r.post("/api/sessions", async (q, res) => {
  const body = await readJson<{ title?: string; bots?: string[]; workflowId?: string | null }>(q).catch(() => ({}) as { title?: string; bots?: string[]; workflowId?: string | null });
  // bez wybranych simów → rozmowa z Simą (domyślna)
  const picked = (body.bots ?? []).filter((b) => bots.get(b));
  const members = picked.length ? picked : [SIMA];
  if (body.workflowId && !store.getWorkflow(body.workflowId)) return json(res, { error: "nieznany workflow" }, 400);
  const s = store.createSession(body.title?.trim() || "Nowa rozmowa", members, body.workflowId ?? null);
  hub.announce(s.id);
  json(res, s, 201);
});
r.get("/api/sessions/:id", (q, res) => {
  const s = store.getSession(q.params.id);
  if (!s) return json(res, { error: "nieznana rozmowa" }, 404);
  const live = hub.live(s.id);
  const wf = s.workflow_id ? store.getWorkflow(s.workflow_id) : undefined;
  json(res, {
    session: { ...s, members: s.members.filter((m) => bots.get(m)) },
    workflow: wf ? { id: wf.id, name: wf.name } : null,
    state: live?.getState() ?? "idle",
    activeTaskId: live?.activeTaskId ?? null,
    messages: store.messages(s.id).map((m) => ({ id: m.id, role: m.role, author: m.author, content: m.role === "tool" ? "" : m.content, meta: m.meta ? JSON.parse(m.meta) : null, at: m.created_at })),
    events: store.events(s.id).map((e) => ({ seq: e.seq, type: e.type, at: e.at, taskId: e.task_id, ...JSON.parse(e.data) })),
  });
});
r.patch("/api/sessions/:id", async (q, res) => {
  const body = await readJson<{ title?: string; bots?: string[]; workflowId?: string | null }>(q);
  if (!store.getSession(q.params.id)) return json(res, { error: "nieznana rozmowa" }, 404);
  try {
    if (body.title?.trim()) store.renameSession(q.params.id, body.title.trim().slice(0, 80), true);
    const live = hub.open(q.params.id)!;
    if (body.bots) {
      const want = body.bots.filter((b) => bots.get(b));
      for (const m of live.members) if (!want.includes(m)) live.removeMember(m);
      for (const m of want) live.addMember(m);
    }
    if (body.workflowId !== undefined) live.setWorkflow(body.workflowId);
    hub.announce(q.params.id);
    json(res, store.getSession(q.params.id));
  } catch (e) {
    bad(res, e);
  }
});
r.delete("/api/sessions/:id", (q, res) => {
  hub.close(q.params.id);
  store.deleteSession(q.params.id);
  removeDir(cfg.dataDir, q.params.id);
  hub.announce(q.params.id);
  json(res, { ok: true });
});
r.post("/api/sessions/:id/control", async (q, res) => {
  const body = await readJson<{ op: "pause" | "resume" | "cancel"; taskId?: string }>(q);
  const s = hub.open(q.params.id);
  if (!s) return json(res, { error: "nieznana rozmowa" }, 404);
  json(res, await s.control(body.op, body.taskId));
});
r.get("/api/screenshots/:id", async (q, res) => {
  // spawn/dev: ten sam QWE_DATA_DIR co agent → plik jest lokalnie (działa też, gdy agent śpi)
  if (/^\w+$/.test(q.params.id)) {
    for (const ext of ["jpg", "png"]) {
      const f = resolve(cfg.dataDir, "screenshots", `${q.params.id}.${ext}`);
      if (existsSync(f)) return serveStatic(resolve(cfg.dataDir, "screenshots"), res, `${q.params.id}.${ext}`, "public, max-age=86400");
    }
  }
  try {
    const up = await fetch(hub.link.screenshotUrl(q.params.id));
    if (!up.ok) return json(res, { error: "brak" }, up.status);
    res.writeHead(200, { "content-type": up.headers.get("content-type") ?? "image/jpeg", "cache-control": "public, max-age=86400" });
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch {
    json(res, { error: "agent offline" }, 502);
  }
});
// ───────── pliki rozmowy (folder <data>/sessions/<id>/files) ─────────
const readBody = (q: IncomingMessage, max = 26 * 1024 * 1024) =>
  new Promise<Buffer>((ok, fail) => {
    const chunks: Buffer[] = [];
    let n = 0;
    q.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        fail(new Error("plik za duży (maks. 25 MB)"));
        q.destroy();
      } else chunks.push(c);
    });
    q.on("end", () => ok(Buffer.concat(chunks)));
    q.on("error", fail);
  });
r.get("/api/sessions/:id/files", (q, res) => {
  if (!store.getSession(q.params.id)) return json(res, { error: "nieznana rozmowa" }, 404);
  const dir = filesDir(cfg.dataDir, q.params.id);
  if (q.query.get("all")) return json(res, { dir, entries: listAll(dir) });
  const entries = listDir(dir, q.query.get("dir") ?? "");
  if (!entries) return json(res, { error: "nie ma takiego folderu" }, 404);
  json(res, { dir, entries });
});
/** Mutacje folderu: tylko z naszego UI i dla istniejącej rozmowy. */
const filesGuard = (q: Req, res: ServerResponse) => {
  if (!fromOwnUi(q)) return void json(res, { error: "tylko z UI Simbota" }, 403);
  if (!store.getSession(q.params.id)) return void json(res, { error: "nieznana rozmowa" }, 404);
  return filesDir(cfg.dataDir, q.params.id);
};
r.post("/api/sessions/:id/files", async (q, res) => {
  const dir = filesGuard(q, res);
  if (!dir) return;
  try {
    const data = await readBody(q);
    json(res, saveFile(dir, q.query.get("name") || "plik", data, q.query.get("dir") ?? ""), 201);
  } catch (e) {
    bad(res, e);
  }
});
r.post("/api/sessions/:id/files/mkdir", async (q, res) => {
  const dir = filesGuard(q, res);
  if (!dir) return;
  try {
    const b = (await readJson(q)) as { parent?: string; name?: string };
    json(res, { path: makeDir(dir, b.parent ?? "", b.name || "nowy folder") }, 201);
  } catch (e) {
    bad(res, e);
  }
});
r.post("/api/sessions/:id/files/move", async (q, res) => {
  const dir = filesGuard(q, res);
  if (!dir) return;
  try {
    const b = (await readJson(q)) as { from?: string; to?: string };
    json(res, { path: movePath(dir, b.from ?? "", b.to ?? "") });
  } catch (e) {
    bad(res, e);
  }
});
r.post("/api/sessions/:id/files/delete", async (q, res) => {
  const dir = filesGuard(q, res);
  if (!dir) return;
  try {
    const b = (await readJson(q)) as { paths?: string[] };
    json(res, { removed: removePaths(dir, Array.isArray(b.paths) ? b.paths.slice(0, 500).map(String) : []) });
  } catch (e) {
    bad(res, e);
  }
});
r.post("/api/sessions/:id/files/open", async (q, res) => {
  const dir = filesGuard(q, res);
  if (!dir) return;
  const b = ((await readJson(q).catch(() => ({}))) ?? {}) as { path?: string };
  mkdirSync(dir, { recursive: true });
  const target = b.path ? absPath(dir, b.path) : dir;
  if (!target) return json(res, { error: "nie ma takiego pliku" }, 404);
  // plik → zaznaczony w Finderze (open -R); folder → otwarty
  const mac = process.platform === "darwin";
  const args = mac && b.path ? ["-R", target] : [target];
  spawn(mac ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", args, { detached: true, stdio: "ignore" }).unref();
  json(res, { ok: true, dir: target });
});
r.get("/api/sessions/:id/files/:name", (q, res) => {
  const data = readFile(filesDir(cfg.dataDir, q.params.id), decodeURIComponent(q.params.name));
  if (!data) return json(res, { error: "nie ma takiego pliku" }, 404);
  const mime = mimeOf(q.params.name);
  // obrazy i PDF w przeglądarce; reszta jako zwykły tekst / pobranie (bez wykonywania HTML/SVG z folderu)
  const safe = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/.test(mime) ? mime : mime.startsWith("text/") || mime === "application/json" || mime === "image/svg+xml" || mime === "text/html" ? "text/plain; charset=utf-8" : "application/octet-stream";
  // PDF bez sandbox (inaczej wbudowana przeglądarka PDF w Chrome/Electronie pokazuje pustą stronę); reszta — sandbox
  res.writeHead(200, { "content-type": safe, "x-content-type-options": "nosniff", "cache-control": "private, no-cache", ...(safe === "application/pdf" ? {} : { "content-security-policy": "sandbox" }) });
  res.end(data);
});

r.get("/healthz", (_q, res) => json(res, { ok: true }));
r.get("/", (_q, res) => serveStatic(PUBLIC, res, "index.html"));
r.get("/*", (q, res) => serveStatic(PUBLIC, res, q.params["*"] || "index.html", q.params["*"]?.startsWith("vendor/") ? "public, max-age=604800" : "no-cache"));

const srv = r.listen(cfg.chatPort, cfg.host);
const wss = new WebSocketServer({ server: srv, path: "/ws" });
attachWs(wss, hub);
srv.on("listening", () => {
  console.log(`qwe chat ${cfg.mock ? "(MOCK — bez API) " : ""}→ http://${cfg.host}:${cfg.chatPort}`);
  console.log(`  llm: ${llm.mock ? "mock" : `${llm.caps("chat").provider}/${llm.caps("chat").model}`} · voice: ${voiceCfg.mock ? "mock" : "elevenlabs"} · agent: ${cfg.agentMode === "spawn" ? "wstanie po pierwszej akcji" : cfg.agentUrl} · dane: ${cfg.dataDir}`);
  console.log(`  simy: ${bots.names().join(", ")} · ${cfg.agentsDir} · user: ${me().name || "(bez imienia)"}`);
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
