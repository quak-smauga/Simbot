---
title: Konfiguracja (env)
description: Wszystkie zmienne środowiskowe używane w kodzie — LLM, głos, wyszukiwarka, computer, serwery, desktop.
sidebar:
  order: 1
status: implemented
sources:
  - .env.example
  - packages/core/src/env.ts
  - plugins/computer/src/index.ts
  - apps/desktop/src/main.js
  - packages/cli/src/index.ts
---

`.env` z **domu usera** (`QWE_HOME`, niżej) czyta `loadDotenv()` (`packages/core/src/env.ts`); zmienne już ustawione w środowisku wygrywają. Electron czyta z `.env` tylko to, czego potrzebuje skorupa (host, port, skróty).

## Dom usera (`QWE_HOME`)

Dwa korzenie: **`REPO_ROOT`** — gdzie jest kod (apps, plugins, prompty; w Simbot.app wnętrze paczki, tylko do odczytu) i **`QWE_HOME`** — gdzie mieszka user: `data/`, `agents/`, `.env`. Ścieżki względne z `QWE_DATA_DIR`, `QWE_AGENTS_DIR`, `QWE_AGENT_DIR` liczą się od `QWE_HOME`.

| Tryb | `QWE_HOME` |
|---|---|
| repo (`qwe dev`, `qwe desktop`) | korzeń repo — jak dawniej |
| spakowany Simbot.app (`app.isPackaged`) | `~/Library/Application Support/simbot` (ustawia Electron, chat i agent dziedziczą przez env) |
| ręcznie | `QWE_HOME=… pnpm qwe desktop` — np. test domu aplikacji z repo |

Dom poza repo przy pierwszym starcie dostaje `data/` i kopię domyślnych simów z paczki (`ensureHome()`); istniejących simów nie nadpisuje. Simy gdzie indziej (repo gita, Dropbox): `QWE_AGENTS_DIR` w `.env` domu. Bazy nie trzymaj w folderze synchronizowanym przez iCloud — SQLite z `-wal` się tam psuje.

- `qwe home` — gdzie jest dom teraz i dom Simbot.app.
- `qwe home import [--to DIR] [--force]` — kopiuje `data/`, `agents/` i `.env` z repo do domu Simbot.app. Odmawia, gdy chat działa (spójna kopia SQLite) albo cel nie jest pusty (bez `--force`). Repo zostaje bez zmian.

Lista poniżej powstała z przeszukania kodu (`apps/*/src`, `packages/*/src`, `plugins/*/src`). Wszystko, co ustawia user, jest w `.env.example`. Zmienne oznaczone **†** są wewnętrzne — ustawia je CLI, Electron albo obraz Dockera — i celowo ich tam nie ma.

## LLM

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | wymagany poza `--mock` |
| `QWE_CHAT_MODEL` | `claude-sonnet-5-5` | model rozmowy |
| `QWE_EXECUTOR_MODEL` | `claude-haiku-5-5` | model wykonawczy: computer, pamięć, streszczenia, recapy |
| `QWE_CHAT_MAX_TOKENS` | `1200` | limit odpowiedzi sima |
| `QWE_CHAT_THINKING` | `0` | `1` = model myśli przed odpowiedzią (+4000 tokenów) |
| `QWE_PLANNER_MODEL` | = executor | model plannera computera |
| `QWE_EXECUTOR_DESKTOP_MODEL` | = executor | model decydenta w trybie desktop |
| `QWE_OLLAMA_URL` | `http://127.0.0.1:11434` | serwer Ollamy (modele lokalne) |
| `QWE_OLLAMA_NUM_CTX` | `16384` | górny limit kontekstu (`num_ctx`) dla modeli Ollamy — więcej = więcej RAM |

Model wybrany w UI (przycisk pod polem wiadomości, zapis w `settings` pod kluczem `llm`) nadpisuje `QWE_CHAT_MODEL` / `QWE_EXECUTOR_MODEL` i modele z env podawane przez computer (`QWE_PLANNER_MODEL`, `QWE_EXECUTOR_DESKTOP_MODEL`). Pusty wybór (`PUT /api/llm` bez `chat`) = powrót do env. Agent dostaje wybór w `QWE_LLM` (JSON) przy spawnie i przez `POST /api/llm`.

