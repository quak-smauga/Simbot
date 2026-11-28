---
title: Changelog architektury
description: Istotne zmiany architektury i kontraktów — nie każdy commit, tylko to, co zmienia sposób działania systemu.
sidebar:
  order: 2
---

Tu trafiają zmiany, po których **ktoś musiałby inaczej rozumieć system**: nowy proces, nowy kanał, zmiana kontraktu, nowa capability, nowy event w katalogu. Najnowsze na górze.

## 2026-11-28 — dom usera poza repo (`QWE_HOME`)

- Rozdzielone korzenie: `REPO_ROOT` (kod) i `QWE_HOME` (dane, simy, `.env`). W repo bez zmian; spakowany Simbot.app ustawia `~/Library/Application Support/simbot`.
- `ensureHome()`: pierwszy start w nowym domu zakłada `data/` i kopiuje domyślne simy, nie nadpisując istniejących. `QWE_AGENT_DIR` domyślnie podąża za `QWE_AGENTS_DIR`.
- CLI: `qwe home`, `qwe home import [--to] [--force]`; `pnpm qwe …` nie gubi już komendy przez doklejone `--`.
- Strony docsów: [Konfiguracja](/development/configuration/), [Dane](/architecture/data/).

## 2026-11-28 — Stop i limit łańcucha z workflow

- **Stop**: przycisk wysyłania zamienia się w Stop, gdy simy myślą/mówią (pole puste). `interrupt` (Stop/Esc) kończy teraz też łańcuch sim→sim; nowa wiadomość usera kończy łańcuch po bieżącej wypowiedzi.
- **Limit łańcucha z workflow**: `łańcuch: N` / `łańcuch: bez limitu` (bezpiecznik 100), domyślnie 3 (`chainLimitOf()` w `session.ts`, zamiast `MAX_CHAIN`).
- Nowy event `chain.limit { hops, limit, next, by }` i WS `{ t: "chain.continue" }` — linia „simy wymieniły N wiadomości bez Ciebie · Kontynuuj”.
- Strony docsów: [Mentions](/contracts/mentions/), [WS](/api/chat-ws/), [Eventy](/events/), [Pojęcia](/overview/concepts/).

## 2026-11-27 — `<msg from to>` w prompcie, sim woła tylko @ na początku zdania

- **Historia pokoju w znacznikach**: wiadomości usera i innych simów idą do modelu jako `<msg from="…" to="…">` zamiast `@nazwa: …`; `to` liczy aplikacja (u usera `meta.to` zapisane przy wiadomości). Nowa opcja `BotRunnerOptions.room`.
- **Sim woła sima tylko `@nazwa` otwierającą zdanie/linię** (`Mention.opens`); w środku zdania to wzmianka. Wcześniej „napisał @sima” wywoływał Simę.
- **Cudzysłów nie woła**: `„@sima → @ksiegowy”` maskowane w `maskQuoted()` (core i podgląd chipa w UI).
- **Głos**: `voiceAddress()` — „Księgowy, …”, „hej Simo, …” woła sima bez @.
- UI: kolejne zmiany prowadzącego z rzędu zwijają się w jedną linię „@a → @b · prowadzi”.
- Strony docsów: [Mentions](/contracts/mentions/), [Cykl życia](/architecture/lifecycle/).

## 2026-11-27 — prowadzący rozmowy, @ w kodzie nie woła

