#!/usr/bin/env node
// 🦆 KWAK-MCP — najgłupszy testowy serwer MCP na świecie. Zero zależności.
//
//   node kwak-mcp.mjs              → stdio (simbot odpala go jako subprocess)
//   node kwak-mcp.mjs --http 3333  → Streamable HTTP na http://localhost:3333/mcp
//
// Protokół idzie po stdout (stdio) albo HTTP. Kolorowe logi lecą ZAWSZE na stderr,
// więc w trybie --http masz w terminalu pełne kino z tego, co robi twój bot.

import http from "node:http";
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER = { name: "kwak-mcp", title: "🦆 Kwak MCP", version: "0.0.1-kwak" };

// ───────────────────────── kolorki ─────────────────────────
const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const C = { red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36), gray: c(90), bold: c(1) };
const RAINBOW = [31, 33, 32, 36, 34, 35];
const rainbow = (s) => [...s].map((ch, i) => `\x1b[${RAINBOW[i % RAINBOW.length]}m${ch}`).join("") + "\x1b[0m";
const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const ts = () => C.gray(new Date().toLocaleTimeString("pl-PL"));

const BANNER = `
${C.yellow("        __")}
${C.yellow("    ___( o)>")}   ${rainbow("K W A K - M C P")}
${C.yellow("    \\ <_. )")}    ${C.gray("testowy serwer MCP, który nic nie robi, ale robi to z klasą")}
${C.cyan("~~~~~")}${C.yellow("`---'")}${C.cyan("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~")}
`;

// ───────────────────────── stan stawu ─────────────────────────
const pond = { ducks: ["Zenek", "Grażyna"], breadCrumbs: 7, quacks: 0 };

// ───────────────────────── tools ─────────────────────────
const MADROSCI = [
  "Kaczka, która nie kwacze, to tylko gęś z kompleksami.",
  "Nie ma bugów. Są nieudokumentowane ficzery stawu.",
  "Kto rano wstaje, temu pan Zenek chleb daje.",
  "Działa u mnie na stawie.",
  "Najpierw kwak, potem deploy.",
  "Każdy LLM to w głębi duszy kaczka gumowa, która odpowiada.",
];

const tools = [
  {
    name: "kwaknij",
    title: "Kwaknij",
    description: "Kaczka powtarza podany tekst w dymku ASCII. Najprostszy test: czy umiesz przekazać argument.",
    inputSchema: {
      type: "object",
      properties: {
        tekst: { type: "string", description: "Co ma powiedzieć kaczka" },
        glosnosc: { type: "integer", minimum: 1, maximum: 5, description: "Ile razy 'KWAK' na końcu (1-5)", default: 1 },
      },
      required: ["tekst"],
    },
    run: ({ tekst, glosnosc = 1 }) => {
      if (typeof tekst !== "string") throw new KwakError("Parametr 'tekst' musi być stringiem, kolego.");
      const n = Math.max(1, Math.min(5, Number(glosnosc) || 1));
      pond.quacks += n;
      const line = `${tekst} ${"KWAK! ".repeat(n).trim()}`;
      const bar = "─".repeat(line.length + 2);
      return text(` ┌${bar}┐\n │ ${line} │\n └${bar}┘\n    \\\n     \\   __\n      ___( o)>\n      \\ <_. )\n       \`---'`);
    },
  },
  {
    name: "rzuc_kostka",
    title: "Rzuć kostką",
    description: "Rzuca kostkami. Test liczb i opcjonalnych parametrów. Zwraca też structuredContent.",
    inputSchema: {
      type: "object",
      properties: {
        ile: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Liczba kostek" },
        scianki: { type: "integer", minimum: 2, maximum: 100, default: 6, description: "Liczba ścianek" },
      },
    },
    outputSchema: {
      type: "object",
      properties: { rzuty: { type: "array", items: { type: "integer" } }, suma: { type: "integer" } },
      required: ["rzuty", "suma"],
    },
    run: ({ ile = 1, scianki = 6 }) => {
      const rzuty = Array.from({ length: Math.min(10, Math.max(1, ile)) }, () => 1 + Math.floor(Math.random() * scianki));
      const suma = rzuty.reduce((a, b) => a + b, 0);
      return { content: [{ type: "text", text: `🎲 ${rzuty.join(" + ")} = ${suma}` }], structuredContent: { rzuty, suma } };
    },
  },
  {
    name: "madrosc_kaczki",
    title: "Mądrość kaczki",
    description: "Losowa kacza mądrość życiowa. Test toola bez żadnych argumentów.",
    inputSchema: { type: "object", properties: {} },
    run: () => text(`🦆💬 "${MADROSCI[Math.floor(Math.random() * MADROSCI.length)]}"`),
  },
  {
    name: "nakarm_kaczki",
    title: "Nakarm kaczki",
    description: "Rzuca okruszki do stawu. Zmienia stan (zobaczysz to w zasobie kwak://staw). Test efektów ubocznych.",
    inputSchema: {
      type: "object",
      properties: { okruszki: { type: "integer", minimum: 1, maximum: 50, description: "Ile okruszków" } },
      required: ["okruszki"],
    },
    run: ({ okruszki }) => {
      pond.breadCrumbs += okruszki;
      if (pond.breadCrumbs > 30 && !pond.ducks.includes("Mirek")) {
        pond.ducks.push("Mirek");
        return text(`🍞 x${okruszki}. Zwabiłeś nową kaczkę: Mirek! Na stawie jest teraz ${pond.breadCrumbs} okruszków.`);
      }
      return text(`🍞 x${okruszki}. Kaczki zadowolone. Na stawie: ${pond.breadCrumbs} okruszków.`);
    },
  },
  {
    name: "wkurz_kaczke",
    title: "Wkurz kaczkę",
    description: "ZAWSZE zwraca błąd (isError: true). Test, czy twój agent ogarnia błędy narzędzi i nie panikuje.",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      throw new KwakError("🦆💢 KWAAAAK! Kaczka się wkurzyła i dziobnęła cię w kostkę. (to jest zamierzony błąd testowy)");
    },
  },
];

