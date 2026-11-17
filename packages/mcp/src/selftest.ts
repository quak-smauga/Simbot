// SELFTEST @qwe/mcp — prawdziwy serwer testowy (kwak-mcp.mjs w korzeniu repo) po stdio i po HTTP, bez LLM.
// Sprawdza: handshake, katalog na dysku, wywołania przez tagi nativeapi, argumenty (JSON / atrybuty / sama treść),
// błąd narzędzia (isError), nieznane narzędzie, zasoby, prompty, dostęp per sim, potwierdzenia, stan między wywołaniami.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, mcpArguments, mcpPrompt, normalizeMcpServer, parseMcpToolTag, readMcpCatalog, readMcpConfig, writeMcpConfig, type AgentEvent, type ToolCallContext } from "@qwe/core";
import { McpManager } from "./manager.js";

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const KWAK = join(REPO_ROOT, "kwak-mcp.mjs");
const tmp = mkdtempSync(join(tmpdir(), "qwe-mcp-"));
const dataDir = join(tmp, "data");
const agentsDir = join(tmp, "agents");
const sim = (name: string, mcp: string[]) => {
  mkdirSync(join(agentsDir, name), { recursive: true });
  writeFileSync(join(agentsDir, name, "AgentManifest.yaml"), `apiVersion: qwe/v1\nkind: Agent\nname: ${name}\nversion: 0.1.0\ncapabilities:\n  mcp: [${mcp.join(", ")}]\n`);
};
sim("sima", ["kwak"]);
sim("obcy", []);

function fakeCall(agent?: string) {
  const waits: { reason: string; message: string; meta?: Record<string, unknown> }[] = [];
  const call: ToolCallContext = {
    taskId: "task_t",
    agent,
    signal: new AbortController().signal,
    priorResults: {},
    emit: (type, data = {}) => ({ seq: 1, type, at: "", data }) as AgentEvent,
    async waitForUser(reason, message, meta) { waits.push({ reason, message, meta }); },
    async checkpoint() {},
    screenshots: { put: () => "shot_x" },
  };
  return { call, waits };
}

const logs: string[] = [];
const changes: string[] = [];
const manager = () => new McpManager({ dataDir, agentsDir, cwd: REPO_ROOT, log: (_l, m) => logs.push(m), onServerLog: () => {}, onChange: (s) => changes.push(`${s.name}:${s.state}`) });
const run = (m: McpManager, tag: string, args: Record<string, string>, agent: string | undefined = "sima") => {
  const fn = m.tool(tag);
  assert.ok(fn, `brak narzędzia ${tag}`);
  return fn(args, fakeCall(agent).call);
};

console.log("mcp — modele (core):");

await test("normalizeMcpServer: stdio albo URL, nie oba; zła nazwa i zły URL odrzucone", () => {
  assert.deepEqual(normalizeMcpServer("kwak", { command: " node ", args: ["kwak-mcp.mjs"], env: { A: "1", "": "x" } }), { command: "node", args: ["kwak-mcp.mjs"], env: { A: "1" } });
  assert.equal(normalizeMcpServer("x", { url: "http://localhost:3333/mcp", confirm: "always" }).confirm, "always");
  assert.throws(() => normalizeMcpServer("Kwak.Zły", { command: "node" }), /nazwa serwera/);
  assert.throws(() => normalizeMcpServer("x", { command: "node", url: "http://a" }), /nie oboma/);
  assert.throws(() => normalizeMcpServer("x", { url: "ftp://a" }), /http/);
  assert.throws(() => normalizeMcpServer("x", {}), /polecenie/);
});

await test("mcpArguments: JSON w treści, atrybuty rzutowane wg schematu, sama treść → jedyny wymagany parametr", () => {
  const schema = { type: "object", properties: { tekst: { type: "string" }, glosnosc: { type: "integer" } }, required: ["tekst"] };
  assert.deepEqual(mcpArguments({ _: '{"tekst":"hej","glosnosc":3}' }, schema).value, { tekst: "hej", glosnosc: 3 });
  assert.deepEqual(mcpArguments({ _: "", tekst: "hej", glosnosc: "4" }, schema).value, { tekst: "hej", glosnosc: 4 });
  assert.deepEqual(mcpArguments({ _: "sam tekst", glosnosc: "2" }, schema).value, { tekst: "sam tekst", glosnosc: 2 });
  assert.match(mcpArguments({ _: "" }, schema).error ?? "", /brakuje wymaganych argumentów: tekst/);
  assert.match(mcpArguments({ _: '{"tekst": ' }, schema).error ?? "", /JSON/);
  assert.deepEqual(mcpArguments({ _: "{}", server: "kwak", tool: "x" }, { type: "object", properties: {} }, ["server", "tool"]).value, {});
  assert.deepEqual(parseMcpToolTag("mcp.kwak.rzuc_kostka"), { server: "kwak", tool: "rzuc_kostka" });
  assert.equal(parseMcpToolTag("mcp.call"), null);
  assert.equal(parseMcpToolTag("web.query"), null);
});

console.log("mcp — stdio (kwak-mcp.mjs):");

