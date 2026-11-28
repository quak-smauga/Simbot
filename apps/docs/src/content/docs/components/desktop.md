---
title: Desktop (Electron)
description: apps/desktop — skorupa Electrona nad chat serverem. Okno główne, widget nad wszystkim, tray, skróty globalne, helper Swift.
sidebar:
  order: 4
status: implemented
sources:
  - apps/desktop/src/main.js
  - apps/desktop/src/preload.cjs
  - apps/desktop/src/server.js
  - apps/desktop/src/desktop.js
  - apps/desktop/src/secrets.js
  - apps/desktop/scripts/stage.mjs
  - apps/desktop/package.json
  - apps/desktop/helper/qwe-helper.swift
  - apps/chat/public/ui/widget.js
---

`apps/desktop` to **tylko skorupa**. Startuje chat (albo podpina się pod działający `qwe dev`) i otwiera dwa okna na ten sam adres. Runtime (chat + agent) pracuje niezależnie od okien. Nazwa aplikacji: `simbot`, Electron `45.2.3`.

```bash
qwe desktop          # okno główne + widget + ikona w pasku menu
qwe desktop --mock   # bez kluczy
```

## Okna

| Okno | Adres | Cechy |
|---|---|---|
| **Główne** — centrum dowodzenia | `/` | simy, rozmowy, kroki, zrzuty, panel komputera |
| **Widget** — kokpit na pulpicie | `/widget.html?session=…` | `type: 'panel'` (NSPanel, nie kradnie fokusu), `alwaysOnTop`, `frame: false`, `setContentProtection(true)` — **niewidoczny na zrzutach agenta**, więc agent nie kliknie we własny stop |

**Agent działa na hoście.** Desktop nie zmienia `QWE_AGENT_MODE`, więc domyślnie (`spawn`) chat podnosi agenta jako proces na tej samej maszynie. Tak jest prościej i tak musi być: Playwright potrzebuje widocznego okna do logowania usera, a helper Swift działa tylko na hoście. Agent w Dockerze (`QWE_AGENT_MODE=url`, `qwe run`) zostaje opcją dla przeglądarki, desktop jej nie używa. `qwe dev` w przeglądarce działa obok desktopu — Electron tylko się podpina.

Bezpieczeństwo okien: `contextIsolation`, bez `nodeIntegration`, ładowanie tylko z `127.0.0.1:<port>`, linki zewnętrzne przez `shell.openExternal`. Jedyny most UI ↔ Electron to `window.qwe` z preloadu — w zwykłej przeglądarce go nie ma i UI działa jak wcześniej. Zob. [Desktop API](/api/desktop/).

## Widget

```mermaid
stateDiagram-v2
  direction LR
  compact: kropka (compact)
  expanded: karta (expanded)
  compact --> expanded: agent czeka na Ciebie / klik / ⌥Space
  expanded --> compact: × / gotowe
  state expanded {
    polecenie
    pracuje
    czeka_na_Ciebie
    gotowe_lub_błąd
  }
```

- **Kolor plakietki** = stan: niebieski pracuje · żółty czeka na Ciebie · czerwony błąd / ktoś woła · szary wstrzymane.
- **Start zadania nie rozwija widgetu.** Rozwija się sam dopiero, gdy agent czeka na Ciebie — według ustawienia: rozwiń / tylko kropka / tylko ikona w trayu.
- Gotowe = krótka informacja; błąd zostaje na plakietce, aż go obejrzysz.
- Wstrzymaj / Wznów / Anuluj osobno. Widzi też inne rozmowy, w których simy pracują.
- **Przeciąganie** za kropkę albo nagłówek; przykleja się do krawędzi, nie wyjeżdża poza ekran; pozycja i monitor zapamiętane, odłączony monitor → wraca na dostępny.
- **Schowany widget ≠ zatrzymany agent.**
- ↗ / „Popraw” otwiera okno główne dokładnie na tej rozmowie i tym zadaniu.

## Tray i menu

Pokaż/schowaj widget · Polecenie… · Otwórz simbot · Nowa rozmowa · Wstrzymaj wszystko · Zatrzymaj wszystko · Ustawienia · Zakończ. Prawy klik na kropce = to samo menu. Ikona traya ma stany: idle, mruga, pracuje, czeka (`assets/tray-*Template.png`).

**Ustawienia** (`~/Library/Application Support/simbot/desktop.json`):

| Ustawienie | Wartości |
|---|---|
| Gdy agent czeka na Ciebie | pokaż i rozwiń widget (domyślnie) · pokaż kropkę · tylko ikona |
| Uruchamiaj przy logowaniu | tak / nie |
| Startuj bez okna (tylko widget) | tak / nie |
| Komputer: ekran agenta | aktywny (z oknem na wierzchu) albo konkretny monitor |
| Komputer: uprawnienia | stan i nadawanie: Nagrywanie ekranu, Dostępność |
| Klucze API… | okno kluczy w aplikacji (to samo co ⋯ → Klucze API) |
| Pokaż dane w Finderze | otwiera dom usera (`QWE_HOME`) |

## Simbot.app (build)

