// MCP w chacie — konfiguracja serwerów (plik <data>/mcp.json) i ich stan dla UI. Chat NIE łączy się z serwerami:
// robi to agent (McpManager). Chat pisze konfigurację, prosi agenta o reload i czyta katalog narzędzi do promptów.
//   GET    /api/mcp                    serwery: konfiguracja (sekrety zamaskowane), stan, narzędzia, które simy mają dostęp
//   PUT    /api/mcp/:name              { config, sims? } — dodaj / zmień; łączy i zwraca stan
//   DELETE /api/mcp/:name              usuń (także z manifestów simów)
//   POST   /api/mcp/:name/reconnect    połącz od nowa
//
// Serwer stdio to POLECENIE uruchamiane na komputerze usera, więc te endpointy przyjmują tylko żądania z naszego UI
// (ten sam origin, host lokalny) — strona otwarta w przeglądarce nie może dopisać serwera przez fetch na 127.0.0.1.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  json,
  mcpTransport,
  normalizeMcpServer,
  readJson,
  readMcpCatalog,
  readMcpConfig,
  writeMcpConfig,
  type McpServerConfig,
  type McpServerStatus,
  type Router,
} from "@qwe/core";
import type { AgentLink } from "./agent-link.js";
import type { BotRegistry } from "./bots.js";

const MASK = "••••••";
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Żądanie z naszego UI: Host lokalny (DNS rebinding) i Origin — jeśli jest — ten sam co Host (CSRF z obcej strony). */
export function fromOwnUi(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOST.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // curl, Electron (ten sam origin przy GET), skrypty lokalne
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const mask = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.keys(m).map((k) => [k, MASK])) : undefined);
/** Wartość z UI: maska = „bez zmian” → bierzemy starą. */
const unmask = (next: Record<string, string> | undefined, prev: Record<string, string> | undefined) =>
  next ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === MASK ? (prev?.[k] ?? "") : v]).filter(([, v]) => v !== "")) : undefined;

export interface McpDeps {
  dataDir: string;
  bots: BotRegistry;
  link: AgentLink;
  log(level: "info" | "warn" | "error", message: string): void;
}

export function registerMcpRoutes(r: Router, d: McpDeps) {
  const deny = (req: IncomingMessage, res: ServerResponse) => {
    if (fromOwnUi(req)) return false;
    json(res, { error: "serwery MCP można zmieniać tylko z aplikacji simbot (lokalnie)" }, 403);
    return true;
  };

  /** Stan na żywo od agenta; null, gdy agent śpi (nie budzimy go samym otwarciem strony). */
  const live = async (): Promise<McpServerStatus[] | null> => {
    if (d.link.status !== "up") return null;
    try {
      const j = (await (await fetch(`${d.link.url}/api/mcp`, { signal: AbortSignal.timeout(2500) })).json()) as { servers?: McpServerStatus[] };
      return j.servers ?? null;
    } catch {
      return null;
    }
  };
  /** Po zmianie konfiguracji: obudź agenta i każ mu przeczytać plik; czeka na wynik połączeń. */
  const reload = async (): Promise<McpServerStatus[] | null> => {
    try {
      await d.link.ensure();
      const j = (await (await fetch(`${d.link.url}/api/mcp/reload`, { method: "POST", signal: AbortSignal.timeout(25000) })).json()) as { servers?: McpServerStatus[] };
      return j.servers ?? null;
    } catch (e) {
      d.log("warn", `[mcp] reload: ${(e as Error).message}`);
      return null;
    } finally {
      d.bots.invalidatePrompts();
    }
  };

  const view = (statuses: McpServerStatus[] | null) => {
    const cfg = readMcpConfig(d.dataDir).mcpServers;
    const cat = readMcpCatalog(d.dataDir);
    return Object.entries(cfg).map(([name, c]) => {
      const st = statuses?.find((s) => s.name === name);
      const k = cat[name];
      return {
        name,
        transport: mcpTransport(c),
        config: { ...c, env: mask(c.env), headers: mask(c.headers) },
        // agent śpi → „sleeping”: konfiguracja jest, połączy się przy pierwszym użyciu
        state: c.enabled === false ? "disabled" : (st?.state ?? "sleeping"),
        error: st?.error,
        serverInfo: k?.serverInfo ?? null,
        instructions: k?.instructions ?? "",
        tools: (k?.tools ?? []).map((t) => ({ name: t.name, title: t.title ?? "", description: t.description ?? "", destructive: t.annotations?.destructiveHint === true, params: Object.keys(t.inputSchema?.properties ?? {}), required: t.inputSchema?.required ?? [] })),
        resources: (k?.resources ?? []).map((x) => ({ uri: x.uri, description: x.description ?? x.title ?? "" })),
        prompts: (k?.prompts ?? []).map((p) => ({ name: p.name, description: p.description ?? "" })),
        checkedAt: k?.at ?? null,
        sims: d.bots.list().filter((s) => (s.manifest.capabilities.mcp ?? []).includes(name)).map((s) => s.manifest.name),
      };
    });
  };

  r.get("/api/mcp", async (q, res) => {
    if (deny(q, res)) return;
    json(res, { servers: view(await live()), agent: d.link.status });
  });

  r.put("/api/mcp/:name", async (q, res) => {
    if (deny(q, res)) return;
    const name = q.params.name.trim().toLowerCase();
    const body = await readJson<{ config?: McpServerConfig; sims?: string[] }>(q);
    try {
      const cfg = readMcpConfig(d.dataDir);
      const prev = cfg.mcpServers[name];
      const next = body.config ?? {};
      cfg.mcpServers[name] = normalizeMcpServer(name, { ...next, env: unmask(next.env, prev?.env), headers: unmask(next.headers, prev?.headers) });
      writeMcpConfig(d.dataDir, cfg);
      if (Array.isArray(body.sims)) d.bots.setMcpAccess(name, body.sims);
      const statuses = await reload();
      json(res, { server: view(statuses).find((s) => s.name === name), agent: d.link.status });
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
  });

  r.delete("/api/mcp/:name", async (q, res) => {
    if (deny(q, res)) return;
    const cfg = readMcpConfig(d.dataDir);
    if (!cfg.mcpServers[q.params.name]) return json(res, { error: "nieznany serwer MCP" }, 404);
    delete cfg.mcpServers[q.params.name];
    writeMcpConfig(d.dataDir, cfg);
    d.bots.setMcpAccess(q.params.name, []);
    // agent śpi → nie budzimy go po to, żeby coś zamknął; przeczyta plik przy starcie
    if (d.link.status === "up") await reload();
    else d.bots.invalidatePrompts();
    json(res, { ok: true });
  });

  r.post("/api/mcp/:name/reconnect", async (q, res) => {
    if (deny(q, res)) return;
    if (!readMcpConfig(d.dataDir).mcpServers[q.params.name]) return json(res, { error: "nieznany serwer MCP" }, 404);
    try {
      await d.link.ensure();
      await fetch(`${d.link.url}/api/mcp/${encodeURIComponent(q.params.name)}/reconnect`, { method: "POST", signal: AbortSignal.timeout(25000) });
    } catch (e) {
      d.log("warn", `[mcp] reconnect: ${(e as Error).message}`);
    }
    d.bots.invalidatePrompts();
    json(res, { server: view(await live()).find((s) => s.name === q.params.name), agent: d.link.status });
  });
}
