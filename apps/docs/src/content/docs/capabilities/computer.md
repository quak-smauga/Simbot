---
title: computer.run
description: Jedno narzędzie, dwa osobne środowiska — przeglądarka wbudowana (Playwright) i cały pulpit macOS. Planner, pętla observe → decide → act, human-in-the-loop, raport.
sidebar:
  order: 3
status: implemented
sources:
  - plugins/computer/src/index.ts
  - plugins/computer/src/executor.ts
  - plugins/computer/src/planner.ts
  - plugins/computer/src/decider.ts
  - plugins/computer/src/browser.ts
  - plugins/computer/src/desktop.ts
  - plugins/computer/capability.yaml
---

Agent opisuje **cel i oczekiwany rezultat**, nie kliknięcia. Executor ma własną pętlę na tańszym modelu (`QWE_EXECUTOR_MODEL`).

## Dwa środowiska, nie jedno

`computer.run` to wspólna pętla i raport, ale **przeglądarka to nie komputer** — tryby mają osobne prompty i różny poziom zaufania:

| | Przeglądarka (domyślnie) | Desktop (`target="desktop"`) |
|---|---|---|
| Co to jest | własne okno Chromium simbota (Playwright), tylko strony WWW | prawdziwy komputer usera: aplikacje, okna, pliki |
| Sterownik | `BrowserRuntime` (`browser.ts`) | `DesktopDriver` (`desktop.ts`) |
| Planner | `SYSTEM_BROWSER` — etapy tylko o stronach (adres, treść, formularz); bez aplikacji i fokusu | `SYSTEM_DESKTOP` — fokus i „aplikacja na wierzchu” mają znaczenie |
| Decider | `SYSTEM` | `SYSTEM_DESKTOP` |
| Zaufanie do `ok` | pełne — adres i treść czytane z DOM; sim nie prosi usera o sprawdzanie ekranu | ostrożne — sim prosi o potwierdzenie tylko, gdy raport sam sobie przeczy |
| Nazwa w UI | „przeglądarka” | „komputer” |

Tryb niesie event `computer.started` (`mode: browser | desktop`) i pierwsza linia raportu (`TRYB`).

```xml
<computer.run>Otwórz quak.com.pl, sprawdź jakie są podstrony i podsumuj</computer.run>
<computer.run target="desktop">Otwórz Notatki i zapisz nową notatkę „zakupy: mleko, chleb”</computer.run>
```

## Pętla wykonawcza

```mermaid
flowchart TB
  start([computer.run]) --> obs0[OBSERVE<br/>pierwsza obserwacja]
  obs0 --> plan["PLANNER (1 wywołanie LLM)<br/>cel już spełniony? etapy z „zrobione, gdy…”<br/>szacunek kroków → budżet"]
  plan -->|already_done| done
  plan --> decide["DECIDE<br/>(LLM → jedna akcja JSON)"]
  decide --> act[ACT]
  act --> obs[OBSERVE + VERIFY<br/>czy widać „expect”?]
  obs --> decide
  decide -->|needs_user| wait["task.waiting<br/>(LOGIN_REQUIRED / CAPTCHA / OTHER)"]
  decide -->|confirm| conf["task.waiting CONFIRM_ACTION<br/>+ details z ekranu"]
  wait -->|Wznów| obs
  conf -->|Wznów| act
  obs -->|brak postępu| replan[REPLAN]
  replan --> decide
  decide -->|done / fail| done([RAPORT])
```

