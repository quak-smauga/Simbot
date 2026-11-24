# Review: computer-flow.md

Drugie spojrzenie na [computer-flow.md](computer-flow.md). Sprawdziłem wnioski jeszcze raz na eventach (`data/agent-events.jsonl`), **zrzutach ekranu** z kroków (`data/screenshots/`), pamięci Simy (`agents/sima/memory.md`) i kodzie pluginu.

## Werdykt w trzech zdaniach

1. Kierunek jest dobry: najpierw naprawić to, co nie dociera, potem dodać wymagania i weryfikację.
2. Analiza myli się co do przyczyny w joemonsterze i pomija dwa źródła problemu w xkcd. We wszystkich trzech zadaniach decydent dostał **fałszywą albo brakującą informację na wejściu**, a nie tylko zabrakło kontroli na wyjściu.
3. Sekcję 7 da się uprościć: etapy sprawdzane przez kod zamiast przez `stage_done`, a sędzią rzeczy rozmytych może być Sima, bez osobnego calla do haiku.

---

## A. Co analiza ma źle albo pomija

### A1. joemonster: reklama została zamknięta pierwszym klikiem. Kolejne 4 kliki wymusił nasz własny hint

Analiza (sekcja 2): „4× klik w X reklamy bez efektu”. Zrzuty mówią co innego:

| Zrzut | Co widać |
|---|---|
| `shot_mwuxhk9q_4` (przed krokiem 2) | pełnoekranowa reklama OLX, „Zamknij x” w prawym górnym rogu |
| `shot_mwuxhq5p_5` (po kroku 2) | **strona główna w pełni widoczna**; reklama zwinęła się do paska na dole (~17% ekranu) z własnym „x” |
| `shot_mwuxi8pg_9`, `shot_mwuxiit0_c` (kroki 7–9) | **artykuł w pełni czytelny**, na dole ten sam pasek |

Mimo to hint po każdym kroku brzmiał: `OVERLAY: div#spoltopcon_… zasłania 99% ekranu … box=[0,0,0.99,1] — zamknij ją, zanim klikniesz coś pod spodem`. Zmieniała się tylko liczba zasłoniętych elementów: 51 → 4.

**Przyczyna** ([observe-script.ts:31-34](../plugins/computer/src/observe-script.ts) i [:104-105](../plugins/computer/src/observe-script.ts)): za nakładkę bierzemy najwyższego przodka z `position: fixed`, a jej powierzchnię liczymy z jego prostokąta. Kontener reklamy dalej rozciąga się na cały ekran (przezroczysty), choć widoczny jest tylko pasek. Decydent dostał polecenie „zamknij”, więc klikał w miejsce, gdzie X był wcześniej. Na dokładkę poszedł replan z etapem „Overlay zamknięty”, którego nie dało się spełnić.

Drugi fałszywy alarm z tego samego biegu: `OVERLAY: div#article-box … box=[0.1,-0.15,0.52,11.12]`. To jest **sam artykuł** (wysokość 11 ekranów, nie jest `fixed`), zgłoszony jako nakładka do zamknięcia.

**Skutek dla planu:** to regresja z commita `46eb3cb`, nie brak wykrywania pętli. Punkt 3 z 7.5 (siatka `click_at`) leczy objaw. Właściwa naprawa:

- powierzchnię nakładki mierzyć próbkowaniem: siatka np. 8×6 punktów, `elementFromPoint`, ile punktów trafia w tę warstwę;
- `box` = prostokąt tego, co faktycznie przechwytuje klik, nie kontenera;
- hint OVERLAY tylko dla warstw `fixed`/`sticky` (albo `dialog`/`[aria-modal]`), nigdy dla zwykłej treści;
- próg „zamknij ją” dopiero od ~40% punktów; mniejszy pasek = `STICKY_BANNER: … (nie przeszkadza, omiń)`.

### A2. xkcd: trzy źródła, analiza widzi jedno

Zrzut po kroku 1 (`shot_mwuxz3j1_3`) pokazuje w pełni załadowany komiks „Negativity”. Decydent miał wszystko, a i tak uznał, że „nie jest na losowym”. Brak informacji o przekierowaniu (analiza 1.1) to prawda, ale są jeszcze dwa powody:

