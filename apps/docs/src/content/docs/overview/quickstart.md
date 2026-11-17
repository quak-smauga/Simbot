---
title: Szybki start
description: Od pnpm install do pierwszej rozmowy z simem — w przeglądarce i w desktopie.
sidebar:
  order: 3
status: implemented
sources:
  - packages/cli/src/index.ts
  - .env.example
---

## Wymagania

- **Node ≥ 22.13** — wbudowane `node:sqlite`.
- **pnpm** (repo deklaruje `pnpm@10.28.0`).
- **Docker** — tylko do `qwe build` / `qwe run`.
- **macOS 14+** — tylko dla `qwe desktop` i trybu `computer.run target="desktop"`; reszta jest wieloplatformowa. Helper Swift buduje się z samych Command Line Tools (`xcode-select --install`), pełny Xcode i certyfikat do podpisu nie są potrzebne do developmentu.

## Instalacja

```bash
pnpm install
cp .env.example .env          # ANTHROPIC_API_KEY (+ ELEVENLABS_API_KEY do głosu)
export PATH="$PWD/bin:$PATH"  # żeby pisać `qwe` (albo: pnpm qwe …)
```

Przeglądarka dla `computer.run` — raz, z paczki pluginu, żeby wersja się zgadzała:

```bash
pnpm --filter @qwe/plugin-computer exec playwright install chromium
```

Alternatywa bez pobierania: `QWE_COMPUTER_CHANNEL=chrome` w `.env` używa zainstalowanego Chrome'a.

## Uruchomienie

```bash
qwe dev            # http://127.0.0.1:3100 — chat; agent wstanie sam po pierwszej akcji
```

```bash
qwe dev --mock     # bez kluczy: skryptowany LLM, ton zamiast głosu, udawany search, skryptowany computer
```

```bash
qwe dev --agent    # chat + agent od razu (dashboard: http://127.0.0.1:7777/dashboard/)
```

```bash
qwe desktop        # Electron: okno główne + widget + tray (macOS)
```

:::tip[Tryb mock]
`--mock` (albo `QWE_MOCK=1`) podmienia LLM, głos, wyszukiwarkę i computer na skrypty. To najszybszy sposób, żeby sprawdzić UI, karty zadań i widget bez kluczy i bez kosztów.
:::

## Pierwsza rozmowa

1. Przy pierwszym wejściu podajesz **imię i awatar** — to Twój `@` w rozmowie.
2. Domyślnie czeka **Sima**. Możesz dodać własnego sima: nazwa (= `@`), rola, awatar z konstruktora, persona.
3. **+ Nowa rozmowa** → wybierz sima albo kilku (grupa) i opcjonalnie workflow.
4. W composerze `@` podpowiada simy, `.` po nazwie — akcje (`@sim.task`).
5. Zapytaj o coś aktualnego („ile kosztuje bilet miesięczny ZTM?”) — sim użyje `web.query`, w czacie pojawi się karta zadania.

Skróty w UI: `M` — głos i kropka, `F` — kropka na pełny ekran, `Esc` — przerwij, `◐` — motyw.

## Co dalej

- [Konfiguracja (env)](/development/configuration/) — wszystkie zmienne.
- [Testy i debugowanie](/development/testing/) — selftesty, dashboard, logi eventów.
- [Desktop](/components/desktop/) — widget, tray, uprawnienia macOS.
