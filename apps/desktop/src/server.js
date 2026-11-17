// SERVER — chat server qwe dla okien Electrona. Jeśli już działa (np. `qwe dev` w terminalu) — podpinamy się,
// inaczej startujemy go jako proces potomny (systemowy node + tsx na źródłach, jak `qwe dev`). Chat sam podnosi agenta.
// Quit Electrona = SIGTERM do chatu → chat kończy agenta (agent-link) → agent zamyka Chromium.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Czy pod adresem siedzi chat qwe (a nie coś innego na tym porcie)? */
export async function probe(base) {
  try {
    const r = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return 'other';
    const j = await r.json();
    return j && 'me' in j && 'bots' in j ? 'qwe' : 'other';
  } catch (e) {
    return e?.cause?.code === 'ECONNREFUSED' || e?.name === 'TimeoutError' ? 'free' : 'free';
  }
}

export async function ensureServer({ root, host, port, mock, log }) {
  const base = `http://${host}:${port}`;
  const found = await probe(base);
  if (found === 'qwe') {
    log(`[desktop] chat już działa → podpinam się: ${base}`);
    return { base, attached: true, stop: async () => {} };
  }
  if (found === 'other') throw new Error(`port ${port} zajęty przez coś innego niż qwe (ustaw QWE_CHAT_PORT w .env)`);

  const node = process.env.QWE_NODE || 'node';
  const dist = resolve(root, 'apps/chat/dist/index.js');
  const useDist = process.env.QWE_DESKTOP_DIST === '1' && existsSync(dist);
  const args = useDist
    ? ['--no-warnings=ExperimentalWarning', dist]
    : [resolve(root, 'node_modules/tsx/dist/cli.mjs'), '--conditions=development', resolve(root, 'apps/chat/src/index.ts')];
  if (mock) args.push('--mock');
  log(`[desktop] startuję chat: ${node} ${useDist ? 'dist' : 'tsx src'}${mock ? ' --mock' : ''}`);
  const child = spawn(node, args, { cwd: root, env: { ...process.env, QWE_CHAT_PORT: String(port), QWE_HOST: host }, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null;
  child.stdout.on('data', d => process.stdout.write(`  [chat] ${String(d).trimEnd()}\n`));
  child.stderr.on('data', d => process.stderr.write(`  [chat!] ${String(d).trimEnd()}\n`));
  child.on('exit', code => { exited = code ?? 1; log(`[desktop] chat zakończony (${exited})`); });
  child.on('error', e => { exited = 1; log(`[desktop] nie da się uruchomić ${node}: ${e.message} (ustaw QWE_NODE=/ścieżka/do/node)`); });

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (exited !== null) throw new Error(`chat nie wstał (kod ${exited}) — szczegóły w logu [chat!]`);
    if ((await probe(base)) === 'qwe') break;
    await sleep(250);
  }
  if ((await probe(base)) !== 'qwe') { child.kill('SIGKILL'); throw new Error('chat nie wstał w 40 s'); }
  log(`[desktop] chat gotowy: ${base}`);

  return {
    base,
    attached: false,
    async stop() {
      if (exited !== null) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && exited === null; i++) await sleep(100);
      if (exited === null) child.kill('SIGKILL');
    },
  };
}