**a) Cel od Simy był już „zatruty”.** Cel brzmiał: „…Jeśli losowanie się zetnie albo wyskoczy 404, otwórz xkcd.com/927/…”. Skąd to? Z pamięci Simy:

```
agents/sima/memory.md
13: 2026-11-19 · …losowanie może się zacinać; wtedy zamiast wielokrotnego klikania „Random”…
14: 2026-11-19 · …losowanie na c.xkcd.com/random/comic/ może się zacinać, więc lepiej podać numer.
22: 2026-11-24 · …losowanie xkcd … może się zacinać i wymagać ponowień…
```

Losowanie xkcd nigdy się nie zacinało. To błąd executora (pętla z 19.11) został zapisany jako „nauczka o stronie”, Sima wkłada ją do kolejnych celów, decydent czyta „może się zaciąć” i widzi zacięcie. **Błąd narzędzia utrwala się w pamięci i sam się napędza.** Dzisiejszy bieg dopisał trzecią taką notatkę (linia 22).

**b) Bieżąca strona jest na liście „ODWIEDZONE STRONY”.** `trace.visit(obs)` wykonuje się przed decyzją ([executor.ts:240](../plugins/computer/src/executor.ts)), więc decydent w PAMIĘCI TASKA widzi stronę, na której właśnie wylądował, jako już odwiedzoną. Jego notatka z kroku 3 mówi dosłownie: „przeglądarka nadal na **wcześniej wylosowanym** komiksie” o komiksie 2609, którego nigdy wcześniej nie widział.

**Co dodać do planu:**
- w PAMIĘCI TASKA bieżąca strona oznaczona `← TU JESTEŚ (wynik ostatniej akcji)`, a nie zwykła pozycja listy;
- posprzątać linie 13, 14 i 22 w `agents/sima/memory.md` po naprawie (decyzja Kacpra, to jego dane);
- zasada dla nauczek: Sima nie zapisuje „strona X się zacina”, gdy raport ma `STATUS: ok` albo gdy kłopot to pętla executora. Raport powinien to rozróżniać wprost: `KŁOPOT PO STRONIE: executora | strony`.

### A3. Popupy: znany problem z 20.11, którego nie ma w planie

`BrowserRuntime` trzyma jedną `page` i nie słucha `context.on("page")` (w [browser.ts](../plugins/computer/src/browser.ts) nie ma żadnej obsługi nowych kart). Klik w reklamę otwiera ją w nowym oknie, executor o tym nie wie, a okno zostaje. Dziś się nie zdarzyło, ale przy każdej stronie z reklamami to kwestia czasu. Minimalnie: nową kartę zamknąć i dopisać do efektu akcji „klik otworzył reklamę w nowej karcie (zamknięta)”.

### A4. Limity obserwacji, o które rozbije się weryfikacja

- **Tekst strony: 1800 znaków od góry dokumentu** ([browser.ts:207](../plugins/computer/src/browser.ts), [observe-script.ts:87-94](../plugins/computer/src/observe-script.ts)). Przewijanie nie przesuwa tego okna. W artykule to menu i lead; resztę decydent czyta ze zrzutu. Stąd opis artykułu z joemonstera, którego Sima nie umiała potwierdzić.
- **Elementy: twardy limit 70**, bez informacji, że lista jest ucięta. Każda obserwacja joemonstera i leafly (18 z 18) miała dokładnie 70; tylko xkcd się mieścił (49). Filtry na leafly mogły po prostu nie zmieścić się na liście.

To uderza w 7.2: „cytat musi być dosłownie w tekście obserwacji” przy 1800 znakach odrzuci większość prawdziwych cytatów. Do weryfikacji trzeba trzymać **pełny tekst strony** po stronie executora (`document.body.innerText`, np. do 200 tys. znaków na obserwację, bez wysyłania do modelu). Decydentowi warto dawać tekst z okolic widocznego fragmentu, nie z góry dokumentu, plus hint `ELEMENTS_TRUNCATED: 70 z 212`.

---

## B. Uwagi do ustaleń (sekcja 7)

### B1. Etapy niech zalicza kod, nie decydent

