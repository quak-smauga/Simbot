---
title: Testy i debugowanie
description: Selftesty bez API, tryb mock, dashboard agenta, logi eventów i najczęstsze problemy.
sidebar:
  order: 2
status: implemented
sources:
  - packages/core/src/selftest.ts
  - plugins/computer/src/selftest.ts
  - packages/mcp/src/selftest.ts
  - package.json
---

## Testy

```bash
pnpm test        # wszystkie pakiety z "test"
```

| Pakiet | Co sprawdza (bez API) |
|---|---|
| `@qwe/core` (`src/selftest.ts`) | parser strumienia i bloków `<nativeapi>`, executor planu (równoległość, `after`, skip, cykle), `extractJson`, command router, mentions, slug usera |
| `@qwe/plugin-computer` (`src/selftest.ts`) | executor na atrapie przeglądarki i skryptowanym decydencie: raport przy anulowaniu (z wynikiem zebranym po drodze), wykrywanie pętli i okrążeń X → Y → Z → X, powtarzanie tej samej intencji mimo zmian strony (xkcd /random), błąd kliku zasłoniętego nakładką i opis zasłonięcia w obserwacji, przekazanie kontroli userowi (czekanie ≠ anulowanie), efekt akcji (przekierowanie, spóźniona nawigacja, punkt trafienia `click_at`), etapy zaliczane z warunku planu, strona startowa poza odwiedzonymi |
| `@qwe/plugin-computer` (`src/browsertest.ts`, osobno: `pnpm --filter @qwe/plugin-computer test:browser`) | obserwacja i akcje na **prawdziwym Chromium** (headless) i lokalnych stronach-atrapach, bez sieci: OVERLAY mierzony próbkowaniem (pełnoekranowa reklama, pasek w przezroczystym kontenerze, okno zgód z dwóch warstw, zwykła treść na elemencie), tekst idący za widokiem, `ELEMENTS_TRUNCATED`, CAPTCHA tylko widoczna, czekanie na zmianę adresu w SPA, ikony bez tekstu, `click_at` z punktem trafienia. Wymaga `playwright install chromium`, dlatego nie jest częścią `pnpm test` |
| `@qwe/mcp` (`src/selftest.ts`) | prawdziwy serwer testowy `kwak-mcp.mjs` po stdio i po HTTP: handshake, katalog na dysku, sekcja promptu, wywołania przez tagi, argumenty (JSON / atrybuty / sama treść), błąd narzędzia, nieznane narzędzie, zasoby, prompty, dostęp per sim, potwierdzenia, stan między wywołaniami |

```bash
pnpm typecheck   # tsc we wszystkich pakietach
```

## Tryb mock

`qwe dev --mock` / `qwe desktop --mock` / `QWE_MOCK=1` — skryptowany LLM, ton zamiast głosu, udawany search, skryptowany computer (w tym skryptowany decydent desktopu). Dobry do UI, kart, widgetu i przepływów human-in-the-loop.

## Gdzie patrzeć

| Co | Gdzie |
|---|---|
| Eventy agenta na żywo | `http://127.0.0.1:7777/dashboard/` |
| Eventy agenta (log) | `data/agent-events.jsonl`, `GET /api/events?since=0&sessionId=…` |
| Stan tasków | `GET :7777/api/tasks?sessionId=…`, `GET :7777/api/tasks/:id` |
| Co widzi manifest | `qwe inspect agents/<sim>` |
| Odtworzenie rozmowy | `GET :3100/api/sessions/:id` (wiadomości + eventy) |
| Baza | `sqlite3 data/chat.db` |
| Logi procesów | terminal `qwe dev` (chat i agent piszą na stdout/stderr) |
| Electron | Widok → Narzędzia dewelopera (w oknie głównym i widgecie) |

## Częste problemy

**Port 3100 zajęty przez coś innego** — Electron sprawdza `GET /api/config`; jeśli odpowiada nie-qwe, pokaże błąd. Zmień `QWE_CHAT_PORT`.

**Electron nie może uruchomić chatu** — ustaw `QWE_NODE=/ścieżka/do/node` (Node ≥ 22.13). `qwe desktop` robi to sam.

**Nowy plugin sima nie działa** — restart agenta; unia capability ładuje się na starcie.

**Computer nie startuje przeglądarki** — `pnpm --filter @qwe/plugin-computer exec playwright install chromium` albo `QWE_COMPUTER_CHANNEL=chrome`.

**Desktop: brak helpera** — `pnpm --filter @qwe/desktop helper`. Brak zgód → tray → Ustawienia → Komputer: uprawnienia, potem restart aplikacji.

**Zgody macOS zniknęły po aktualizacji Electrona** — niepodpisany build: TCC przypina zgody do `Electron.app` z `node_modules`; nadaj je ponownie.
