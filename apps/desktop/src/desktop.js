// DESKTOP BRIDGE — most agent ↔ qwe-helper (Swift). Helper uruchamia Electron, więc zgody macOS (Nagrywanie ekranu,
// Dostępność) należą do simbot. Agent (proces na hoście albo w Dockerze) woła most przez HTTP z tokenem:
//   POST /rpc {cmd, args} → {ok, result | error}        GET /health
// Most dokłada ustawienia, których agent nie zna: który ekran (aktywny albo wybrany), czego nie fotografować (tylko widget —
// okno główne simbot ZOSTAJE na zrzucie, bo zrzut musi zgadzać się z tym, co jest na wierzchu i co dostaje kliknięcia)
// i znacznik frontmost.self, gdy na wierzchu jest sam simbot.
// Adres i token: env QWE_DESKTOP_URL / QWE_DESKTOP_TOKEN (dla chatu → agenta, który startuje z Electrona)
// + plik <data>/desktop-bridge.json (gdy chat/agent wstały wcześniej, np. `qwe dev` w terminalu).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

export function createDesktopBridge({ helperPath, infoFile, getDisplay, excludeWindowIds, selfPid = process.pid, log }) {
  let child = null;
  let seq = 0;
  let buf = '';
  const pending = new Map();
  const token = randomBytes(24).toString('hex');
  let server = null;
  let url = null;

  function start() {
    if (child) return child;
    if (!existsSync(helperPath)) throw new Error(`brak helpera ${helperPath} — zbuduj: pnpm --filter @qwe/desktop helper`);
    child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.event) { if (m.event !== 'ready') log(`[desktop] helper: ${m.event}`); continue; }
        const p = pending.get(m.id); if (!p) continue;
        pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      }
    });
    child.stderr.on('data', d => log(`[desktop!] ${String(d).trimEnd()}`));
    child.on('exit', code => {
      log(`[desktop] helper zakończony (${code})`);
      child = null;
      for (const [, p] of pending) p.reject(new Error('helper padł'));
      pending.clear();
    });
    return child;
  }

  function call(cmd, args = {}, timeoutMs = 20000) {
    start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`helper: ${cmd} — brak odpowiedzi ${timeoutMs / 1000}s`)); }, timeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  /** Agent nie decyduje, który ekran ani czego nie widzieć — to ustawienia usera. */
  function withPolicy(cmd, args) {
    if (cmd !== 'observe') return args;
    const display = getDisplay();
    return { ...args, ...(display !== 'active' ? { display: Number(display) } : {}), excludeWindowIds: excludeWindowIds() };
  }
  /** Agent musi wiedzieć, że „aplikacja na wierzchu” to simbot (okno, z którego user zlecił zadanie), a nie cel zadania. */
  function markSelf(result) {
    for (const f of [result?.frontmost, result?.after]) if (f && typeof f === 'object' && f.pid === selfPid) f.self = true;
    return result;
  }

  async function listen() {
    server = createServer(async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return send(200, { ok: true });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'zły token' });
      if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { ok: false, error: 'nie ma' });
      let body = '';
      for await (const c of req) body += c;
      try {
        const { cmd, args } = JSON.parse(body || '{}');
        send(200, { ok: true, result: markSelf(await call(cmd, withPolicy(cmd, args || {}), cmd === 'openApp' ? 30000 : 20000)) });
      } catch (e) {
        send(200, { ok: false, error: e.message });
      }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
    process.env.QWE_DESKTOP_URL = url;
    process.env.QWE_DESKTOP_TOKEN = token;
    try { mkdirSync(dirname(infoFile), { recursive: true }); writeFileSync(infoFile, JSON.stringify({ url, token, pid: process.pid }), { mode: 0o600 }); } catch (e) { log(`[desktop] ${e.message}`); }
    log(`[desktop] most: ${url}`);
    return url;
  }

  function stop() {
    try { rmSync(infoFile, { force: true }); } catch {}
    server?.close();
    child?.kill();
  }

  return { listen, stop, call, get url() { return url; } };
}

/** Panele Ustawień systemowych dla zgód. */
export const PRIVACY_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
export const helperBinary = root => join(root, 'apps', 'desktop', 'helper', 'build', 'qwe-helper');