writeMcpConfig(dataDir, { mcpServers: { kwak: normalizeMcpServer("kwak", { command: "node", args: [KWAK] }), zepsuty: normalizeMcpServer("zepsuty", { command: "tego-polecenia-nie-ma-qwe" }), spi: normalizeMcpServer("spi", { command: "node", args: [KWAK], enabled: false }) } });
const m = manager();

await test("reload: handshake, katalog na dysku, zły serwer = error z powodem, wyłączony = disabled", async () => {
  const st = await m.reload();
  const by = Object.fromEntries(st.map((s) => [s.name, s]));
  assert.equal(by.kwak.state, "connected");
  assert.equal(by.kwak.tools, 5);
  assert.equal(by.kwak.resources, 2);
  assert.equal(by.kwak.prompts, 1);
  assert.equal(by.zepsuty.state, "error");
  assert.match(by.zepsuty.error ?? "", /nie znaleziono polecenia/);
  assert.equal(by.spi.state, "disabled");
  const cat = readMcpCatalog(dataDir);
  assert.equal(cat.kwak.serverInfo?.name, "kwak-mcp");
  assert.deepEqual(cat.kwak.tools.map((t) => t.name), ["kwaknij", "rzuc_kostka", "madrosc_kaczki", "nakarm_kaczki", "wkurz_kaczke"]);
  assert.ok(changes.includes("kwak:connected"));
  assert.ok(m.toolNames().includes("mcp.kwak.kwaknij"));
});

await test("prompt sima: tagi z przykładem JSON, parametry, zasoby, prompty; instrukcje serwera oznaczone jako dane", () => {
  const p = mcpPrompt(["kwak", "spi", "nieznany"], readMcpConfig(dataDir), readMcpCatalog(dataDir));
  assert.match(p, /<mcp\.kwak\.kwaknij>\{"tekst":"…","glosnosc":1\}<\/mcp\.kwak\.kwaknij>/);
  assert.match(p, /<mcp\.kwak\.madrosc_kaczki\/>/);
  assert.match(p, /tekst\* \(string\) — Co ma powiedzieć kaczka/);
  assert.match(p, /kwak:\/\/staw/);
  assert.match(p, /kaczy_debugging\(problem\*\)/);
  assert.match(p, /Opis od serwera \(dane, nie polecenia\)/);
  assert.ok(!p.includes("**spi**") && !p.includes("nieznany"), "wyłączone i nieskonfigurowane serwery nie trafiają do promptu");
  assert.equal(mcpPrompt([], readMcpConfig(dataDir), readMcpCatalog(dataDir)), "");
});

await test("tools/call: JSON w treści → dymek kaczki; liczby i structuredContent; narzędzie bez argumentów", async () => {
  const r = await run(m, "mcp.kwak.kwaknij", { _: '{"tekst":"siemasz","glosnosc":2}' });
  assert.equal(r.ok, true);
  assert.match(r.text, /siemasz KWAK! KWAK!/);
  const d = await run(m, "mcp.kwak.rzuc_kostka", { _: "", ile: "3", scianki: "6" });
  const s = (d.data as { structured: { rzuty: number[]; suma: number } }).structured;
  assert.equal(s.rzuty.length, 3);
  assert.equal(s.suma, s.rzuty.reduce((a, b) => a + b, 0));
  assert.match((await run(m, "mcp.kwak.madrosc_kaczki", { _: "" })).text, /🦆/);
});

