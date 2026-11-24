#!/usr/bin/env node
// 🚗 ROBOT-MCP — serwer MCP dla jeżdżącego robota Simbota (ESP32 + L298N + podwozie 2WD). Zero zależności.
//
//   node robot-mcp.mjs              → stdio (simbot odpala go jako subprocess)
//   node robot-mcp.mjs --http 3334  → Streamable HTTP na http://localhost:3334/mcp
//
// Robot wystawia proste HTTP API (firmware na ESP32):
//   POST /api/move   { direction: forward|backward|left|right, duration_ms }   nagłówek X-Simbot-Token
//   POST /api/stop                                                              nagłówek X-Simbot-Token
//   GET  /api/status                                                            bez tokenu
// Firmware sam zatrzymuje silniki po duration_ms i nigdy nie jedzie dłużej niż 1200 ms na jedno polecenie.
//
// Konfiguracja przez zmienne środowiskowe (w data/mcp.json → "env"):
//   ROBOT_URL    adres robota, domyślnie http://simbot.local
//   ROBOT_TOKEN  token z firmware (apiToken) — bez niego działa tylko status
//
// Protokół idzie po stdout (stdio) albo HTTP. Logi lecą ZAWSZE na stderr.

import http from "node:http";
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER = { name: "robot-mcp", title: "🚗 Robot Simbota", version: "0.1.0" };

const ROBOT_URL = (process.env.ROBOT_URL || "http://simbot.local").replace(/\/+$/, "");
const ROBOT_TOKEN = process.env.ROBOT_TOKEN || "";
/** Limit jednego ruchu w firmware (MAX_MOVE_MS). Dłuższy odcinek = kilka ruchów albo `sekwencja`. */
const MAX_MOVE_MS = 1200;
const MIN_MOVE_MS = 50;
const MAX_SEQUENCE = 12;
/** Przerwa między ruchami w sekwencji — silniki zdążą stanąć, robot nie szarpie. */
const GAP_MS = 150;
const HTTP_TIMEOUT_MS = 5000;