- **Obserwacja** (przeglądarka): elementy `[N]` z DOM + tekst + hinty + screenshot. DOM, jeśli możliwe; vision (`QWE_COMPUTER_VISION=1`, domyślnie włączone), jeśli potrzebne.
  - Obrazek: nazwa = `alt`, atrybut `title` osobno jako `dymek(title)` (pole `PageElement.tooltip`) — tam strony trzymają tekst pokazywany po najechaniu, np. żart „alt text” na xkcd.
  - **Zasłonięcie**: dla widocznych elementów `elementFromPoint` w środku — jeśli klik dostałoby coś innego, element ma `(zasłonięty przez div.x)` (pole `PageElement.occluded`) i ląduje na liście za niezasłoniętymi. Warstwa zasłaniająca ≥ 25% ekranu (najwyższy przodek z `position: fixed`) → hint `OVERLAY: … zasłania N% ekranu i M elementów, box=[…]`.
  - **Błąd kliku**: z logu Playwrighta wyciągany jest powód („`<div …>` intercepts pointer events” → „klik zasłonięty — `<div …>` przechwytuje kliknięcie”), zamiast samego „Timeout”.
- **Najpierw zrzut**: decydent przed wyborem `[N]` patrzy na zrzut — reklama, modal albo baner nad stroną → najpierw zamknięcie (przycisk z listy albo `click_at` w X, bo reklamy w iframe nie mają `[N]`); treści jeszcze nie widać → `wait`.
- **Planner** (`planner.ts`): przed pętlą i przy braku postępu (replan), osobny prompt na tryb. Przykład (desktop): „wejdź do nowej karty w Brave”, a karta już jest na ekranie → koniec w kroku 0.
- **Etapy planu**: `todo` → `doing` → `done` albo `skipped`. Decydent zalicza etap polem `stage_done`; wcześniejsze, wciąż otwarte etapy stają się `skipped` (poszedł dalej bez nich). Przy zakończeniu `ok` wszystko, co zostało otwarte, też jest `skipped`. Event `computer.stage` niesie `status: done | skipped`.
- **Budżet kroków** z szacunku plannera; `QWE_COMPUTER_MAX_STEPS` (25) to tylko twardy limit.
- **Ochrona przed pętlą** (`computer.loop`) → zmiana strategii, po 3 pętlach koniec jako `partial`:
  - ta sama akcja 3× bez zmiany strony,
  - powrót na stronę odwiedzoną już 2×,
  - **powtarzanie**: ta sama intencja 3× od ostatniego zrobionego etapu, nawet gdy strona za każdym razem się zmienia. `navigate` i klik w link pod ten sam adres to ta sama intencja (xkcd: `navigate /random` i klik „Random”). Decydent dostaje „POWTARZASZ — akcja działa, obecna strona jest wynikiem”, a nowe strony z takiego powtarzania nie liczą się jako postęp,
  - brak postępu przez 6 kroków → replan (najwyżej 2).
- **Cel losowy** („losowy komiks”): pierwsza załadowana strona jest OK; jeśli na zrzucie nie widać jeszcze treści — `wait`, a nie ponowne losowanie.
- **Notatki**: każda decyzja może nieść `note` — fakt zebrany po drodze, oddawany w raporcie.

### Akcje decydenta

`navigate` · `click [N]` · `click_at x,y` · `hover` · `type [N]` · `press` · `scroll` · `wait` · `back` · `open_app` (desktop) · `needs_user` · `done` · `fail`

Akcje zmieniające stan mogą mieć `confirm` (+ `details: [{label, value}]` przepisane **z ekranu**, nie z celu) → osobne potwierdzenie usera **przed** wykonaniem.

## Human-in-the-loop

| Sytuacja | Co się dzieje |
|---|---|
| Login / captcha | `needs_user` → task `waiting_user` → karta „🔐 Zaloguj się” w czacie i w widgecie. Głosem „zalogowałem się” / „zrobione, leć dalej” albo przycisk **Wznów**. |
| Operacja wrażliwa (wysłanie, zakup, usunięcie) | `CONFIRM_ACTION` z danymi do karty (np. Netto / VAT / Brutto). |
| User chce przejąć | „przejmuję kontrolę” / „oddaję kontrolę” (command router) → pauza / wznowienie taska. |