W trzech biegach `stage_done` od Haiku zawiódł na trzy sposoby: nie podany wcale (xkcd, 0 z 2), podany dla złego numeru (joemonster krok 5), i z kaskadą „wcześniejsze = pominięte” (joemonster krok 9, leafly krok 8). Sekcja 7 dokłada do tego wymagania i weryfikację, ale mechanizm etapów zostawia.

Propozycja: planner do każdego etapu, gdzie się da, daje **warunek sprawdzalny przez kod**:

```json
{"title":"Strona losowego komiksu załadowana",
 "check":{"url_matches":"^https://xkcd\\.com/\\d+/?$"}}
{"title":"Strona Gelato otwarta",
 "check":{"url_contains":"/strains/gelato","text_contains":"Gelato"}}
```

Executor po każdej obserwacji sprawdza warunki sam i wpisuje do logu `✓ etap 1 zrobiony (URL xkcd.com/1773)`. To jest dokładnie „computer wie, że wszedł”: w xkcd etap 1 zamknąłby się po kroku 1 i decydent nie miałby czego powtarzać. `stage_done` zostaje tylko dla etapów bez warunku. Kaskada „wcześniejsze = pominięte” znika: niezaliczony etap zostaje otwarty.

### B2. Wymagania trzeba typować, bo „cytat istnieje” ≠ „wymaganie spełnione”

Kod z 7.2 sprawdza, czy cytat padł na ekranie. To łapie zmyślenia, ale nie złe przypisanie: dla „kliknięty filtr” cytat „Hybrid” jest na stronie niezależnie od tego, czy cokolwiek kliknięto. Trzy typy, każdy z innym sprawdzeniem:

| Typ | Przykład | Sprawdzenie w kodzie |
|---|---|---|
| **stan** | „jesteś na stronie Gelato” | warunek na ostatniej obserwacji (URL / tekst), jak w B1 |
| **akcja** | „kliknięty filtr i opisane, co zmienił” | istnieje krok `click`/`type` zakończony sukcesem, **po którym zmienił się URL albo treść**; executor ma to z porównania sygnatur |
| **informacja** | „podaj THC, efekty” | cytat w pełnym tekście którejś obserwacji (A4); treść odczytana tylko ze zrzutu = „z obrazu, niepotwierdzone tekstem” |

### B3. Sędzia haiku: odłożyłbym

Po B1, B2 i deklaracji decydenta zostaje wąska grupa przypadków rozmytych. Naturalnym sędzią jest dla nich **Sima**: silniejszy model, zna intencję Kacpra, i już dziś robi to dobrze (sama wypunktowała `ok` bez filtrów). Brakowało jej dowodów, nie osądu. Czyli:

- wymaganie potwierdzone przez kod → ✓;
- zadeklarowane, ale niepotwierdzone → `?` w raporcie z powodem („cytatu nie ma w tekście strony”, „odczytane z obrazu”);
- status: `ok` tylko gdy wszystko ✓; jakiekolwiek ✗ albo `?` przy wymaganiu typu stan/akcja → `partial`.

Jeden komponent mniej, zero dodatkowych calli. Haiku dołożyć dopiero, gdy z logów wyjdzie, że `?` jest dużo i Sima się na nich myli.

### B4. `<done_when>` od Simy: dobre, ale nie pierwsze

W leafly cel od Simy **zawierał** filtry wprost. Zgubił je planner. Najpierw więc „planner nie może pominąć polecenia z celu” (z typami z B2), bez zmian w prompcie Simy. `<done_when>` jako drugi krok, gdy zobaczymy, że planner źle tnie cele na wymagania.

Technicznie `TAG_RE` ([nativeapi.ts:72](../packages/core/src/nativeapi.ts)) poradzi sobie z zagnieżdżonym tagiem o innej nazwie, także wewnątrz `<plan>`. Do sprawdzenia testem: zachowanie przy niedomkniętym `<done_when>` w strumieniu.

### B5. Podejście naprawcze: zgoda, z jednym doprecyzowaniem