class KwakError extends Error {}
const text = (t) => ({ content: [{ type: "text", text: t }] });

// ───────────────────────── resources ─────────────────────────
const resources = [
  { uri: "kwak://staw", name: "staw", title: "Stan stawu", description: "Aktualny stan stawu (JSON). Zmienia się po nakarm_kaczki.", mimeType: "application/json" },
  { uri: "kwak://regulamin", name: "regulamin", title: "Regulamin stawu", description: "Regulamin stawu (markdown).", mimeType: "text/markdown" },
];
const readResource = (uri) => {
  if (uri === "kwak://staw") return JSON.stringify(pond, null, 2);
  if (uri === "kwak://regulamin")
    return "# Regulamin stawu\n\n1. Nie karmimy kaczek chlebem tostowym. Tylko rzemieślniczym.\n2. Kwakanie po 22:00 tylko szeptem.\n3. Grażyna ma zawsze rację.\n4. Kto zobaczy Mirka, ten ma szczęście przez cały sprint.\n";
  return null;
};

// ───────────────────────── prompts ─────────────────────────
const prompts = [
  {
    name: "kaczy_debugging",
    title: "Kaczy debugging",
    description: "Rubber duck debugging: opisz problem, kaczka słucha.",
    arguments: [{ name: "problem", description: "Co nie działa", required: true }],
  },
];
const getPrompt = (name, args = {}) => {
  if (name !== "kaczy_debugging") return null;
  return {
    description: "Rubber duck debugging",
    messages: [{ role: "user", content: { type: "text", text: `Jesteś gumową kaczką do debugowania. Słuchasz uważnie i zadajesz JEDNO pytanie naprowadzające, kończąc je słowem "kwak?". Problem: ${args.problem ?? "(brak)"}` } }],
  };
};

