---
title: Pliki rozmowy
description: Folder plików każdej rozmowy (z podfolderami), panel plików, @[ścieżka], pliki w kontekście modelu (budżet) i lokalne narzędzia files.list / files.read / files.look.
sidebar:
  order: 6
status: implemented
sources:
  - apps/chat/src/files.ts
  - apps/chat/src/chat.ts
  - apps/chat/src/session.ts
  - apps/chat/public/ui/attach.js
  - apps/chat/public/ui/files.js
---

Każda rozmowa ma folder na dysku: `<data>/sessions/<id>/files/`. Trafia tam wszystko, co user upuści na okno albo wklei w pole wiadomości. Folder może mieć podfoldery; porządkuje się go w panelu plików albo ręcznie w Finderze. Folder znika razem z rozmową.

Nazwy plików w API, w `meta` wiadomości i w narzędziach to **ścieżki względne** (`przepisy/ciasta/szarlotka.md`). Każdy segment przechodzi przez `safeName` (bez `/ \ : * ? " < > |`, bez `[ ]` — zarezerwowane dla `@[…]`, bez kropki na początku); ścieżka nie wyjdzie poza folder rozmowy.

## Panel plików

Przełącznik w nagłówku rozmowy (ikona folderu obok ⋮, licznik plików, ⇧⌘F). Na desktopie panel zajmuje prawą kolumnę (tę samą co panel komputera — gdy otwiera się zadanie, panel plików czeka pod spodem). Na telefonie wysuwa się z prawej.

| Co | Jak |
|---|---|
| Nawigacja | dwuklik / Enter = wejście; ‹ › (⌘[ ⌘]) = wstecz / dalej; okruszki; ⌘↑ = folder wyżej. Przejście w głąb wjeżdża z prawej, w górę — z lewej |
| Widoki | lista (nazwa · rozmiar · data; klik w nagłówek kolumny sortuje) albo siatka z miniaturami; wybór zapamiętany |
| Zaznaczanie | klik, ⌘klik, ⇧klik (zakres), ⌘A, strzałki (w siatce też ← →), Esc |
| Podgląd | Spacja: obraz, PDF, tekst; ← → między plikami, Esc zamyka |
| Zmiana nazwy | F2 albo klik w nazwę zaznaczonego; zaznacza nazwę bez rozszerzenia. Nowy folder (⇧⌘N) startuje w tym trybie |
| Przeciąganie | pliki z systemu → bieżący folder albo folder pod kursorem (bez zasłony drop-zone); wiersz → folder / okruszek = przeniesienie; wiersz → pole wiadomości = `@[ścieżka]` |
| Menu kontekstowe | Podgląd, Wspomnij w wiadomości (`@`), Zmień nazwę, Pobierz, Pokaż w Finderze, Usuń (⌫, z potwierdzeniem — trwale, nie do kosza) |
| Szukanie | po nazwach w całym folderze rozmowy; wynik z folderem nadrzędnym |
| Pasek stanu | liczba elementów, zaznaczone, rozmiar; „Pokaż w Finderze” |

Panel odświeża się po wysłaniu wiadomości, po uploadzie i po powrocie do okna (zmiany zrobione w Finderze).

## `@[ścieżka]` — plik albo folder w tej turze

`@[przepisy]` albo `@[przepisy/ciasta/szarlotka.md]` w wiadomości usera. Podpowiedzi: `@` pokazuje simy, a pod nimi pasujące pliki; `@[` — same pliki. Wstawia też „Wspomnij” w panelu i przeciągnięcie wiersza do pola.

- Chat server (`resolveScope`) rozwija folder do wszystkich plików w środku (rekurencyjnie, maks. 200) i zapisuje `meta.scope = { refs, files }`.
- W tej turze pliki ze `scope` idą do modelu jak załączniki (ten sam budżet, nadmiar jako spis), poprzedzone linią `[user wskazał: @[przepisy] (folder, 2 pl.) …]`. W kolejnych turach zostaje jedna linia z podpowiedzią narzędzi.
- Nieistniejąca ścieżka → ostrzeżenie w logu rozmowy; `@[…]` nie jest wołaniem sima.
- W wątku `@[…]` to chip; klik otwiera panel w tym miejscu.

## Jak plik trafia do rozmowy

1. UI wysyła plik od razu po dodaniu: `POST /api/sessions/:id/files?name=…` (surowe bajty, maks. 25 MB). Obrazy PNG / JPEG / WebP zmniejsza wcześniej do 1568 px po dłuższym boku (także przy uploadzie przez panel).
2. Wiadomość niesie same nazwy: `{ t: "text", text, files: ["wykres.png"] }`. Wiadomość może składać się z samych plików.
3. Wiadomość usera ma `meta.files`; UI rysuje miniatury w dymku.

## Co widzi model

| Kiedy | Co |
|---|---|
| Tura, w której plik przyszedł | plik w treści, dopóki mieści się w budżecie: obraz → blok obrazu, PDF → dokument (tylko Claude), tekst → `<plik name="…">…</plik>` (do 40 000 znaków) |
| Ponad budżet | spis: `[plik w folderze rozmowy: nazwa — obraz 1568×882, 245 KB; zajrzyj: <files.look>…]` |
| Kolejne tury | tylko odnośnik jak wyżej — kontekst nie puchnie, cache zostaje stabilny |

Budżet na pliki w jednej turze: Claude ok. 20 000 tokenów; Ollama ¼ kontekstu (`num_ctx`). Koszt: obraz u Claude ≈ szer.×wys./750 (maks. 1600), w Ollamie 300; PDF 2000 / stronę; tekst znaki / 3,5.

Model bez vision dostaje przy obrazie notkę „ten model nie widzi obrazów”, a UI ostrzega przy dodaniu obrazka. PDF w Ollamie — notka, że model go nie czyta.

## Narzędzia

Lokalne (chat server, bez agenta), w prompcie każdego sima obok `memory.search`:

| Narzędzie | Co robi |
|---|---|
| `<files.list></files.list>` | pliki w folderze z podfolderami: ścieżka, typ, rozmiar, wymiary / strony / linie; `<files.list>przepisy</files.list>` — tylko ten podfolder |
| `<files.read lines="1-200">nazwa.txt</files.read>` | tekst pliku; `lines` opcjonalnie. Do 40 000 znaków naraz, z podpowiedzią, jak czytać dalej |
| `<files.look>nazwa.png</files.look>` | obraz albo PDF — wynik narzędzia ma `meta.files`, więc plik trafia do modelu w następnym kroku tej samej tury |

Narzędzia przyjmują ścieżki względne. Plan (`<plan>`) złożony z samych lokalnych narzędzi (np. kilka `files.read`) wykonuje się w chat serverze, krok po kroku — agent server ich nie zna.
