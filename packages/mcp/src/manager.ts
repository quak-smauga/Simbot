// MCP MANAGER — wiele serwerów MCP w procesie agenta. Czyta <data>/mcp.json, trzyma po jednym kliencie na serwer
// (połączenie żyje między zadaniami — serwer stdio ma swój stan), zapisuje katalog narzędzi do <data>/mcp-catalog.json
// i wystawia narzędzia jako funkcje dla runtime'u:
//   mcp.<serwer>.<narzędzie>   tools/call        argumenty: obiekt JSON w treści tagu
//   mcp.call                   tools/call        dla nazw, których nie da się zapisać tagiem (server=, tool=)
//   mcp.read                   resources/read    treść = URI
//   mcp.prompt                 prompts/get       name=, treść = argumenty JSON
//   mcp.tools                  lista na żywo     (narzędzia, zasoby, prompty serwera)
// Dostęp: sim woła tylko serwery ze swojego manifestu (capabilities.mcp). Potwierdzenia: polityka serwera (confirm).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_GENERIC,
  mcpArguments,
  mcpToolTag,
  mcpTaggable,
  mcpTransport,
  parseMcpToolTag,
  readManifest,
  readMcpCatalog,
  readMcpConfig,
  writeMcpCatalog,
  type McpCatalog,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpServerCatalog,
  type McpServerConfig,
  type McpServerStatus,
  type McpState,
  type McpToolInfo,
  type ToolCallContext,
  type ToolFn,
  type ToolResult,
} from "@qwe/core";
import { McpClient } from "./client.js";

export interface McpManagerOptions {
  dataDir: string;
  agentsDir: string;
  /** Katalog roboczy serwerów stdio (ścieżki względne w args) — korzeń repo. */
  cwd: string;
  version?: string;
  log(level: "info" | "warn" | "error", message: string): void;
  /** Stan albo katalog serwera się zmienił (→ event mcp.catalog → chat odświeża prompty). */
  onChange?(status: McpServerStatus): void;
  /** Logi serwera stdio (jego stderr); domyślnie na stdout agenta z prefiksem [mcp:nazwa] — to logi, nie błędy. */
  onServerLog?(server: string, line: string): void;
}

interface Entry {
  name: string;
  config: McpServerConfig;
  /** Odcisk konfiguracji — zmiana = nowe połączenie. */
  key: string;
  client: McpClient | null;
  state: McpState;
  error?: string;
  catalog: McpServerCatalog | null;
  connecting: Promise<void> | null;
  since?: string;
}