// ───────────────────────── logi ─────────────────────────
const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const C = { red: c(31), green: c(32), yellow: c(33), cyan: c(36), gray: c(90), bold: c(1) };
const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const ts = () => C.gray(new Date().toLocaleTimeString("pl-PL"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── rozmowa z robotem ─────────────────────────
class RobotError extends Error {}

/** simbot.local (mDNS) bywa wolny przy każdym zapytaniu — po pierwszym statusie rozmawiamy po IP, które robot sam podał. */
let base = ROBOT_URL;

async function robot(method, path, body) {
  const needsToken = path !== "/api/status";
  if (needsToken && !ROBOT_TOKEN) throw new RobotError("Brak tokenu robota: ustaw ROBOT_TOKEN w konfiguracji serwera MCP (data/mcp.json → env). Bez tokenu działa tylko `status`.");
  const call = async (root) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(needsToken ? { "X-Simbot-Token": ROBOT_TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  let r;
  try {
    r = await call(base);
  } catch (e) {
    // zapamiętane IP mogło się zmienić (DHCP) — jedna próba po nazwie
    if (base !== ROBOT_URL) {
      base = ROBOT_URL;
      try { r = await call(base); } catch {}
    }
    if (!r) throw new RobotError(`Robot nie odpowiada pod ${ROBOT_URL} (${e.name === "TimeoutError" ? "brak odpowiedzi w 5 s" : e.cause?.code || e.message}). Sprawdź, czy jest włączony, podłączony do tego samego WiFi i czy adres jest dobry.`);
  }
  if (r.status === 401) throw new RobotError("Robot odrzucił token (401). ROBOT_TOKEN w konfiguracji MCP musi być taki sam jak apiToken w firmware.");
  if (r.status >= 400 || r.json?.ok === false) throw new RobotError(`Robot odmówił (${r.status}): ${r.json?.error || r.text.slice(0, 120) || "bez opisu"}`);
  return r.json ?? {};
}

async function status() {
  const s = await robot("GET", "/api/status");
  if (typeof s.ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(s.ip) && s.ip !== "0.0.0.0") base = `http://${s.ip}`;
  return s;
}

const DIRS = { przod: "forward", tyl: "backward", lewo: "left", prawo: "right" };
const DIR_PL = { forward: "do przodu", backward: "do tyłu", left: "obrót w lewo", right: "obrót w prawo" };
/** „przód”, „do przodu”, „forward”, „w lewo”… → forward|backward|left|right */
function direction(v) {
  const k = String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/^(do|w|na)\s+/, "").trim();
  const d = DIRS[k] ?? DIRS[k.replace(/u$/, "")] ?? (Object.values(DIRS).includes(k) ? k : null);
  if (!d) throw new RobotError(`Nieznany kierunek „${v}”. Dozwolone: przod, tyl, lewo, prawo.`);
  return d;
}
function duration(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw new RobotError(`Zły czas ruchu „${v}”. Podaj czas_ms od ${MIN_MOVE_MS} do ${MAX_MOVE_MS}.`);
  return Math.max(MIN_MOVE_MS, Math.min(MAX_MOVE_MS, n));
}

/** Jeden ruch: wysyłamy polecenie i czekamy, aż się skończy — dopiero wtedy narzędzie wraca (kolejne polecenie nie przerwie poprzedniego). */
async function move(dir, ms) {
  const r = await robot("POST", "/api/move", { direction: dir, duration_ms: ms });
  const real = Number(r.duration_ms) || ms;
  await sleep(real + 30);
  return real;
}

// ───────────────────────── tools ─────────────────────────
const text = (t, structured) => ({ content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) });
const dirSchema = { type: "string", enum: Object.keys(DIRS), description: "przod = jazda do przodu · tyl = jazda do tyłu · lewo / prawo = obrót w miejscu (gąsienicowo: koła kręcą się w przeciwne strony)" };
const msSchema = { type: "integer", minimum: MIN_MOVE_MS, maximum: MAX_MOVE_MS, description: `Ile milisekund ma trwać ruch (${MIN_MOVE_MS}–${MAX_MOVE_MS}). Robot sam się zatrzymuje po tym czasie.` };

const tools = [
  {
    name: "jedz",
    title: "Jedź",
    description: `Jeden ruch robota: jazda do przodu / do tyłu albo obrót w miejscu, przez podany czas (najwyżej ${MAX_MOVE_MS} ms). Wraca, gdy robot już stoi. Na dłuższą trasę użyj narzędzia sekwencja.`,
    inputSchema: { type: "object", properties: { kierunek: dirSchema, czas_ms: msSchema }, required: ["kierunek", "czas_ms"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async ({ kierunek, czas_ms }) => {
      const dir = direction(kierunek), ms = duration(czas_ms);
      const real = await move(dir, ms);
      return text(`🚗 ${DIR_PL[dir]} przez ${real} ms — zrobione, robot stoi.`, { ruchy: [{ kierunek: dir, czas_ms: real }] });
    },
  },
  {
    name: "sekwencja",
    title: "Sekwencja ruchów",
    description: `Kilka ruchów po kolei (najwyżej ${MAX_SEQUENCE}), np. przód, obrót, przód. Każdy ruch jak w narzędziu jedz. Przy pierwszym błędzie robot dostaje stop, a wynik mówi, ile ruchów się udało.`,
    inputSchema: {
      type: "object",
      properties: { ruchy: { type: "array", minItems: 1, maxItems: MAX_SEQUENCE, items: { type: "object", properties: { kierunek: dirSchema, czas_ms: msSchema }, required: ["kierunek", "czas_ms"] }, description: "Lista ruchów w kolejności wykonania" } },
      required: ["ruchy"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async ({ ruchy }) => {
      if (!Array.isArray(ruchy) || !ruchy.length) throw new RobotError("Podaj listę ruchów: [{kierunek, czas_ms}, …].");
      if (ruchy.length > MAX_SEQUENCE) throw new RobotError(`Za długa sekwencja (${ruchy.length}). Najwyżej ${MAX_SEQUENCE} ruchów naraz.`);
      // najpierw cała walidacja — żeby robot nie ruszył w połowie błędnej listy
      const plan = ruchy.map((r, i) => {
        try { return { dir: direction(r?.kierunek), ms: duration(r?.czas_ms) }; }
        catch (e) { throw new RobotError(`Ruch ${i + 1}: ${e.message}`); }
      });
      const done = [];
      for (const [i, p] of plan.entries()) {
        try {
          done.push({ kierunek: p.dir, czas_ms: await move(p.dir, p.ms) });
        } catch (e) {
          await robot("POST", "/api/stop").catch(() => {});
          throw new RobotError(`Sekwencja przerwana na ruchu ${i + 1} z ${plan.length} (wykonane: ${done.length}). ${e.message}`);
        }
        if (i < plan.length - 1) await sleep(GAP_MS);
      }
      return text(`🚗 sekwencja ${done.length} ruchów zrobiona, robot stoi:\n${done.map((d, i) => `${i + 1}. ${DIR_PL[d.kierunek]} ${d.czas_ms} ms`).join("\n")}`, { ruchy: done });
    },
  },
  {
    name: "stop",
    title: "Stop",
    description: "Natychmiast zatrzymuje silniki. Bezpieczne w każdej chwili.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async () => {
      await robot("POST", "/api/stop");
      return text("🛑 robot zatrzymany.");
    },
  },
  {
    name: "status",
    title: "Status robota",
    description: "Czy robot jest włączony i osiągalny, czy właśnie jedzie, jego adres IP. Wywołaj najpierw, gdy nie wiesz, czy robot działa.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { online: { type: "boolean" }, jedzie: { type: "boolean" }, wifi: { type: "boolean" }, ip: { type: "string" }, token: { type: "boolean" } }, required: ["online"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => {
      const s = await status();
      const out = { online: true, jedzie: !!s.moving, wifi: !!s.wifi, ip: String(s.ip ?? ""), token: !!ROBOT_TOKEN };
      return text(`🚗 robot online (${out.ip || ROBOT_URL}) · ${out.jedzie ? "JEDZIE" : "stoi"}${out.token ? "" : " · UWAGA: brak ROBOT_TOKEN, ruch nie zadziała"}`, out);
    },
  },
];

// ───────────────────────── resources ─────────────────────────
const MANUAL = `# Robot Simbota — jak nim jeździć

Dwukołowe podwozie (2WD) na ESP32 i mostku L298N. Silniki są włączane na pełną moc na zadany czas — robot nie ma czujników,
więc nie wie, ile przejechał ani o ile się obrócił. Sterujesz CZASEM, nie odległością.

- \`przod\` / \`tyl\` — oba koła w tę samą stronę.
- \`lewo\` / \`prawo\` — obrót w miejscu (koła w przeciwne strony).
- Jeden ruch trwa najwyżej ${MAX_MOVE_MS} ms; firmware sam zatrzymuje silniki.
- Dłuższa trasa: narzędzie \`sekwencja\` (do ${MAX_SEQUENCE} ruchów).

## Dobre nawyki

- Zacznij od \`status\`. Jeśli robot nie odpowiada, powiedz o tym userowi — nie ponawiaj w kółko.
- Pierwsze ruchy rób krótkie (200–400 ms), żeby zobaczyć, jak daleko robot jedzie na tej podłodze i baterii.
- Nie wiesz, ile ms to 90° ani 10 cm — to zależy od podłoża i baterii. Zapytaj usera albo zrób próbę i poproś, żeby powiedział, co widział.
- Robot jeździ po prawdziwym pokoju: nie widzisz przeszkód ani krawędzi stołu. Przy wątpliwościach pytaj.
- \`stop\` działa zawsze i od razu.
`;
const resources = [{ uri: "robot://instrukcja", name: "instrukcja", title: "Jak jeździć robotem", description: "Co robot potrafi, czym się steruje i dobre nawyki (markdown).", mimeType: "text/markdown" }];

// ───────────────────────── JSON-RPC ─────────────────────────
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && ("result" in msg || "error" in msg)) return null;
    return err(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notyfikacja
  switch (method) {
    case "initialize":
      log(ts(), C.green(`👋 ${params.clientInfo?.name ?? "klient"} podłączony · robot: ${C.bold(ROBOT_URL)} · token: ${ROBOT_TOKEN ? "jest" : C.red("BRAK")}`));
      return ok(id, {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER,
        instructions: `Prawdziwy jeżdżący robot (2WD). Sterujesz czasem ruchu w milisekundach, nie odległością: robot nie ma czujników. Zacznij od status, pierwsze ruchy rób krótkie (200–400 ms). Jeden ruch to najwyżej ${MAX_MOVE_MS} ms; dłuższa trasa = sekwencja. lewo/prawo to obrót w miejscu. stop działa zawsze.`,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return err(id, -32602, `Nie ma takiego narzędzia: ${params.name}`);
      log(ts(), C.cyan(`➡️  ${tool.name}`), C.gray(JSON.stringify(params.arguments ?? {}).slice(0, 200)));
      try {
        const result = await tool.run(params.arguments ?? {});
        log(ts(), C.green(`✅ ${tool.name}`), C.yellow(result.content[0].text.split("\n")[0]));
        return ok(id, result);
      } catch (e) {
        log(ts(), C.red(`💥 ${tool.name}: ${e.message}`));
        // błąd robota to wynik narzędzia (isError), nie błąd protokołu — sim dostaje treść i może zareagować
        return ok(id, { content: [{ type: "text", text: e instanceof RobotError ? e.message : `Błąd serwera robota: ${e.message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok(id, { resources });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "resources/read":
      return params.uri === "robot://instrukcja" ? ok(id, { contents: [{ uri: params.uri, mimeType: "text/markdown", text: MANUAL }] }) : err(id, -32002, `Resource not found: ${params.uri}`);
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

/** Ruchy idą po kolei: dwa wywołania naraz nie mogą się nakładać (drugie przerwałoby pierwsze w połowie). */
let queue = Promise.resolve();
const handleAny = (payload) => {
  const run = async () => {
    if (Array.isArray(payload)) {
      const out = [];
      for (const m of payload) { const r = await handle(m); if (r) out.push(r); }
      return out.length ? out : null;
    }
    return handle(payload);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
};

// ───────────────────────── transporty ─────────────────────────
log(`\n${C.yellow("  🚗 R O B O T - M C P")}  ${C.gray(`→ ${ROBOT_URL}${ROBOT_TOKEN ? "" : "  (bez tokenu: tylko status)"}`)}\n`);
const httpIdx = process.argv.indexOf("--http");

if (httpIdx === -1) {
  log(ts(), C.gray("tryb: stdio — czekam na JSON-RPC na stdin…"));
  const rl = readline.createInterface({ input: process.stdin });
  let pending = 0, closed = false;
  const maybeExit = () => { if (closed && !pending) process.exit(0); };
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify(err(null, -32700, "Parse error")) + "\n"); return; }
    pending++;
    try {
      const res = await handleAny(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } finally {
      pending--;
      maybeExit();
    }
  });
  // stdin zamknięty w trakcie ruchu: najpierw kończymy to, co w toku (robot i tak sam staje po czasie)
  rl.on("close", () => { closed = true; maybeExit(); });
} else {
  const port = Number(process.argv[httpIdx + 1]) || 3334;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/mcp") { res.writeHead(404).end("tylko /mcp"); return; }
    if (req.method === "GET") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(err(null, -32700, "Parse error"))); return; }
      const result = await handleAny(msg);
      const headers = { "Content-Type": "application/json" };
      if (!Array.isArray(msg) && msg?.method === "initialize") headers["Mcp-Session-Id"] = "robot-" + Math.random().toString(36).slice(2, 10);
      if (!result) { res.writeHead(202).end(); return; }
      res.writeHead(200, headers).end(JSON.stringify(result));
    });
  });
  // tylko localhost: serwer trzyma token robota i steruje fizycznym urządzeniem
  server.listen(port, "127.0.0.1", () => log(ts(), C.green(`🌐 nasłuchuję: ${C.bold(`http://localhost:${port}/mcp`)}`)));
}
