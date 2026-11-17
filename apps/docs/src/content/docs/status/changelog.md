---
title: Changelog architektury
description: Istotne zmiany architektury i kontraktów — nie każdy commit, tylko to, co zmienia sposób działania systemu.
sidebar:
  order: 2
---

Tu trafiają zmiany, po których **ktoś musiałby inaczej rozumieć system**: nowy proces, nowy kanał, zmiana kontraktu, nowa capability, nowy event w katalogu. Najnowsze na górze.

## 2026-11-17 — sprzątanie przed publicznym repo

- `agents/` jest poza gitem: simy, ich pamięć i skille zmieniają się w trakcie rozmów. Kompletny przykład sima (plugin `pantry`, skill, spiżarnia): `examples/kucharz`.
- Domyślny sim to `sima`: `QWE_DEFAULT_AGENT=sima`, `QWE_AGENT_DIR=./agents/sima` (wcześniej `default` — folder, którego nie było; działało tylko dzięki fallbackowi).
- `.env` działa teraz dla `QWE_CTX_TRIGGER_CHARS`, `QWE_CTX_KEEP`, `QWE_RECAP_IDLE_MS` i dla skrótów desktopu (`QWE_SHORTCUT_*`) — wcześniej czytane tylko ze środowiska. Wszystkie zmienne dla usera są w `.env.example`.
- Docker: obraz runtime instaluje `plugins/skills` (wcześniej brakowało jego `package.json` przy `pnpm install`), `apps/desktop` i `apps/docs` nie trafiają do obrazu.
- Plan Electrona (`docs/electron/PREP.md`) rozpisany na [Desktop](/components/desktop/) i [Roadmapę](/status/roadmap/) i usunięty. README skrócone — szczegóły tylko w docsach.
- Portal publikowany na GitHub Pages (`.github/workflows/docs.yml`), linki działają pod ścieżką repo.
- Licencja: MIT.

## 2026-11-17 — serwery MCP

- Nowy pakiet `packages/mcp` (`@qwe/mcp`): klient Model Context Protocol bez zależności (stdio + Streamable HTTP) i `McpManager` — wiele serwerów w procesie agenta. Modele, konfiguracja i prompt w `@qwe/core` (`mcp.ts`).
- Nowe pliki danych: `data/mcp.json` (konfiguracja, pisze chat) i `data/mcp-catalog.json` (katalog narzędzi, pisze agent).
- Nowe narzędzia nativeapi: `mcp.<serwer>.<narzędzie>`, `mcp.call`, `mcp.read`, `mcp.prompt`, `mcp.tools`. Runtime agenta rozwiązuje je dynamicznie (`RuntimeOptions.dynamicTool`).
- `AgentManifest.capabilities.mcp: string[]` — które serwery widzi sim.
- Endpointy: chat `GET /api/mcp`, `PUT/DELETE /api/mcp/:name`, `POST /api/mcp/:name/reconnect` (tylko z własnego UI); agent `GET /api/mcp`, `POST /api/mcp/reload`, `POST /api/mcp/:name/reconnect`.
- Eventy: `mcp.catalog` (agent) → `mcp.status` (lobby WS).
- UI: strona „Serwery MCP” (`#mcp`), sekcja na stronie sima, karty `serwer · narzędzie`.
- Kogo dotyczy: nic do migracji; agent (`apps/agent`) ma nową zależność workspace `@qwe/mcp` → `pnpm install`.
- Strony docsów: nowa [Serwery MCP](/capabilities/mcp/); zaktualizowane [AgentManifest](/contracts/agent-manifest/), [Chat REST](/api/chat-rest/), [Agent API](/api/agent/), [Chat WS](/api/chat-ws/), [Eventy](/events/), [Dane](/architecture/data/), [Testy](/development/testing/).

## 2026-11-17 — przeglądarka i komputer rozdzielone w `computer.run`

- Planner ma osobny prompt na tryb: przeglądarka (tylko strony, bez aplikacji i fokusu) i desktop. Wspólny prompt kazał przeglądarce planować etap „Brave na wierzchu”, którego nie da się tam zaliczyć.
- Etap planu ma nowy stan `skipped`; event `computer.stage` niesie `status: done | skipped`, a `computer.started` — `mode: browser | desktop`.
- Raport: pierwsza linia `TRYB`; w `PLAN` `–` = pominięty, `✗` tylko przy statusie innym niż `ok`; notatki z drogi oznaczone jako surowe (obowiązuje `WYNIK`).
- Kontrakt sima (`apps/chat/prompts/system.md`): w przeglądarce `ok` wystarcza — sim nie prosi usera o sprawdzanie ekranu; ostrożność tylko przy `target="desktop"`. Pamięć po turze zapisuje nauczki z zakresem (przeglądarka / desktop).
- UI: zadanie w przeglądarce nazywa się „przeglądarka”, na desktopie „komputer” (karta, panel, widget).
- Kogo dotyczy: konsumentów eventów `computer.*` i parserów raportu (nowa pierwsza linia). Bez migracji i bez nowych zmiennych env.
- Strony docsów zaktualizowane: [computer.run](/capabilities/computer/), [eventy](/events/).

## 2026-11-07 — Simbot Docs

- Powstał portal dokumentacji `apps/docs` (Astro + Starlight, Mermaid, Pagefind).
- Mapa repo → docs i zasady utrzymania: [Utrzymanie docsów](/maintenance/guide/).
- `llms.txt` dla agentów.

## 2026-11-06/07 — target desktop w `computer.run`

- `computer.run target="desktop"`: `DesktopDriver` z tym samym kontraktem co przeglądarka.
- `qwe-helper` (Swift: ScreenCaptureKit, CGEvent, Accessibility) uruchamiany przez Electron.
- Desktop bridge: HTTP + token, `data/desktop-bridge.json`.
- `GUARDED_APPS`: każda akcja w Terminalu, Ustawieniach i menedżerach haseł za potwierdzeniem.
- Tray: wybór ekranu agenta i uprawnienia macOS.

## 2026-11-06 — Electron, etap 1

- Nowy pakiet `apps/desktop`: okno główne, widget (`/widget.html`), tray, skróty globalne, `window.qwe` (preload).
- Electron podpina się pod działający chat albo go startuje; quit sprząta chat → agent → Chromium.
- `CONFIRM_ACTION` niesie `details` (dane do karty potwierdzenia, przepisane z ekranu).
- Baseline: kopia `qwe` sprzed migracji (`4444e3c`).

## Szablon wpisu

```md
## RRRR-MM-DD — krótki tytuł

- Co się zmieniło (proces / kanał / kontrakt / capability / event).
- Kogo dotyczy i co trzeba zrobić (migracja, nowa zmienna env).
- Strony docsów zaktualizowane: …
```