// ───────────────────────── JSON-RPC ─────────────────────────
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // odpowiedź od klienta (np. na nasz request) albo śmieć
    if (msg && ("result" in msg || "error" in msg)) return null;
    log(ts(), C.red("✗ zły JSON-RPC:"), C.gray(JSON.stringify(msg)));
    return err(msg?.id ?? null, -32600, "Invalid Request — kaczka nie rozumie");
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;

  if (isNotification) {
    log(ts(), C.magenta("📨 notyfikacja"), C.bold(method));
    if (method === "notifications/initialized") log(ts(), rainbow("🎉 Klient się przywitał! Handshake zakończony. Kwak kwak."));
    return null;
  }

  log(ts(), C.cyan("➡️  " + method), C.gray(JSON.stringify(params).slice(0, 160)));

  switch (method) {
    case "initialize": {
      const ci = params.clientInfo ?? {};
      log(ts(), C.green(`👋 Witaj ${C.bold(ci.name ?? "?")} v${ci.version ?? "?"} (protokół ${params.protocolVersion ?? "?"})`));
      return ok(id, {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER,
        instructions: "To jest testowy serwer-kaczka. Zacznij od narzędzia 'kwaknij'. Narzędzie 'wkurz_kaczke' zawsze zwraca błąd — to celowe.",
      });
    }
    case "ping":
      log(ts(), C.yellow("🏓 pong"));
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        log(ts(), C.red(`❓ nieznany tool: ${params.name}`));
        return err(id, -32602, `Nie ma takiego narzędzia: ${params.name}. Kaczka jest zdezorientowana.`);
      }
      try {
        const result = tool.run(params.arguments ?? {});
        log(ts(), C.green(`✅ ${tool.name}`), "\n" + C.yellow(result.content[0].text));
        return ok(id, result);
      } catch (e) {
        log(ts(), C.red(`💥 ${tool.name}: ${e.message}`));
        return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    case "resources/list":
      return ok(id, { resources });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "resources/read": {
      const r = resources.find((x) => x.uri === params.uri);
      const body = readResource(params.uri);
      if (!r || body == null) return err(id, -32002, `Resource not found: ${params.uri}`);
      log(ts(), C.blue(`📖 czyta ${params.uri}`));
      return ok(id, { contents: [{ uri: r.uri, mimeType: r.mimeType, text: body }] });
    }
    case "prompts/list":
      return ok(id, { prompts });
    case "prompts/get": {
      const p = getPrompt(params.name, params.arguments);
      return p ? ok(id, p) : err(id, -32602, `Nie ma promptu: ${params.name}`);
    }
    default:
      log(ts(), C.red(`🤷 nieznana metoda: ${method}`));
      return err(id, -32601, `Method not found: ${method}`);
  }
}

const handleAny = (payload) => {
  if (Array.isArray(payload)) {
    const out = payload.map(handle).filter(Boolean);
    return out.length ? out : null;
  }
  return handle(payload);
};

// ───────────────────────── transporty ─────────────────────────
log(BANNER);
const httpIdx = process.argv.indexOf("--http");

if (httpIdx === -1) {
  // STDIO: jedna wiadomość JSON na linię
  log(ts(), C.gray("tryb: stdio — czekam na JSON-RPC na stdin…"));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify(err(null, -32700, "Parse error — to nie JSON, to kaczy bełkot")) + "\n"); return; }
    const res = handleAny(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
  rl.on("close", () => { log(ts(), C.gray("stdin zamknięty — kaczka odlatuje 🦆✈️")); process.exit(0); });
} else {
  // Streamable HTTP (wersja minimalna: POST → JSON, bez SSE)
  const port = Number(process.argv[httpIdx + 1]) || 3333;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/mcp") { res.writeHead(404).end("🦆 tylko /mcp"); return; }
    if (req.method === "GET") { res.writeHead(405, { Allow: "POST" }).end(); return; } // brak SSE, zgodnie ze specą
    if (req.method === "DELETE") { log(ts(), C.gray("👋 klient zamknął sesję")); res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(err(null, -32700, "Parse error"))); return; }
      const result = handleAny(msg);
      const headers = { "Content-Type": "application/json" };
      if (!Array.isArray(msg) && msg?.method === "initialize") headers["Mcp-Session-Id"] = "kwak-" + Math.random().toString(36).slice(2, 10);
      if (!result) { res.writeHead(202).end(); return; }
      res.writeHead(200, headers).end(JSON.stringify(result));
    });
  });
  server.listen(port, () => log(ts(), C.green(`🌊 staw otwarty: ${C.bold(`http://localhost:${port}/mcp`)}`)));
}