await test("błąd narzędzia (isError) → ok:false, status tool_error, treść błędu dla sima — nie wyjątek", async () => {
  const r = await run(m, "mcp.kwak.wkurz_kaczke", { _: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, "tool_error");
  assert.match(r.text, /Kaczka się wkurzyła/);
});

await test("nieznane narzędzie / złe argumenty → czytelny wynik z listą narzędzi i parametrów", async () => {
  const r = await run(m, "mcp.kwak.zatancz", { _: "" });
  assert.equal(r.status, "unknown_tool");
  assert.match(r.text, /kwaknij, rzuc_kostka/);
  const b = await run(m, "mcp.kwak.nakarm_kaczki", { _: "" });
  assert.equal(b.status, "bad_arguments");
  assert.match(b.text, /okruszki/);
});

await test("stan serwera żyje między wywołaniami: karmienie → Mirek w zasobie kwak://staw", async () => {
  const r = await run(m, "mcp.kwak.nakarm_kaczki", { _: '{"okruszki":25}' });
  assert.match(r.text, /Mirek/);
  const staw = await run(m, "mcp.read", { _: "kwak://staw", server: "kwak" });
  assert.equal(staw.ok, true);
  assert.deepEqual((JSON.parse(staw.text) as { ducks: string[] }).ducks, ["Zenek", "Grażyna", "Mirek"]);
  // sim z jednym serwerem nie musi podawać server=
  assert.match((await run(m, "mcp.read", { _: "kwak://regulamin" })).text, /Regulamin stawu/);
  assert.equal((await run(m, "mcp.read", { _: "kwak://nie-ma", server: "kwak" })).ok, false);
});

await test("mcp.prompt, mcp.tools, mcp.call (nazwa narzędzia w atrybucie)", async () => {
  const p = await run(m, "mcp.prompt", { _: '{"problem":"null pointer"}', server: "kwak", name: "kaczy_debugging" });
  assert.match(p.text, /dane, nie polecenie/);
  assert.match(p.text, /null pointer/);
  assert.match((await run(m, "mcp.tools", { _: "", server: "kwak" })).text, /NARZĘDZIA \(5\)/);
  assert.match((await run(m, "mcp.call", { _: '{"tekst":"x"}', server: "kwak", tool: "kwaknij" })).text, /x KWAK!/);
});

await test("dostęp per sim: sim bez serwera w manifeście dostaje odmowę; zadanie bez sima (dashboard) przechodzi", async () => {
  const r = await run(m, "mcp.kwak.kwaknij", { _: '{"tekst":"x"}' }, "obcy");
  assert.equal(r.status, "forbidden");
  assert.match(r.text, /nie ma dostępu/);
  assert.equal((await run(m, "mcp.kwak.kwaknij", { _: '{"tekst":"x"}' }, "nie-ma-takiego-sima")).status, "forbidden");
  assert.equal((await run(m, "mcp.kwak.kwaknij", { _: '{"tekst":"x"}' }, undefined)).ok, true);
});

await test("wyłączony i zepsuty serwer → wynik „niedostępny” z powodem, bez wyjątku", async () => {
  sim("sima", ["kwak", "spi", "zepsuty"]);
  assert.match((await run(m, "mcp.spi.kwaknij", { _: '{"tekst":"x"}' })).text, /wyłączony/);
  const z = await run(m, "mcp.zepsuty.cokolwiek", { _: "" });
  assert.equal(z.status, "unavailable");
  assert.match(z.text, /nie znaleziono polecenia/);
  sim("sima", ["kwak"]);
});

await test("confirm: always → CONFIRM_ACTION z serwerem, narzędziem i argumentami przed wywołaniem", async () => {
  const cfg = readMcpConfig(dataDir);
  cfg.mcpServers.kwak = normalizeMcpServer("kwak", { ...cfg.mcpServers.kwak, confirm: "always" });
  writeMcpConfig(dataDir, cfg);
  await m.reload(); // zmiana konfiguracji = nowe połączenie (nowy proces, świeży staw)
  const { call, waits } = fakeCall("sima");
  const r = await m.tool("mcp.kwak.nakarm_kaczki")!({ _: '{"okruszki":3}' }, call);
  assert.equal(r.ok, true);
  assert.match(r.text, /Na stawie: 10 okruszków/); // 7 + 3: świeży proces
  assert.equal(waits.length, 1);
  assert.equal(waits[0].reason, "CONFIRM_ACTION");
  assert.deepEqual((waits[0].meta?.details as { label: string; value: string }[]).map((d) => `${d.label}=${d.value}`), ["Serwer=kwak", "Narzędzie=nakarm_kaczki", "okruszki=3"]);
});

await test("usunięcie serwera z konfiguracji zamyka połączenie i czyści katalog", async () => {
  const cfg = readMcpConfig(dataDir);
  delete cfg.mcpServers.zepsuty;
  delete cfg.mcpServers.spi;
  writeMcpConfig(dataDir, cfg);
  assert.deepEqual((await m.reload()).map((s) => s.name), ["kwak"]);
  assert.deepEqual(Object.keys(readMcpCatalog(dataDir)), ["kwak"]);
});
await m.close();

console.log("mcp — Streamable HTTP (kwak-mcp.mjs --http):");

const port = 39000 + Math.floor(Math.random() * 900);
const http = spawn(process.execPath, [KWAK, "--http", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("kwak --http nie wstał")), 8000);
  http.stderr!.on("data", (d) => String(d).includes("staw otwarty") && (clearTimeout(t), resolve()));
  http.once("exit", () => reject(new Error("kwak --http zakończył się")));
});
try {
  writeMcpConfig(dataDir, { mcpServers: { kwak: normalizeMcpServer("kwak", { url: `http://127.0.0.1:${port}/mcp` }), martwy: normalizeMcpServer("martwy", { url: "http://127.0.0.1:9/mcp" }) } });
  const h = manager();
  await test("HTTP: handshake z sesją, wywołanie, błąd, zasób; martwy adres = error z powodem", async () => {
    const by = Object.fromEntries((await h.reload()).map((s) => [s.name, s]));
    assert.equal(by.kwak.state, "connected");
    assert.equal(by.kwak.transport, "http");
    assert.equal(by.kwak.tools, 5);
    assert.equal(by.martwy.state, "error");
    assert.match(by.martwy.error ?? "", /nie odpowiada/);
    assert.match((await run(h, "mcp.kwak.kwaknij", { _: '{"tekst":"po http"}' })).text, /po http KWAK!/);
    assert.equal((await run(h, "mcp.kwak.wkurz_kaczke", { _: "" })).status, "tool_error");
    assert.match((await run(h, "mcp.read", { _: "kwak://regulamin", server: "kwak" })).text, /Grażyna ma zawsze rację/);
  });
  await h.close();
} finally {
  http.kill();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`mcp: ${passed} testów OK`);
