---
title: UI (przeglądarka)
description: apps/chat/public — vanilla JS bez bundlera. Moduły UI, karty zadań, widget, kropka, awatary.
sidebar:
  order: 7
status: implemented
sources:
  - apps/chat/public/index.html
  - apps/chat/public/widget.html
  - apps/chat/public/ui/app.js
  - apps/chat/public/ui/cards.js
---

UI to statyczne pliki serwowane przez chat — **vanilla JS, ES modules, bez bundlera**. Ten sam kod działa w przeglądarce i w oknach Electrona (`window.qwe` istnieje tylko w desktopie).

## Moduły

| Plik | Odpowiada za |
|---|---|
| `app.js` | Główny widok: sidebar (simy + rozmowy), wątek, composer z `@`, panel work (desktop), głos, lobby WS. |
| `widget.js` / `widget.css` | Widget Electrona: kropka ↔ karta, stany, sterowanie zadaniem. Entry: `widget.html`. |
| `cards.js` | Karty zadań w wątku: skończone kroki (✓ + czas, ostatnie 3) i pod nimi bieżący jako shimmer z licznikiem; po końcu jedna linia podsumowania. Klik → szczegóły (desktop: panel obok, mobile: inline). Panel otwiera się sam tylko przy `task.waiting`. Eksportuje też `shimmer()` — `app.js` używa go do zaślepki „myśli…” pod simem przy `agent.state: thinking`, którą pierwsza delta `say.text` zamienia w odpowiedź. Model karty z eventów `task.*`, `plan.*`, `step.*`, `tool.*`, `web.*`, `computer.*`. |
| `sims.js` | Dodawanie sima i strona sima: kim jest, co umie, jak pracuje (skille), co pamięta. |
| `pages.js` | Onboarding usera, workflowy (lista + edytor), puste stany. |
| `builder.js` / `avatar.js` | Konstruktor awatara i render awatara (kształt, oczy, usta, akcesoria, wzór, animacja). |
| `kropka.js` | Holograficzny torus (three.js) sterowany stanem rozmowy: listening, thinking, speaking, working… |
| `mentions.js` | Podpowiedzi `@` i `.akcja` w composerze. |
| `markdown.js` | Render GFM na żywo, w trakcie streamu. |
| `audio.js` | Mikrofon → PCM 16 kHz, odtwarzanie `voice.chunk`. |
| `net.js` | Połączenie WS z reconnectem. |
| `dom.js` | Helpery: `$`, `api()`, `toast`, `modal`, `confirmBox`, `isDesktop`. |
| `logo.js` / `icons.js` | Logo (koło z oczami, mruga) i ikony (Lucide, ISC — zwendorowane ścieżki). |
| `app.css` / `desktop.css` | Tokeny (`html[data-theme=light\|dark]`) i style; `desktop.css` — tylko w Electronie. |

## Zasady wyglądu

Z nagłówka `app.css`: *mobile first, spokojnie i profesjonalnie*. **Chrom aplikacji = tusz na papierze**; kolory QUAK (`--q-red`, `--q-green`, `--q-blue`, `--q-yellow`, `--q-violet`…) służą tylko **stanom i awatarom** (każdy sim ma swój kolor). Ten portal stosuje tę samą zasadę.