Jedno podejście, mały budżet, potem koniec: tak. Wyzwalać je powinien tylko wynik **z kodu** (wymaganie typu stan/akcja niespełnione), nigdy `?`. Inaczej fałszywie negatywna weryfikacja kosztuje 8 kroków klikania po stronie, która jest już dobra.

### B6. SPA: celowane czekanie zamiast stałego

Zamiast dokładać ~1,5 s po każdym kliku: gdy klikany element ma `href`, czekać na zmianę URL (do ~3 s); w pozostałych przypadkach na zmianę sygnatury strony (do ~1 s). Szybkie strony nie zwalniają.

---

## C. Kolejność (ustalona 24.11.2026)

Dwie fazy po 6 kroków, między nimi powtórka trzech zadań testowych.

### Faza 1: decydent dostaje prawdziwe informacje

| # | Zmiana | Pliki | Dlaczego tu |
|---|---|---|---|
| 1 | **OVERLAY mierzony próbkowaniem, tylko fixed/sticky**; mały pasek = `STICKY_BANNER` (A1) | `observe-script.ts` | regresja z `46eb3cb`; połowa kroków joemonstera |
| 2 | Persist `computer.plan/stage/resumed` | `apps/chat/src/session.ts` | jedna linijka |
| 3 | Efekt akcji w logu i evencie: przekierowanie, „bez zmian”, „strona przeszła na Y”; bieżąca strona „TU JESTEŚ”; START poza odwiedzonymi; **`click_at` mówi, w co trafił** (F) | `executor.ts`, `browser.ts`, `cards.js` | xkcd; widać w panelu, co dała akcja |
| 4 | **Tekst z widoku** zamiast z góry dokumentu, dłuższe akapity, `ELEMENTS_TRUNCATED`, pełny tekst trzymany do weryfikacji (A4, E1) | `observe-script.ts`, `browser.ts` | dziś przewijanie nie zmienia tego, co decydent czyta |
| 5 | Warunki etapów sprawdzane przez kod (B1) | `planner.ts`, `executor.ts` | „computer wie, że wszedł”; koniec fałszywych „pominięty” |
| 6 | SPA: celowane czekanie po kliku (B6); CAPTCHA tylko widoczna | `browser.ts`, `observe-script.ts` | leafly |

**Po fazie 1: powtórka xkcd, joemonster, leafly.** Kryteria w sekcji D. Zakres fazy 2 korygujemy o to, co wyjdzie.

### Faza 2: status mówi prawdę

| # | Zmiana | Pliki | Dlaczego tu |
|---|---|---|---|
| 7 | Popupy: zamknij i zgłoś (A3); elementy z iframe'ów jako zwykłe `[N]` (E2) | `browser.ts`, `observe-script.ts` | X reklamy dostaje numer |
| 8 | Wymagania typowane (stan / akcja / informacja) w plannerze, nie do pominięcia (B2) | `planner.ts` | leafly: zgubione filtry |
| 9 | `done` z rozliczeniem wymagań, weryfikacja w kodzie, `partial`, jedno podejście naprawcze (B3, B5) | `decider.ts`, `executor.ts`, nowy `verifier.ts` | sedno |
| 10 | Raport WYMAGANIA / DOWODY / „kłopot po stronie: executora czy strony”; UI ⚠ częściowo | `executor.ts`, `apps/agent/src/runtime.ts`, `cards.js` | Sima i panel |
| 11 | Zasada dla nauczek Simy: nie zapisywać „strona X się zacina”, gdy kłopot był po stronie executora (A2a) | `apps/chat/src/bots.ts` | żeby błąd narzędzia nie wracał w celach |
| 12 | `<done_when>` od Simy (7.1 z analizy) | `bots.ts`, `index.ts` pluginu, `planner.ts` | kryteria od zlecającego; buduje na 8–9 |

Kroki 8–10 i 12 zmieniają kontrakt: wpis w `status/changelog.md` i aktualizacja `capabilities/computer` w docsach w tym samym kroku.

### Odłożone, wracamy z danymi

- **Znaczniki `[N]` na zrzucie** (uzasadnienie w F).
- Sędzia haiku (B3).
- Siatka dla pętli `click_at`: po kroku 1 i 3 powinna być zbędna.

## G. Stan wdrożenia (24.11.2026, wieczór)

