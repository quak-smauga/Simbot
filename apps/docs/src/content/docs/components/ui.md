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
| `cards.js` | Karty zadań w wątku: skończone kroki (✓ + czas, ostatnie 3) i pod nimi bieżący jako shimmer z licznikiem; po końcu jedna linia podsumowania. Klik → szczegóły (desktop: panel obok, mobile: inline). Panel otwiera się sam tylko przy `task.waiting`. W panelu pod każdą akcją `computer.run` jest jej efekt (`outcome` z eventu: „PRZEKIEROWANO na …”, „bez zmian”, „trafiono w: …”), a etapy planu mają `✓` z dowodem (`zaliczony: URL …`), `?` niepotwierdzony albo `✗` niezrobiony z powodem. Zadanie ze statusem `partial` to w wątku `⚠ … · częściowo · 2/3 wymagań` (nie „błąd”); `computer.verify` jest w przebiegu jako „🔎 weryfikacja: …”. Kryteria `<done_when>` są wycinane z wyświetlanego celu. Eksportuje też `shimmer()` — `app.js` używa go do zaślepki „myśli…” pod simem przy `agent.state: thinking`, którą pierwsza delta `say.text` zamienia w odpowiedź. Model karty z eventów `task.*`, `plan.*`, `step.*`, `tool.*`, `web.*`, `computer.*`. |
| `sims.js` | Dodawanie sima i strona sima: kim jest, co umie, jak pracuje (skille), co pamięta. |
| `pages.js` | Onboarding usera, workflowy (lista + edytor), puste stany. |
| `builder.js` / `avatar.js` | Konstruktor awatara i render awatara (kształt, oczy, usta, akcesoria, wzór, animacja). |
| `kropka.js` | Holograficzny torus (three.js) sterowany stanem rozmowy: listening, thinking, speaking, working… |
| `models.js` | Przycisk modelu pod polem wiadomości (prawa strona): menu z wyszukiwarką, Claude i Ollama (status, „Uruchom”, pobieranie modelu z paskiem postępu), podmenu „Model do narzędzi ›” (domyślnie ten sam). Ikona oka = model widzi obrazy; żółta kropka = model narzędzi bez vision albo Ollama wyłączona. |
| `attach.js` | Załączniki: drop-zone na całe okno (tylko dla plików), wklejanie ⌘V, pasek miniatur 57 px nad polem (×, spinner, błąd), zmniejszanie obrazów do 1568 px przed wysłaniem (GIF bez zmian), miniatury w dymku wiadomości. Upload od razu do folderu rozmowy. |
| `mentions.js` | Podpowiedzi `@` i `.akcja` w composerze; pod simami pasujące pliki i foldery rozmowy, `@[` — same pliki (wstawia `@[ścieżka]`). Sim spoza rozmowy ma opis „przejmie rozmowę”. |
| `app.js` — chip „Odpowiada” | Nad polem wiadomości: kto odpowie na wiadomość bez @ (prowadzący, awatar i kolor sima). Gdy w polu jest `@sim` — podgląd „Odpowie: @sim” / „@sim przejmie rozmowę”. Klik = wybór prowadzącego (WS `lead`), × = z powrotem Sima. Podgląd pomija `@` w kodzie, cytacie i cudzysłowie. Kilka zmian prowadzącego z rzędu = jedna linia w wątku. Wzmianki `@sim` w kolorze sima. |
| `files.js` | Panel plików rozmowy po prawej (przełącznik w nagłówku obok ⋮, ⇧⌘F): okruszki, wstecz / dalej, lista i siatka, sortowanie, szukanie, zaznaczanie z klawiatury, podgląd (Spacja), zmiana nazwy w miejscu, nowy folder, przeciąganie (z systemu, między folderami, do pola wiadomości), menu kontekstowe, pasek stanu. Zob. [Pliki rozmowy](/capabilities/files/). |
| `markdown.js` | Render GFM na żywo, w trakcie streamu. |
| `audio.js` | Mikrofon → PCM 16 kHz, odtwarzanie `voice.chunk`. |
| `net.js` | Połączenie WS z reconnectem. |
| `dom.js` | Helpery: `$`, `api()`, `toast`, `modal`, `confirmBox`, `isDesktop`. |
| `logo.js` / `icons.js` | Logo (koło z oczami, mruga) i ikony (Lucide, ISC — zwendorowane ścieżki). |
| `app.css` / `desktop.css` | Tokeny (`html[data-theme=light\|dark]`) i style; `desktop.css` — tylko w Electronie. |

## Zasady wyglądu

Z nagłówka `app.css`: *mobile first, spokojnie i profesjonalnie*. **Chrom aplikacji = tusz na papierze**; kolory QUAK (`--q-red`, `--q-green`, `--q-blue`, `--q-yellow`, `--q-violet`…) służą tylko **stanom i awatarom** (każdy sim ma swój kolor). Ten portal stosuje tę samą zasadę.
