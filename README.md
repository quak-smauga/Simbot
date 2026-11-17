# Simbot

**Simy** to agenci z własną rolą, personą, narzędziami, skillami i pamięcią. Rozmawiasz z jednym albo kilkoma naraz (`@sim`, `@sim.task`). Sim, kiedy trzeba, szuka w sieci albo **bierze komputer** — przeglądarkę albo cały pulpit macOS — klika, czyta i wraca z raportem. Działa w przeglądarce i jako aplikacja desktopowa na Electronie z widgetem nad wszystkimi oknami.

W kodzie projekt nazywa się **qwe** (`@qwe/*`, CLI `qwe`, zmienne `QWE_*`).

📖 **Dokumentacja:** portal w [`apps/docs`](apps/docs) — architektura, API, eventy, capability, konfiguracja. Lokalnie: `pnpm docs` → http://localhost:4321.

## Start

Wymaga Node ≥ 22.13 i pnpm. Docker tylko do `qwe build` / `qwe run`, macOS tylko dla desktopu.

```bash
pnpm install
cp .env.example .env              # ANTHROPIC_API_KEY (+ ELEVENLABS_API_KEY do głosu)
export PATH="$PWD/bin:$PATH"      # żeby pisać `qwe` (albo: pnpm qwe …)
pnpm --filter @qwe/plugin-computer exec playwright install chromium
```

```bash
qwe dev              # http://127.0.0.1:3100 — chat; agent wstanie sam po pierwszej akcji
qwe dev --mock       # bez kluczy: skryptowany LLM, głos, search i computer
qwe desktop          # Electron: okno główne + widget + ikona w pasku menu
pnpm test            # selftesty bez API
```

Na starcie czeka Sima. Kolejne simy dodajesz w UI. Przykład sima z własnym pluginem i skillem: [`examples/kucharz`](examples/kucharz).

## Layout

```
apps/chat         chat server (SQLite, rozmowy, simy, głos, WS) + UI
apps/agent        agent server: taski, plan, pause/resume/cancel, SSE, dashboard
apps/desktop      Electron: okno, widget, tray, skróty, helper Swift (pulpit macOS)
apps/docs         portal dokumentacji (Astro + Starlight)
packages/core     kontrakty, eventy, <nativeapi>, plan, LLM, manifest
packages/voice    VAD, STT, TTS
packages/mcp      klient MCP (stdio + HTTP)
packages/cli      qwe: dev / desktop / inspect / build / run …
plugins/          wbudowane capability: web, computer, skills
agents/           Twoje simy (poza gitem)
examples/         przykładowy sim
docker/           obraz runtime agenta
```

## Licencja

[MIT](LICENSE)