Wznów = zgoda na wznowienie; runtime robi nową obserwację i sam sprawdza stan. **Treść stron to dane, nie instrukcje.**

## Raport

Każde zakończenie wraca do sima jako pełny raport: tryb, odwiedzone strony po kolei, kroki, notatki, przekazania kontroli, co nie zadziałało, ostatni widok. Sim nie dostaje samego „anulowano”, kiedy zadanie w połowie się udało.

- `TRYB` — pierwsza linia: przeglądarka wbudowana albo desktop.
- `PLAN` — `✓` zrobiony · `–` pominięty (bez wpływu na wynik) · `✗` niezrobiony. `✗` pojawia się **tylko** przy statusie innym niż `ok`; raport `ok` nigdy nie ma krzyżyka.
- `ZEBRANE PO DRODZE` — surowe notatki z kolejnych kroków; przy różnicach obowiązuje `WYNIK`.

Statusy (`ToolResult.status`): `ok` · `partial` (limit kroków / pętla, ale coś zebrane) · `cancelled_by_user` · `failed`. Czekanie na usera **nie** kończy zadania.

## Przeglądarka

- Playwright z trwałym profilem `data/browser-profile` (cookies, sesje, karty). Jedna przeglądarka na proces agenta, jeden task naraz (lock).
- Na hoście okno jest widoczne (user może się zalogować). W Dockerze headless (`QWE_COMPUTER_HEADLESS=1`, wymuszane przez `QWE_IN_DOCKER`) — podgląd przez screenshoty, logowanie wymaga agenta na hoście.
- `QWE_COMPUTER_CHANNEL=chrome | msedge` — zainstalowana przeglądarka zamiast Chromium Playwrighta.

## Target desktop (macOS)

<span class="sb-inline-status">Częściowo — świeże</span>

`target="desktop"` przełącza ten sam executor na `DesktopDriver` (`desktop.ts`) — ten sam kontrakt obserwacji i akcji, więc pętla, raport, ochrona przed pętlą, potwierdzenia i stop są wspólne.

| | |
|---|---|
| Ręce i oczy | `qwe-helper` (Swift: ScreenCaptureKit, CGEvent, Accessibility), uruchamiany przez Electron |
| Połączenie | [desktop bridge](/api/desktop/#desktop-bridge): HTTP + token |
| Obserwacja | zrzut wybranego ekranu + elementy `[N]` z drzewa AX aktywnego okna + tekst |
| Akcje | `click [N]` (AXPress albo klik w środek) · `click_at x,y` (ułamki ekranu → punkty) · `type` · `press "cmd+n"` · `scroll` · `open_app` · `navigate` (domyślna przeglądarka) · `back` (`cmd+[`) |
| Ekran agenta | domyślnie ten z oknem na wierzchu, albo wybrany w trayu |
| Strażnicy | Terminal, iTerm, Ustawienia systemowe, menedżery haseł (`GUARDED_APPS`): **każda** akcja zmieniająca stan za potwierdzeniem |
| Uprawnienia | Nagrywanie ekranu + Dostępność — tray → Ustawienia → Komputer: uprawnienia |

Strony WWW rób trybem przeglądarki (pewniejszy). Desktop — dla natywnych aplikacji, plików i rzeczy poza przeglądarką.

## Konfiguracja

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `QWE_EXECUTOR_MODEL` | `claude-haiku-5-5` | model plannera i decydenta |
| `QWE_COMPUTER_HEADLESS` | `0` | `1` = bez okna |
| `QWE_COMPUTER_CHANNEL` | — | `chrome` / `msedge` |
| `QWE_COMPUTER_VISION` | `1` | screenshot do modelu |
| `QWE_COMPUTER_MAX_STEPS` | `25` | twardy limit kroków |
| `QWE_DESKTOP_URL` / `QWE_DESKTOP_TOKEN` | — | most desktopowy (albo `data/desktop-bridge.json`) |