**Faza 1 (kroki 1–6): wdrożona**, commit `51b8b7e`.

**Powtórka trzech zadań po fazie 1:**

| Zadanie | Wynik | Uwagi |
|---|---|---|
| xkcd | ✓ 2 kroki (było 4 z trzema losowaniami) | planner dał etapowi „komiks odczytany” sam warunek na URL, więc zaliczył się bez czytania → do kroku 8 (typ „informacja” nie może mieć warunku na adres) |
| leafly | ✓ wg Kacpra | — |
| joemonster | ✗ 9 akcji, status `ok` mimo „filmu nie widziałem” | patrz niżej |

**Co wyszło z joemonstera (eventy + zrzuty `shot_mwv2g…`):**

1. `click_at (0.92, 0.04)` **trafił w „Zamknij X” i zamknął reklamę**, a efekt akcji brzmiał „bez zmian · trafiono w: iframe”. Porównywaliśmy adres i tekst; zniknięcie nakładki niczego z tego nie zmienia. Decydent uznał, że się nie udało.
2. Klik w film przechwycił przycisk Play, który sam był na liście jako `[26]`. Błąd mówił „nakładka: reklama/baner/modal”.
3. Replan dał warunek `text_contains: "serenad"` na stronie, której tytuł już to słowo zawierał. Etap „treść odczytana” zaliczył się po pierwszej dowolnej akcji.
4. Opis filmu („Zamawiasz Spider-Mana, a przychodzi to. Ale serce się liczy.”) był na ekranie po zamknięciu reklamy, ale nie trafił do notatek ani raportu.
5. Sima znowu zapisała nauczkę o narzędziu („reklamy, których nie da się zamknąć”) → krok 11.

**Zrobione po powtórce** (ten sam dzień): punkty 1–3 naprawione, do tego **krok 7** (ramki jako `[N]`, nowe karty). Na żywym joemonster.org reklama na stronie filmu dostaje `[1001] button "(ikona: zamknij)"` i klik po numerze ją zamyka. Punkt 4 i status `ok` to zakres kroków 8–10.

**Druga powtórka (po kroku 7):** joemonster ✓ (reklama zamknięta, 8 kroków), xkcd ✓ w 2 krokach, leafly ✗ merytorycznie. Z eventów:

- leafly: planner dał etapowi „Filtr ustawiony” warunek `url_contains: leafly.com/strains`, etapowi „Dane odczytane” `text_contains: THC`, a etapowi „odmiana inna niż Gelato” regex pasujący do `/strains/lists`. Wszystkie trzy zaliczyły się same, zanim cokolwiek zrobiono. Raport: „Filtr Hybrid został użyty” przy trzech krokach bez żadnego filtra.
- xkcd: „Opis komiksu odczytany” zaliczony z samego adresu; opis fabuły zmyślony z obrazka.

Czyli warunki z adresu nadają się tylko do stanu strony. To potwierdziło B2 (typy wymagań) i zdecydowało o kształcie kroku 9.

**Faza 2 (kroki 8–12): wdrożona.**

| Krok | Jak wyszło w kodzie |
|---|---|
| 8 | `Stage.kind`: `state` / `action` / `info`; `check` tylko dla `state`; planner ma zakaz gubienia poleceń z celu |
| 9 | decydent rozlicza etapy w `done.stages` (krok albo cytat); executor sprawdza dowody; jedno podejście naprawcze (8 kroków); `blocked` → od razu `partial`; informacja bez cytatu → `?`, status zostaje `ok` |
| 10 | raport: `WYMAGANIA`, `DOWODY Z EKRANU`; UI: `⚠ częściowo · N/M wymagań`, weryfikacja w przebiegu |
| 11 | reguła w ekstrakcji pamięci: potknięcia wykonawcy to nie nauczki o stronie |
| 12 | `<done_when>` od sima; wymaganie zgubione przez planner wraca jako etap; zaliczone przetrwa replan |

Sędziego haiku nie ma (B3): rzeczy rozmyte ocenia Sima na podstawie `?` w raporcie.

**Znane ograniczenia, do obserwacji w testach:**

