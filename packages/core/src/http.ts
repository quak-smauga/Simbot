// HTTP — mini router na node:http. Bez frameworka: jeden plik, zero magii. Używany przez agent i chat.
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

export type Req = IncomingMessage & { params: Record<string, string>; query: URLSearchParams; url: string };
export type Handler = (req: Req, res: ServerResponse) => void | Promise<void>;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

export function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, maxBytes = 2_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > maxBytes) throw new Error("body za duże");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return (s ? JSON.parse(s) : {}) as T;
}

export function serveStatic(root: string, res: ServerResponse, path: string, cache = "no-cache") {
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, safe);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  let st;
  try {
    st = statSync(file);
  } catch {
    return void res.writeHead(404, { "content-type": "text/plain" }).end("404");
  }
  if (!st.isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": st.size, "cache-control": cache });
  createReadStream(file).pipe(res);
}

/** SSE: zwraca send(); heartbeat co 15 s, żeby proxy i uśpione karty nie zrywały cichego agenta. */
export function sse(req: IncomingMessage, res: ServerResponse): { send(id: number | string, data: unknown): void; onClose(fn: () => void): void } {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
  res.write(": connected\n\n");
  const hb = setInterval(() => res.write(": ping\n\n"), 15000);
  const closers: (() => void)[] = [];
  req.on("close", () => {
    clearInterval(hb);
    closers.forEach((f) => f());
  });
  return { send: (id, data) => void res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`), onClose: (fn) => void closers.push(fn) };
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  private fallback: Handler = (_r, res) => void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));

  add(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }
  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  put = (p: string, h: Handler) => this.add("PUT", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);
  notFound(h: Handler) {
    this.fallback = h;
    return this;
  }

  handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const r = req as Req;
    r.query = url.searchParams;
    r.params = {};
    if (req.method === "OPTIONS") return void res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE", "access-control-allow-headers": "content-type" }).end();
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = match(route.parts, parts);
      if (!params) continue;
      r.params = params;
      try {
        await route.handler(r, res);
      } catch (e) {
        if (!res.headersSent) json(res, { error: (e as Error).message }, 500);
        else res.end();
      }
      return;
    }
    await this.fallback(r, res);
  };

  listen(port: number, host: string): Server {
    const srv = createServer((req, res) => void this.handle(req, res));
    srv.listen(port, host);
    return srv;
  }
}

function match(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern[pattern.length - 1] === "*") {
    if (parts.length < pattern.length - 1) return null;
  } else if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === "*") {
      params["*"] = parts.slice(i).join("/");
      return params;
    }
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
    else if (p !== parts[i]) return null;
  }
  return params;
}