- **Prowadzący przyklejony**: `@sim` od usera zmienia prowadzącego (`members[0]`, `Session.setLead()`), kolejne wiadomości bez @ idą do niego. Sim wołający sima go nie zmienia. Dodany przez usera sim od razu prowadzi.
- WS `{ t: "lead", bot }`; `session.members` niesie `lead` i `prev`; `Targets.defaulted`.
- **`@` w `kodzie`, bloku ``` i cytacie `>` nie woła** (`maskQuoted()` w `packages/core/src/mentions.ts`, test regresji w selftest). Prompt rozmowy: `@nazwa` tylko, gdy sim ma odpowiedzieć.
- UI: chip „Odpowiada: @sim” nad polem (podgląd przed wysłaniem, wybór, ×), linie „@sima → @ksiegowy · prowadzi” w wątku, wzmianki w kolorze sima.
- Strony docsów: [Mentions](/contracts/mentions/), [WS](/api/chat-ws/), [UI](/components/ui/).

## 2026-11-27 — panel plików, @[ścieżka], @sim przejmuje rozmowę

- **Panel plików rozmowy** (`public/ui/files.js`): przełącznik w nagłówku obok ⋮, prawa kolumna (współdzielona z panelem komputera). Folder rozmowy ma teraz **podfoldery**; nazwy plików w API, `meta` i narzędziach to ścieżki względne.
- REST: `GET /api/sessions/:id/files` zwraca `{ dir, entries[] }` (`?dir=`, `?all=1`) zamiast `{ dir, files[] }`; upload przyjmuje `&dir=`; nowe `POST …/files/mkdir`, `…/move`, `…/delete`; `…/open` przyjmuje `{ path }`. PDF serwowany bez `CSP: sandbox`.
- **`@[ścieżka]`** w wiadomości usera: plik albo cały folder idzie do tej tury (`meta.scope`, ten sam budżet co załączniki). `files.list` przyjmuje podfolder. Plan z samych lokalnych narzędzi wykonuje się w chat serverze.
- **@sim spoza rozmowy od usera przejmuje rozmowę**: `resolveTargets({ adopt: true })` → `joined`, `Session.takeOver()` (Sima wychodzi, `session.members` z `joined` i `left`). Przycisk „Dodaj sima” w nagłówku i dialog „obok / zamiast Simy” usunięte.
- Obrazy zmniejszane do 1568 px (było 1600).
- Strony docsów: [Pliki rozmowy](/capabilities/files/), [Mentions](/contracts/mentions/), [REST](/api/chat-rest/), [UI](/components/ui/), [Chat](/components/chat/).

## 2026-11-27 — modele lokalne (Ollama) i pliki rozmowy

- **Wybór modeli w UI**: przycisk pod polem wiadomości. Jeden model do wszystkiego, opcjonalnie osobny do narzędzi (podmenu). Dostawcy: Claude i **Ollama** (`packages/core/src/ollama.ts`): status, start serwera, lista modeli z capabilities (`/api/show`: vision, kontekst), pobieranie z postępem.
- `createLlm()` zwraca `SwitchableLlm` (`caps()`, `select()`, `selection()`); `LlmAdapter.caps?()` mówi, czy model slotu widzi obrazy. Wybór w `settings["llm"]`, nowe endpointy `GET/PUT /api/llm`, `POST /api/llm/ollama/start|pull` (chat) i `GET/POST /api/llm` (agent); agent dostaje wybór też w env `QWE_LLM`. Nowe env: `QWE_OLLAMA_URL`, `QWE_OLLAMA_NUM_CTX`.
- computer: model narzędzi bez vision → decydent i planner bez zrzutu, tryb desktop zwraca błąd zamiast działać na ślepo.
- **Pliki rozmowy**: folder `<data>/sessions/<id>/files`, endpointy `/api/sessions/:id/files…`, WS `text` z `files[]`, `Turn.parts` z `Media` (obraz / PDF). Pliki w treści tylko w turze, w której przyszły (budżet tokenów), potem odnośniki. Nowe lokalne narzędzia `files.list`, `files.read`, `files.look`.
- UI: drop-zone, wklejanie, pasek miniatur nad polem, miniatury w dymku, „Otwórz folder plików” w menu rozmowy.
- Strony docsów: [Core](/components/core/), [Chat](/components/chat/), [UI](/components/ui/), [Pliki rozmowy](/capabilities/files/), [REST](/api/chat-rest/), [WS](/api/chat-ws/), [Agent API](/api/agent/), [Konfiguracja](/development/configuration/), [Dane](/architecture/data/).

## 2026-11-24 — computer: status mówi prawdę (faza 2)

Druga powtórka testów: na leafly etap „Filtr ustawiony” zaliczył się sam, bo planner dał mu warunek „adres zawiera /strains”, a raport twierdził, że filtr został użyty. Na xkcd etap „opis odczytany” zaliczył sam adres.

- **Typy etapów** (`Stage.kind`: `state` / `action` / `info`) i dowód zależny od typu: warunek na adres/tekst, krok zmieniający stronę, dosłowny cytat z tekstu strony. Warunek `check` działa już tylko dla `state`.
- **Weryfikacja `done`** w kodzie (event `computer.verify`): decydent rozlicza etapy w polu `stages`, executor sprawdza dowody. Braki → jedno podejście naprawcze (do 8 kroków), potem `partial` z listą. Status `ok` nie zależy już od słowa decydenta. Tylko przeglądarka.
- Nowe statusy etapu: `unmet` (obok `done`, `unconfirmed`); `computer.stage` niesie `kind`, `by`, `why`. `computer.completed` może mieć `status: partial` i `unmet[]`.
- **Raport**: sekcje `WYMAGANIA` (zamiast `PLAN`) i `DOWODY Z EKRANU`; `NIE ZADZIAŁAŁO` opisane jako potknięcia wykonawcy; `ToolResult.data.requirements`.
- **`<done_when>`** w treści `computer.run`: kryteria od sima, których planner nie może pominąć (`splitGoal`, `PlannerInput.required`, `Stage.req`). Opis w `capability.yaml`.
- Pamięć simów: reguła, że z potknięć wykonawcy nie zapisuje się nauczek o stronie (`apps/chat/src/bots.ts`).
- UI: `⚠ częściowo · N/M wymagań` zamiast „błąd”, weryfikacja w przebiegu; chat zapisuje `computer.verify`.
- Strony docsów: [Computer](/capabilities/computer/), [Eventy](/events/), [Testy](/development/testing/), [UI](/components/ui/).

## 2026-11-24 — computer: ramki, nowe karty i poprawki po powtórce testów

Powtórka trzech zadań po fazie 1: xkcd w 2 krokach, leafly bez fałszywego błędu, joemonster dalej z kłopotem. Z eventów i zrzutów: klik `click_at` trafił w „Zamknij X” i zamknął reklamę, a efekt akcji brzmiał „bez zmian”.

- **Ramki**: elementy z widocznych iframe'ów są na liście jako `[1001…]` (`PageElement.frame`); `click`, `type` i `hover` działają na nich po numerze, także między originami. `click_at` mówi, w co trafił wewnątrz ramki.
- **Nowe karty**: karta otwarta przez akcję executora jest zamykana i zgłaszana w efekcie akcji (`BrowserRuntime.takePopups`).
- **Efekt akcji** widzi nakładkę: „NAKŁADKA ZNIKNĘŁA” / „nakładka DALEJ zasłania N%”. Co najmniej 250 ms oddechu po akcji klikającej, bo skutek bywa spóźniony.
- Warunek etapu prawdziwy już w chwili planowania odpada (replan dał `text_contains: "serenad"` na stronie, na której to słowo już było, i etap „treść odczytana” zaliczył się sam).
- Błąd kliku rozróżnia reklamę od elementu z listy leżącego na wierzchu („kliknij [26]”).
- Czat: „N kroków” w podsumowaniu zadania liczy akcje, nie wpisy przebiegu.
- Strony docsów: [Computer](/capabilities/computer/), [Testy](/development/testing/).

## 2026-11-24 — computer: decydent dostaje prawdziwe informacje (faza 1)

Tło i dowody: `design/computer-flow.md` + `design/computer-flow-review.md` (trzy zadania testowe: joemonster, xkcd, leafly).

- **OVERLAY mierzony próbkowaniem** (siatka 12×9, `elementFromPoint`), tylko dla warstw `fixed` / `sticky` / dialog; mały pasek to nowy hint `STICKY_BANNER`. Poprzednia wersja (2026-11-20) liczyła prostokąt kontenera: po zamknięciu reklamy na joemonster.org dalej zgłaszała „zasłania 99% ekranu” i decydent 4× klikał w miejsce po X.
- **Efekt akcji**: `computer.action` po akcji to jeden event z `outcome` i `url` (wcześniej `completed` szedł przed obserwacją, bez efektu). Przekierowanie jest nazwane wprost — na xkcd `/random` decydent 3× losował, bo widział „→ ok” i inny adres niż wpisany. `click_at` zwraca, w co trafił.
- **Etapy**: nowe pole `check` w planie (`Stage.check`) — executor zalicza etap sam z adresu / tytułu / tekstu (`computer.stage` z `auto`, `by`). Status `skipped` zastąpiony przez `unconfirmed`; koniec kaskady „wcześniejsze etapy = pominięte”.
- **Tekst obserwacji** to treść w widoku (zmienia się po przewinięciu), nie pierwsze 1800 znaków dokumentu; `Observation.fullText` dla executora; hint `ELEMENTS_TRUNCATED`; ikony bez tekstu na liście elementów.
- `CAPTCHA_SUSPECTED` tylko przy widocznym widżecie; `click` w link czeka na zmianę adresu (SPA); strona startowa poza `ODWIEDZONE`, bieżąca oznaczona „TU JESTEŚ TERAZ”.
- Chat zapisuje `computer.plan`, `computer.stage` i `computer.resumed` — plan i etapy są w panelu także po przeładowaniu rozmowy.
- Nowy test na prawdziwej przeglądarce: `pnpm --filter @qwe/plugin-computer test:browser`.
- Strony docsów: [Computer](/capabilities/computer/), [Eventy](/events/), [Testy](/development/testing/), [UI](/components/ui/).

## 2026-11-20 — computer: nakładki i najpierw zrzut

- Obserwacja wykrywa zasłonięcie: `PageElement.occluded` („zasłonięty przez div.x”) i hint `OVERLAY` z ramką warstwy. Powód: na joemonster.org decydent 4× klikał link pod pełnoekranową reklamą / banerem zgód, bo lista elementów pokazywała go jako widoczny.
- Błąd kliku niesie powód z logu Playwrighta („klik zasłonięty — `<div …>` przechwytuje kliknięcie”) zamiast „Timeout 6000ms”.
- Prompt decydenta: najpierw zrzut — nakładkę zamknij (też `click_at` w X w iframe), treści nie widać → `wait`. Reguły o celach losowych skrócone do jednej linijki; cofnięta heurystyka nagłówków z `title` w id/klasie.
- Strony docsów: [Computer](/capabilities/computer/), [Testy](/development/testing/).

## 2026-11-19 — computer: powtarzanie mimo zmian strony

- Executor wykrywa **powtarzanie**: ta sama intencja (`navigate` albo klik w link pod ten sam adres, klik w ten sam przycisk) 3× od ostatniego zrobionego etapu → `computer.loop` z opisem „powtórzone N× (strona za każdym razem się zmieniała)”, nawet gdy każda akcja zmienia stronę. Nowe strony z powtarzania nie zerują licznika braku postępu. Powód: na xkcd `/random` executor 19 kroków losował komiksy, bo każdy „nowy” adres liczył się jako postęp.
- `PageElement.tooltip`: atrybut `title` obrazka osobno od `alt` (w obserwacji `dymek(title): "…"`).
- Prompty plannera i decydenta: cel losowy = pierwsza załadowana strona.
- Strony docsów: [Computer](/capabilities/computer/), [Testy](/development/testing/).

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