- „Jeden krok nie jest dowodem dwóch etapów” może odrzucić uczciwy przypadek, gdy planner rozbije jedną akcję na etap-akcję i etap-stan. Planner ma tego nie robić; jeśli będzie, poluzować regułę.
- Cytat musi być z tekstu strony w jej języku. Decydent, który tłumaczy („hybryda” zamiast „Hybrid”), dostanie `?`.
- Wszystko powyżej jest sprawdzone testami na atrapie i na Chromium, ale **nie z prawdziwym modelem**. Trzecia powtórka trzech zadań jest kryterium odbioru.


## F. Znaczniki na zrzucie: dlaczego nie teraz

Znaczniki (set-of-marks) pomagają modelowi, który **celuje po pikselach**: widzi obraz, musi wskazać miejsce. Nasz decydent celuje po liście z DOM (`click [63]` idzie po selektorze), więc trafianie już mamy. Znaczniki dawałyby tylko skojarzenie „ten numer to ten przycisk na obrazie”.

Koszty są konkretne:

- 70 etykiet na zrzucie zasłania treść, którą decydent z tego zrzutu czyta. A dziś zrzut to jego główne źródło treści poniżej pierwszych 1800 znaków.
- Haiku słabo czyta drobne etykiety, więc zysk jest niepewny.
- Userowi w panelu trzeba pokazać czysty zrzut, czyli dwa zrzuty na krok albo etykiety w panelu.
- Wstrzykiwanie elementów w cudzą stronę co krok to nowe źródło dziwnych błędów.

Trzy tańsze rzeczy załatwiają to, po co znaczniki miały być:

1. **Ramki jako `[N]`** (krok 7): problem z 20.11 to był X bez numeru. Z numerem nie trzeba celować.
2. **`click_at` mówi, w co trafił** (krok 3): przed kliknięciem `elementFromPoint` w tym punkcie, a do efektu akcji idzie „trafiłeś w: `iframe#ad`” albo „w: `body` (nic klikalnego)”. 16 ślepych prób z 20.11 skończyłoby się po drugiej.
3. **Lepsze nazwy elementów bez nazwy**: dla ikon i przycisków bez tekstu dodać `title`, `aria-label` z potomków, nazwę ikony z klasy oraz położenie („prawy górny róg”). Mieści się w kroku 4.

Kiedy wrócić do znaczników: jeśli po fazie 1 w logach zostaną pomyłki typu „kliknął nie ten element spośród podobnych”. Wtedy w wersji celowanej: etykiety tylko dla elementów bez nazwy albo z powtórzoną nazwą, najwyżej kilkanaście na zrzut.

## D. Testy

- **Strona-atrapa dla OVERLAY** (lokalny HTML w Playwright): przezroczysty kontener `fixed` na cały ekran z paskiem na dole → oczekiwany `STICKY_BANNER`, nie `OVERLAY 99%`; pełnoekranowa reklama → `OVERLAY`; wysoki kontener treści → brak hintu. Selftest na atrapie przeglądarki tego nie złapie, bo błąd siedzi w `observe-script`.
- **Selftest executora**, po scenariuszu na zadanie: przekierowanie (`navigate A` → URL `B`, etap z `url_matches` zalicza się sam, brak drugiego `navigate`); `done` z niespełnionym wymaganiem typu akcja → `partial` z listą; klik z błędem „brak elementu” przy zmienionym URL → efekt „strona przeszła na Y”.
- **Powtórka trzech zadań na żywo** jako kryterium odbioru: xkcd w ≤ 2 krokach, joemonster bez ani jednego `click_at` po zamknięciu reklamy, leafly z klikniętym filtrem albo `partial` z powodem.

## E. Pytania sprawdzone (24.11.2026)

### E1. `visible()` znaczy „wyrenderowany”, nie „w widoku”

[observe-script.ts:9-15](../plugins/computer/src/observe-script.ts): element przechodzi, gdy ma ≥ 2×2 px i nie jest ukryty stylem (`display`, `visibility`, `opacity`). Pozycji względem ekranu nie sprawdza. Dla elementów klikalnych jest osobna flaga `inViewport` (linia 64), tekst jej nie używa.

Skutki dla tekstu strony (linie 86-95):