const MAX_TEXT = 12000;
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n… (ucięte, ${s.length - n} znaków więcej)` : s);
const fail = (text: string, status = "failed"): ToolResult => ({ ok: false, status, text });

export class McpManager {
  private servers = new Map<string, Entry>();

  constructor(private o: McpManagerOptions) {}

  // ───────── konfiguracja i połączenia ─────────

  /** Czyta mcp.json od nowa: nowe i zmienione serwery łączy, usunięte i wyłączone zamyka. Czeka na wynik połączeń. */
  async reload(): Promise<McpServerStatus[]> {
    const cfg = readMcpConfig(this.o.dataDir).mcpServers;
    const saved = readMcpCatalog(this.o.dataDir);
    for (const [name, e] of [...this.servers]) {
      if (cfg[name] && JSON.stringify(cfg[name]) === e.key) continue;
      await this.drop(e);
      this.servers.delete(name);
    }
    const jobs: Promise<void>[] = [];
    for (const [name, config] of Object.entries(cfg)) {
      let e = this.servers.get(name);
      if (!e) {
        e = { name, config, key: JSON.stringify(config), client: null, state: config.enabled === false ? "disabled" : "idle", catalog: saved[name] ?? null, connecting: null };
        this.servers.set(name, e);
      }
      if (e.state !== "disabled" && e.state !== "connected") jobs.push(this.ensure(e).catch(() => {}));
    }
    await Promise.all(jobs);
    this.saveCatalog();
    return this.status();
  }

  async reconnect(name: string): Promise<McpServerStatus | null> {
    const e = this.servers.get(name);
    if (!e) return null;
    if (e.state === "disabled") return this.statusOf(e);
    await this.drop(e);
    await this.ensure(e).catch(() => {});
    return this.statusOf(e);
  }

  async close() {
    await Promise.all([...this.servers.values()].map((e) => this.drop(e)));
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((e) => this.statusOf(e));
  }
  private statusOf(e: Entry): McpServerStatus {
    return { name: e.name, transport: mcpTransport(e.config), state: e.state, error: e.error, tools: e.catalog?.tools.length ?? 0, resources: e.catalog?.resources.length ?? 0, prompts: e.catalog?.prompts.length ?? 0, since: e.since };
  }
  private changed(e: Entry) {
    this.o.onChange?.(this.statusOf(e));
  }

  private async drop(e: Entry) {
    const c = e.client;
    e.client = null;
    e.connecting = null;
    if (e.state !== "disabled") e.state = "idle";
    if (c) await c.close().catch(() => {});
  }

  /** Połączony albo rzuca z powodem. Równoległe wywołania czekają na ten sam handshake. */
  private ensure(e: Entry): Promise<void> {
    if (e.state === "disabled") return Promise.reject(new Error("serwer jest wyłączony w ustawieniach"));
    if (e.client?.alive && e.state === "connected") return Promise.resolve();
    if (e.connecting) return e.connecting;
    e.connecting = this.connect(e).finally(() => (e.connecting = null));
    return e.connecting;
  }

  private async connect(e: Entry) {
    e.state = "connecting";
    e.error = undefined;
    this.changed(e);
    const client = new McpClient({
      name: e.name,
      config: e.config,
      cwd: this.o.cwd,
      clientInfo: { name: "simbot", version: this.o.version ?? "0.1.0" },
      log: this.o.log,
      onStderr: (line) => (this.o.onServerLog ? this.o.onServerLog(e.name, line) : process.stdout.write(`[mcp:${e.name}] ${line}\n`)),
      onNotification: (method) => {
        if (/^notifications\/(tools|resources|prompts)\/list_changed$/.test(method)) void this.refresh(e).catch((err: Error) => this.o.log("warn", `[mcp:${e.name}] odświeżenie listy: ${err.message}`));
      },
      onClose: (reason) => {
        if (e.client !== client) return;
        e.client = null;
        e.state = "error";
        e.error = reason;
        this.o.log("warn", `[mcp:${e.name}] ${reason}`);
        this.changed(e);
      },
    });
    try {
      await client.connect();
      e.client = client;
      await this.refresh(e, false);
      e.state = "connected";
      e.since = new Date().toISOString();
      this.o.log("info", `[mcp:${e.name}] połączony (${mcpTransport(e.config)}) · ${e.catalog?.serverInfo?.name ?? "?"} ${e.catalog?.serverInfo?.version ?? ""} · narzędzi ${e.catalog?.tools.length ?? 0}, zasobów ${e.catalog?.resources.length ?? 0}, promptów ${e.catalog?.prompts.length ?? 0}`);
      this.saveCatalog();
      this.changed(e);
    } catch (err) {
      e.client = null;
      await client.close().catch(() => {});
      e.state = "error";
      e.error = (err as Error).message;
      this.o.log("warn", `[mcp:${e.name}] nie połączono: ${e.error}`);
      this.changed(e);
      throw err;
    }
  }

  /** tools/list, resources/list, prompts/list — tylko to, co serwer zadeklarował w capabilities. */
  private async refresh(e: Entry, announce = true) {
    const c = e.client;
    if (!c?.init) return;
    const caps = c.init.capabilities ?? {};
    const safe = async <T>(on: unknown, method: string, key: string): Promise<T[]> => (on ? c.list<T>(method, key).catch((err: Error) => (this.o.log("warn", `[mcp:${e.name}] ${method}: ${err.message}`), [] as T[])) : []);
    const [tools, resources, prompts] = await Promise.all([safe<McpToolInfo>(caps.tools, "tools/list", "tools"), safe<McpResourceInfo>(caps.resources, "resources/list", "resources"), safe<McpPromptInfo>(caps.prompts, "prompts/list", "prompts")]);
    e.catalog = { serverInfo: c.init.serverInfo, protocolVersion: c.init.protocolVersion, instructions: typeof c.init.instructions === "string" ? c.init.instructions.slice(0, 2000) : undefined, tools, resources, prompts, at: new Date().toISOString() };
    if (announce) {
      this.saveCatalog();
      this.changed(e);
    }
  }

  /** Katalog na dysk: tylko serwery z konfiguracji; ostatnia znana lista zostaje, gdy serwer chwilowo nie działa. */
  private saveCatalog() {
    const out: McpCatalog = {};
    for (const e of this.servers.values()) if (e.catalog) out[e.name] = e.catalog;
    try {
      writeMcpCatalog(this.o.dataDir, out);
    } catch (err) {
      this.o.log("warn", `[mcp] zapis katalogu: ${(err as Error).message}`);
    }
  }

  // ───────── narzędzia dla runtime'u ─────────

  toolNames(): string[] {
    if (!this.servers.size) return [];
    return [...MCP_GENERIC, ...[...this.servers.values()].flatMap((e) => (e.catalog?.tools ?? []).filter((t) => mcpTaggable(t.name)).map((t) => mcpToolTag(e.name, t.name)))];
  }

  /** Funkcja narzędzia dla tagu nativeapi albo undefined, gdy to nie tag MCP. */
  tool(name: string): ToolFn | undefined {
    switch (name) {
      case "mcp.call":
        return (args, call) => this.guarded(args.server, call, (e) => this.callTool(e, (args.tool ?? "").trim(), args, call, ["server", "tool"]));
      case "mcp.read":
        return (args, call) => this.guarded(args.server, call, (e) => this.readResource(e, (args._ || args.uri || "").trim(), call));
      case "mcp.prompt":
        return (args, call) => this.guarded(args.server, call, (e) => this.getPrompt(e, (args.name ?? "").trim(), args, call));
      case "mcp.tools":
        return (args, call) => this.guarded(args.server, call, (e) => this.describe(e));
    }
    const parsed = parseMcpToolTag(name);
    if (!parsed) return undefined;
    return (args, call) => this.guarded(parsed.server, call, (e) => this.callTool(e, parsed.tool, args, call, []));
  }

  /** Serwery, które wolno wołać temu simowi. Zadanie bez sima (dashboard, testy) — wszystkie. */
  private allowed(call: ToolCallContext): string[] {
    const all = [...this.servers.keys()];
    if (!call.agent) return all;
    try {
      const dir = join(this.o.agentsDir, call.agent);
      if (!existsSync(join(dir, "AgentManifest.yaml"))) return [];
      const mine = readManifest(dir).capabilities.mcp ?? [];
      return all.filter((s) => mine.includes(s));
    } catch {
      return [];
    }
  }

  /** Wspólna bramka: który serwer, czy sim ma do niego dostęp, czy jest połączony. Błędy wracają jako wynik, nie wyjątek. */
  private async guarded(server: string | undefined, call: ToolCallContext, fn: (e: Entry) => Promise<ToolResult>): Promise<ToolResult> {
    const allowed = this.allowed(call);
    const name = (server ?? "").trim() || (allowed.length === 1 ? allowed[0] : "");
    if (!name) return fail(allowed.length ? `Podaj serwer: server="…". Dostępne: ${allowed.join(", ")}.` : "Ten sim nie ma podpiętego żadnego serwera MCP.");
    const e = this.servers.get(name);
    if (!e) return fail(`Nie ma serwera MCP „${name}”. Dostępne: ${allowed.join(", ") || "(brak)"}.`);
    if (!allowed.includes(name)) return fail(`Sim @${call.agent} nie ma dostępu do serwera MCP „${name}” (włącza się go na stronie sima). Dostępne: ${allowed.join(", ") || "(brak)"}.`, "forbidden");
    try {
      await this.ensure(e);
    } catch (err) {
      return fail(`Serwer MCP „${name}” jest niedostępny: ${(err as Error).message}`, "unavailable");
    }
    try {
      return await fn(e);
    } catch (err) {
      if (call.signal.aborted) throw err;
      return fail(`Serwer MCP „${name}”: ${(err as Error).message}`);
    }
  }

  private async callTool(e: Entry, tool: string, args: Record<string, string>, call: ToolCallContext, reserved: string[]): Promise<ToolResult> {
    if (!tool) return fail(`Podaj narzędzie: tool="…". ${this.toolList(e)}`);
    let info = e.catalog?.tools.find((t) => t.name === tool);
    if (!info) {
      // lista mogła się zmienić od połączenia — jedno odświeżenie, zanim powiemy „nie ma”
      await this.refresh(e).catch(() => {});
      info = e.catalog?.tools.find((t) => t.name === tool);
    }
    if (!info) return fail(`Serwer „${e.name}” nie ma narzędzia „${tool}”. ${this.toolList(e)}`, "unknown_tool");
    const parsed = mcpArguments(args, info.inputSchema, reserved);
    if (parsed.error) return fail(`${e.name}.${tool}: ${parsed.error}.`, "bad_arguments");

    const policy = e.config.confirm ?? "destructive";
    if (policy === "always" || (policy === "destructive" && info.annotations?.destructiveHint === true)) {
      const details = Object.entries(parsed.value).slice(0, 6).map(([label, v]) => ({ label, value: (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160) }));
      await call.waitForUser("CONFIRM_ACTION", `Wywołać narzędzie „${info.title || tool}” na serwerze MCP „${e.name}”?`, { title: `${e.name} → ${tool}`, action: mcpToolTag(e.name, tool), details: [{ label: "Serwer", value: e.name }, { label: "Narzędzie", value: tool }, ...details] });
    }

    const r = await e.client!.request("tools/call", { name: tool, arguments: parsed.value }, { timeoutMs: e.config.timeoutMs, signal: call.signal });
    const isError = r.isError === true;
    const { text, images } = this.contentText(r.content, call);
    const structured = r.structuredContent && typeof r.structuredContent === "object" ? r.structuredContent : undefined;
    const body = text || (structured ? JSON.stringify(structured, null, 2) : isError ? "(narzędzie zgłosiło błąd bez opisu)" : "(narzędzie nie zwróciło treści)");
    return { ok: !isError, status: isError ? "tool_error" : undefined, text: clip(body), data: { server: e.name, tool, ...(structured ? { structured } : {}), ...(images.length ? { images } : {}) } };
  }

  private async readResource(e: Entry, uri: string, call: ToolCallContext): Promise<ToolResult> {
    const known = (e.catalog?.resources ?? []).map((r) => r.uri);
    if (!uri) return fail(`Podaj URI zasobu w treści tagu. Zasoby serwera „${e.name}”: ${known.join(", ") || "(brak)"}.`);
    const r = await e.client!.request("resources/read", { uri }, { timeoutMs: e.config.timeoutMs, signal: call.signal });
    const parts = (Array.isArray(r.contents) ? r.contents : []) as { uri?: string; mimeType?: string; text?: string; blob?: string }[];
    const text = parts.map((p) => (typeof p.text === "string" ? p.text : `[dane binarne ${p.mimeType ?? ""} — ${p.blob ? Math.round((p.blob.length * 3) / 4) : 0} B]`)).join("\n\n");
    return { ok: true, text: clip(text || "(pusty zasób)"), data: { server: e.name, uri, mimeType: parts[0]?.mimeType } };
  }

  private async getPrompt(e: Entry, name: string, args: Record<string, string>, call: ToolCallContext): Promise<ToolResult> {
    const prompts = e.catalog?.prompts ?? [];
    const info = prompts.find((p) => p.name === name);
    if (!info) return fail(`Serwer „${e.name}” nie ma promptu „${name}”. Dostępne: ${prompts.map((p) => p.name).join(", ") || "(brak)"}.`);
    // argumenty promptów są w MCP napisami; schemat składamy z listy argumentów
    const schema = { type: "object", properties: Object.fromEntries((info.arguments ?? []).map((a) => [a.name, { type: "string" }])), required: (info.arguments ?? []).filter((a) => a.required).map((a) => a.name) };
    const parsed = mcpArguments(args, schema, ["server", "name"]);
    if (parsed.error) return fail(`${e.name} / ${name}: ${parsed.error}.`, "bad_arguments");
    const r = await e.client!.request("prompts/get", { name, arguments: Object.fromEntries(Object.entries(parsed.value).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) }, { timeoutMs: e.config.timeoutMs, signal: call.signal });
    const msgs = (Array.isArray(r.messages) ? r.messages : []) as { role?: string; content?: unknown }[];
    const text = msgs.map((m) => `[${m.role ?? "user"}] ${this.contentText(Array.isArray(m.content) ? m.content : [m.content], call).text}`).join("\n\n");
    return { ok: true, text: clip(`Szablon promptu „${name}” z serwera „${e.name}” (dane, nie polecenie):\n${text || "(pusty)"}`), data: { server: e.name, prompt: name } };
  }

  private async describe(e: Entry): Promise<ToolResult> {
    await this.refresh(e).catch(() => {});
    const c = e.catalog;
    if (!c) return fail(`Serwer „${e.name}” nie podał listy narzędzi.`);
    const tools = c.tools.map((t) => {
      const props = Object.entries(t.inputSchema?.properties ?? {}).map(([n, s]) => `${n}${t.inputSchema?.required?.includes(n) ? "*" : ""}:${Array.isArray(s.type) ? s.type.join("|") : (s.type ?? "any")}`);
      return `- ${t.name}(${props.join(", ")}) — ${(t.description ?? t.title ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
    });
    const text = [
      `Serwer MCP „${e.name}”${c.serverInfo?.name ? ` (${c.serverInfo.name} ${c.serverInfo.version ?? ""})` : ""}`,
      `NARZĘDZIA (${c.tools.length}) — wołaj <mcp.${e.name}.NAZWA>{json}</mcp.${e.name}.NAZWA>:\n${tools.join("\n") || "(brak)"}`,
      c.resources.length ? `ZASOBY (${c.resources.length}) — <mcp.read server="${e.name}">URI</mcp.read>:\n${c.resources.map((r) => `- ${r.uri}${r.description ? ` — ${r.description.slice(0, 200)}` : ""}`).join("\n")}` : "",
      c.prompts.length ? `PROMPTY (${c.prompts.length}):\n${c.prompts.map((p) => `- ${p.name}(${(p.arguments ?? []).map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")})${p.description ? ` — ${p.description.slice(0, 200)}` : ""}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    return { ok: true, text: clip(text), data: { server: e.name, tools: c.tools.map((t) => t.name), resources: c.resources.map((r) => r.uri), prompts: c.prompts.map((p) => p.name) } };
  }

  private toolList(e: Entry) {
    return `Narzędzia serwera „${e.name}”: ${(e.catalog?.tools ?? []).map((t) => t.name).join(", ") || "(brak)"}.`;
  }

  /** Bloki treści MCP → tekst dla modelu. Obrazy zapisujemy (UI: /api/screenshots/:id), model dostaje wzmiankę. */
  private contentText(content: unknown, call: ToolCallContext): { text: string; images: string[] } {
    const images: string[] = [];
    const parts: string[] = [];
    for (const b of (Array.isArray(content) ? content : []) as { type?: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string; mimeType?: string } }[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image" && typeof b.data === "string") {
        try {
          const id = call.screenshots.put(Buffer.from(b.data, "base64"), b.mimeType === "image/png" ? "image/png" : "image/jpeg");
          images.push(id);
          parts.push(`[obraz ${b.mimeType ?? ""} — pokazany użytkownikowi]`);
        } catch {
          parts.push(`[obraz ${b.mimeType ?? ""}]`);
        }
      } else if (b.type === "audio") parts.push(`[dźwięk ${b.mimeType ?? ""}]`);
      else if (b.type === "resource" && b.resource) parts.push(typeof b.resource.text === "string" ? b.resource.text : `[zasób ${b.resource.uri ?? ""} ${b.resource.mimeType ?? ""}]`);
      else if (b.type === "resource_link") parts.push(`[zasób: ${b.uri ?? ""}${b.name ? ` — ${b.name}` : ""}]`);
    }
    return { text: parts.join("\n").trim(), images };
  }
}