```bash
pnpm app        # release/mac/Simbot.app
pnpm app:dmg    # release/Simbot-<wersja>.dmg
```

Dwa etapy:

1. **`scripts/stage.mjs` → `apps/desktop/build/runtime`** (~25 MB, < 1 s). esbuild pakuje chat, agenta i każdy plugin w jeden plik (warunek `development` = źródła `.ts` wprost, bez `tsc`), w **tym samym układzie katalogów co monorepo** — ścieżki liczone od `REPO_ROOT` (prompty, `public/`, `plugins/<nazwa>`) działają bez zmian. Obok: `public/`, `prompts/`, `capability.yaml`, `node_modules/playwright{,-core}` (jedyna zależność poza bundlem, kopiowana z magazynu pnpm), helper Swift (budowany, jeśli go nie ma) i domyślne simy z `examples/` (nigdy `agents/` z repo — tam jest pamięć simów).
2. **electron-builder** (`build` w `apps/desktop/package.json`): `src/` + `assets/` w `app.asar`, runtime jako `Resources/runtime`, Electron z `node_modules` (bez pobierania), podpis ad-hoc (`identity: "-"`), `NSMicrophoneUsageDescription`.

W paczce (`app.isPackaged`): `ROOT` = `Resources/runtime`, chat i agent działają na **binarce Simbota w trybie Node** (`ELECTRON_RUN_AS_NODE=1`, Node 24 z `node:sqlite`) — bez osobnego Node. PATH dostaje `/opt/homebrew/bin` i `/usr/local/bin` (aplikacja z Docka ma tylko `/usr/bin:/bin`). Serwery MCP startują w domu usera; `node` w ich komendzie = Node agenta.

Ograniczenia dziś: podpis ad-hoc (bez Developer ID i notaryzacji — na innym Macu Gatekeeper zapyta; zgody macOS mogą wymagać ponownego nadania po przebudowie), Chromium dla `computer.run` z cache Playwrighta (`~/Library/Caches/ms-playwright`) albo `QWE_COMPUTER_CHANNEL=chrome`, tylko architektura maszyny, na której budujesz.

## Dom i klucze

Dom usera (`QWE_HOME`): w repo korzeń repo, w spakowanej aplikacji `~/Library/Application Support/simbot` — zob. [Konfiguracja](/development/configuration/#dom-usera-qwe_home).

**Klucze API** (`secrets.js`): Anthropic, ElevenLabs, Tavily, Brave. Szyfrowane przez `safeStorage` (klucz szyfrujący w pęku kluczy macOS) w `~/Library/Application Support/simbot/secrets.json` — zawsze w `userData`, także w trybie dev, nigdy w repo. Przed startem chatu `applySecrets()` wkłada je do env procesu; chat i agent dziedziczą je i wygrywają z `.env` (bo `loadDotenv()` nie nadpisuje ustawionych zmiennych). Usunięty klucz → wraca wartość z shella albo `.env`. Zmiana kluczy = restart procesu chatu (`restartServer()`) i przeładowanie okien; gdy desktop jest podpięty pod osobne `qwe dev`, nie restartuje cudzego procesu i mówi, co zrobić.

**Pierwsze uruchomienie** (`public/ui/welcome.js`): w Electronie, bez `--mock`, gdy simy nie mają żadnego modelu (`/api/config` → `llm: "mock"`) — okno „Cześć! Tu Simbot.”: klucz Anthropic (sprawdzany od razu), opcjonalne klucze, potem zgody macOS (stan odświeżany co 2,5 s, można pominąć). „Pomiń klucz” = modele z Ollamy (`localStorage qwe.welcome.skipKey`). Potem jak dawniej: imię i awatar.

## Skróty

| Skrót | Działanie | Zmienna |
|---|---|---|
| `⌥Space` | polecenie w widgecie z dowolnego miejsca | `QWE_SHORTCUT_WIDGET` |
| `⌃⌥Esc` | zatrzymaj wszystko (cancel aktywnych tasków) | `QWE_SHORTCUT_STOP` |
| `⌘⇧W` | pokaż / schowaj widget | — |
| `⌘N` / `⌘K` | nowa rozmowa / szukaj rozmowy | — |

## Helper Swift i tryb desktop

`helper/qwe-helper.swift` — natywne ręce i oczy agenta na macOS (ScreenCaptureKit, CGEvent, Accessibility). Uruchamia go Electron, więc zgody macOS należą do *simbot*. Agent woła go przez **desktop bridge** (HTTP + token). Opis akcji: [computer → target desktop](/capabilities/computer/#target-desktop-macos). Protokół: [Desktop API](/api/desktop/).

```bash
pnpm --filter @qwe/desktop helper   # swiftc → helper/build/qwe-helper (wystarczą Command Line Tools, Xcode niepotrzebny)
pnpm --filter @qwe/desktop icons    # ikony aplikacji i traya
```

:::caution[Niepodpisany build]
Dev build nie jest podpisany — uprawnienia TCC dostaje `Electron.app` z `node_modules` i po każdej aktualizacji Electrona trzeba je nadać ponownie. Do dystrybucji potrzebne są Developer ID i notaryzacja (zob. [Roadmapa](/status/roadmap/)).
:::