- to zawsze **pierwsze 1800 znaków w kolejności DOM**, od góry dokumentu. Przewijanie nic nie zmienia: po `scroll down` decydent dostaje ten sam tekst, a nowe treści widzi tylko na zrzucie;
- zbierane są tylko `h1–h3, p, li, td, th, [role=alert], [role=status]`. Strona zbudowana z samych `div`/`span` (częste w SPA) daje prawie pusty tekst;
- każdy fragment cięty do 220 znaków, więc długi akapit artykułu urywa się w połowie zdania.

Czyli A4 potwierdzone, a zmiana jest prosta:

1. tekst dla decydenta = najpierw to, co **w widoku** (ten sam warunek co `inViewport`), potem ewentualnie nagłówki spoza widoku jako spis treści strony;
2. osobno, tylko do weryfikacji, pełny `document.body.innerText` trzymany w executorze;
3. limit 220 znaków na fragment podnieść dla `p` w widoku (np. do 600).

### E2. Znaczniki `[N]` na zrzucie: nie ma ich w kodzie

Stan faktyczny:

- w `plugins/computer/src` nie ma ani rysowania etykiet na stronie przed zrzutem, ani `page.frames()`, ani `context.on("page")`;
- historia gita dla pluginu to dwa commity (`75a79d5` Initial, `46eb3cb` z dziś), bez stasha i bez innych gałęzi. Nic nie zaginęło, to **nie zostało zaczęte**;
- pomysł jest zapisany tylko w notatce z 20.11 („set-of-marks z DOM: querySelectorAll → etykiety → screenshot → usuń; obserwacja w iframe'ach przez `page.frames()`”). Z tamtej listy weszły `occluded`, hint OVERLAY i `explainActionError`; znaczniki, iframe'y i popupy nie.

Co istnieje i się przyda: każdy element z listy dostaje już atrybut `ATTR` z numerem (linia 19 czyści stare, potem nadaje nowe), więc `click [N]` trafia po selektorze. Brakuje tylko warstwy wizualnej i ramek.

Jak to złożyć, w kolejności od najtańszego:

| Krok | Co daje | Koszt |
|---|---|---|
| **Elementy z iframe'ów jako zwykłe `[N]`**: `page.frames()`, ten sam skrypt obserwacji w każdej ramce, współrzędne przesunięte o pozycję ramki, klik przez `frame.locator` | „Zamknij x” reklamy OLX staje się `[N] button "Zamknij x"`; `click_at` przestaje być potrzebny do reklam | średni; ramki cross-origin Playwright obsługuje, bo działa poza stroną |
| **Znaczniki na zrzucie**: przed `screenshot()` wstrzyknąć małe etykiety `[N]` przy elementach w widoku, po zrzucie usunąć | decydent widzi na obrazie, który numer to który przycisk; mniej pomyłek typu „klik [63] drugi raz” | mały; uwaga, żeby etykiety nie zmieniały układu (`position: fixed`, `pointer-events: none`) i nie trafiały do zrzutu pokazywanego userowi w panelu |
| **Popupy** (A3) | zamknięta i zgłoszona nowa karta | mały |

Proponuję ramki przed znacznikami: 20.11 problemem było trafienie w X bez numeru (16 prób), a nie mylenie numerów. Znaczniki mają sens dopiero, gdy X ma numer.

### E3. Pamięć Simy wyczyszczona

Decyzja Kacpra: czysta karta do testów. `agents/sima/memory.md` zawiera teraz tylko nagłówek. Wcześniejsze wpisy były testowe, w tym:

- fałszywe nauczki z błędów executora („losowanie xkcd może się zacinać”, „link na Leafly może nie działać”), patrz A2a;
- dwa wpisy „(mock) Tester pytał…” z dzisiejszego testu shimmera: instancja `--mock` miała osobny `QWE_DATA_DIR`, ale wspólny katalog `agents/`.

Wniosek do testów: instancja testowa potrzebuje też własnego `QWE_AGENTS_DIR`.

### E4. Kolejność

Obowiązuje tabela C: tekst z widoku to krok 4, ramki i popupy krok 7, znaczniki na zrzucie odłożone (F).
