// STAGE — składa build/runtime: to, co Simbot.app uruchamia poza repo (Resources/runtime w paczce).
// Układ katalogów jak w monorepo, żeby ścieżki liczone od REPO_ROOT (prompty, public, plugins/<nazwa>) działały bez zmian:
//   runtime/apps/chat/dist/index.js      chat — jeden plik (esbuild: @qwe/core, voice, ws, SDK Anthropic…)
//   runtime/apps/chat/{public,prompts}/
//   runtime/apps/agent/dist/index.js     agent — jeden plik (+ mcp)
//   runtime/apps/agent/public/
//   runtime/plugins/<nazwa>/dist/index.js + capability.yaml   wbudowane capability (loader importuje dist)
//   runtime/node_modules/playwright{,-core}   jedyna zależność poza bundlem (binarki, dynamiczne require)
//   runtime/apps/desktop/helper/build/qwe-helper   helper Swift
//   runtime/agents/                      domyślne simy (examples/) — kopiowane do domu usera przy pierwszym starcie
// Uruchamia je binarka Electrona w trybie Node (ELECTRON_RUN_AS_NODE) — Node 24 z node:sqlite, bez osobnego Node w paczce.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '..', '..');
const OUT = join(DESKTOP, 'build', 'runtime');
const t0 = Date.now();
const log = m => console.log(`[stage] ${m}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// .js w runtime = ESM (bundle ma import/export i import.meta)
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'simbot-runtime', private: true, type: 'module' }, null, 2));

// ── bundle ──
// warunek "development" → pakiety workspace wskazują src/*.ts, więc bundlujemy źródła wprost (bez tsc)
// require() w zależnościach CJS (ws, linkedom…) potrzebuje prawdziwego require w ESM
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22', conditions: ['development'], logLevel: 'warning', legalComments: 'none',
  external: ['playwright', 'playwright-core', 'bufferutil', 'utf-8-validate', 'fsevents'],
  banner: { js: "import { createRequire as __qweCreateRequire } from 'node:module'; const require = __qweCreateRequire(import.meta.url);" },
};
const entries = [
  ['apps/chat/src/index.ts', 'apps/chat/dist/index.js'],
  ['apps/agent/src/index.ts', 'apps/agent/dist/index.js'],
  ...readdirSync(join(REPO, 'plugins')).filter(n => existsSync(join(REPO, 'plugins', n, 'src', 'index.ts'))).map(n => [`plugins/${n}/src/index.ts`, `plugins/${n}/dist/index.js`]),
];
await Promise.all(entries.map(([from, to]) => build({ ...common, entryPoints: [join(REPO, from)], outfile: join(OUT, to) })));
log(`bundle: ${entries.map(([, to]) => to).join(', ')}`);

// ── zasoby czytane w runtime ──
const copy = (rel, to = rel) => { const src = join(REPO, rel); if (existsSync(src)) cpSync(src, join(OUT, to), { recursive: true, dereference: true }); };
copy('apps/chat/public');
copy('apps/chat/prompts');
copy('apps/agent/public');
for (const n of readdirSync(join(REPO, 'plugins'))) copy(`plugins/${n}/capability.yaml`);

// ── playwright: z magazynu pnpm (prawdziwe katalogi, bez dowiązań) ──
const pwDir = realpathSync(join(REPO, 'plugins', 'computer', 'node_modules', 'playwright'));
const pwCore = realpathSync(join(pwDir, '..', 'playwright-core'));
cpSync(pwDir, join(OUT, 'node_modules', 'playwright'), { recursive: true, dereference: true });
cpSync(pwCore, join(OUT, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
log('playwright + playwright-core');

// ── helper Swift (budujemy, jeśli go nie ma) ──
const helper = join(DESKTOP, 'helper', 'build', 'qwe-helper');
if (!existsSync(helper)) { log('buduję helper…'); execFileSync('pnpm', ['run', 'helper'], { cwd: DESKTOP, stdio: 'inherit' }); }
cpSync(helper, join(OUT, 'apps', 'desktop', 'helper', 'build', 'qwe-helper'));

// ── domyślne simy: examples/ (Sima tworzy się sama). Nigdy agents/ z repo — tam jest Twoja pamięć i notatki simów. ──
if (existsSync(join(REPO, 'examples'))) cpSync(join(REPO, 'examples'), join(OUT, 'agents'), { recursive: true, dereference: true });

log(`gotowe: ${OUT} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