## Głos (ElevenLabs)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `ELEVENLABS_API_KEY` | — | bez klucza chat działa tekstowo |
| `ELEVEN_VOICE_ID` | z `.env.example` | domyślny głos (sim może mieć własny `look.voice`) |
| `ELEVEN_TTS_MODEL` | `eleven_flash_v2_5` | TTS |
| `ELEVEN_STT_MODEL` | `scribe_v1` | STT |

## Wyszukiwarka (`web.query`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `SEARCH_PROVIDER` | `auto` | tavily → brave → duckduckgo |
| `TAVILY_API_KEY`, `BRAVE_API_KEY` | — | opcjonalne |
| `SEARCH_MAX_RESULTS` | `5` | |
| `SEARCH_FETCH_PAGES` | `3` | |
| `SEARCH_PAGE_CHARS` | `3500` | |
| `SEARCH_TIMEOUT_MS` | `8000` | timeout zapytań |

## Computer

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `QWE_COMPUTER_HEADLESS` | `0` | `1` = bez okna (w Dockerze wymuszone) |
| `QWE_COMPUTER_CHANNEL` | — | `chrome` / `msedge` zamiast Chromium Playwrighta |
| `QWE_COMPUTER_VISION` | `1` | screenshot do modelu (desktop zawsze z vision) |
| `QWE_COMPUTER_MAX_STEPS` | `25` | twardy limit kroków w przeglądarce |
| `QWE_COMPUTER_DESKTOP_MAX_STEPS` | `30` | twardy limit kroków na desktopie |
| `QWE_COMPUTER_PLANNER` | `1` | `0` = bez plannera (sama pętla decydenta) |
| `QWE_DESKTOP_URL`, `QWE_DESKTOP_TOKEN` † | — | most desktopowy; ustawia Electron (albo `data/desktop-bridge.json`) |

## Serwery i dane

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `QWE_HOST` | `127.0.0.1` | |
| `QWE_CHAT_PORT` | `3100` | |
| `QWE_AGENT_PORT` | `7777` | |
| `QWE_AGENT_MODE` | `spawn` | `spawn` = chat podnosi agenta; `url` = agent już działa |
| `QWE_AGENT_URL` | `http://127.0.0.1:7777` | |
| `QWE_HOME` † | korzeń repo | dom usera: `data/`, `agents/`, `.env` (patrz wyżej) |
| `QWE_AGENT_DIR` | `<QWE_AGENTS_DIR>/sima` | sim dla `qwe inspect` / `qwe build` bez argumentu i fallback agent servera |
| `QWE_AGENTS_DIR` | `./agents` | katalog wszystkich simów |
| `QWE_DEFAULT_AGENT` | `sima` | domyślny sim: tożsamość agent servera i prowadzący, gdy nikt inny nie pasuje |
| `QWE_DATA_DIR` | `./data` | SQLite, eventy, screenshoty, profil przeglądarki |
| `QWE_MOCK` † | `0` | to samo co `--mock` |

:::note[`agents/` jest poza gitem]
Simy, ich pamięć i skille zapisywane w trakcie rozmów żyją w `agents/` i nie trafiają do repo. Sima tworzy się sama przy pierwszym starcie. Kompletny przykład sima z pluginem i skillem: `examples/kucharz` (`cp -r examples/kucharz agents/`).
:::

## Kontekst i pamięć

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `QWE_CTX_TRIGGER_CHARS` | `40000` | od ilu znaków niestreszczonej rozmowy zaczyna się streszczanie |
| `QWE_CTX_KEEP` | `12` | ile ostatnich wiadomości zostaje zawsze dosłownie |
| `QWE_RECAP_IDLE_MS` | `90000` | cisza przed recapem rozmowy |

## Desktop i Docker

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `QWE_SHORTCUT_WIDGET` | `Alt+Space` | skrót globalny: polecenie w widgecie |
| `QWE_SHORTCUT_STOP` | `Control+Alt+Escape` | skrót globalny: zatrzymaj wszystko |
| `QWE_NODE` † | `node` | Node, którym Electron startuje chat (`qwe desktop` ustawia sam) |
| `QWE_DESKTOP_DIST` † | `0` | `1` = Electron startuje chat z `dist` |
| `QWE_IN_DOCKER` † | — | ustawiane w obrazie: nasłuch `0.0.0.0`, headless |
| `QWE_INSTANCE_ID` † | hostname | tożsamość instancji (`qwe run` ustawia nazwę) |
| `QWE_BUILD_HASH` † | — | hash builda obrazu |
