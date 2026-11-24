# computer.run: co się gubi po drodze i jak to naprawić

Analiza trzech zadań z rozmowy „Test sidebaru i izomorfizm” (24.11.2026). Każdy wniosek jest oparty na prawdziwych eventach z `data/agent-events.jsonl` i `data/chat.db`, a nie tylko na tym, co było widać w panelu.

| Zadanie | Co miał zrobić | Co zgłosił | Co się naprawdę stało |
|---|---|---|---|
| joemonster | wejść w artykuł i opisać | `ok` | 4× klik w X reklamy bez efektu, etap „nakładka zamknięta” oznaczony jako pominięty, w panelu brak planu i etapów |
| xkcd | wylosować komiks | `ok` | 3× losowanie, bo nie rozpoznał, że przekierowanie **to jest** wynik; oba etapy „pominięte (niepotrzebne)” |
| leafly | dojść do Gelato **przez filtry** | `ok` | filtrów nie było w planie, więc nikt ich nie wymagał; status `ok`, choć w wyniku sam napisał, że filtrów nie użył |

**Sedno:** status `ok` wystawia wyłącznie decydent, mówiąc `done`. Nikt nie sprawdza, czy etapy i wymagania z celu są spełnione. Do tego część informacji (przekierowanie, efekt akcji, plan po przeładowaniu) w ogóle nie dociera ani do decydenta, ani do UI, ani do Simy.

---

## 1. xkcd: losowanie w pętli

### Przebieg (z eventów)

```
plan: 1. Strona losowego komiksu załadowana   (zrobione, gdy: URL c.xkcd.com/random/comic/ lub xkcd.com + widać komiks)
      2. Dane komiksu odczytane

1  navigate c.xkcd.com/random/comic/      → wylądował na xkcd.com/1773 „Negativity”   ✅ to JUŻ był wynik
2  wait 1500ms                             think: „jest na xkcd.com/1773, nie na losowym; spróbuj ponownie”
3  navigate c.xkcd.com/random/comic/      → xkcd.com/2609 „Entwives”
   📝 „przeglądarka nadal na wcześniej wylosowanym komiksie, nie na losowym”      ❌ błędny wniosek
4  navigate c.xkcd.com/random/comic/      → xkcd.com/309 „Shopping Teams”
   🔁 POWTARZANIE 3× (dopiero teraz executor mówi „ta akcja działa”)
   done → ok
   etap 1 „pominięty (niepotrzebny)”, etap 2 „pominięty (niepotrzebny)”          ❌ oba były zrobione
```

### Przyczyny

1. **Decydent nie wie o przekierowaniu.** Log kroku to `navigate https://c.xkcd.com/random/comic/ → ok` ([executor.ts:456](../plugins/computer/src/executor.ts)). Executor wie, że adres docelowy ≠ adres po akcji, ale tego nie mówi. Decydent widzi „wszedłem na /random, a jestem na /1773” i uznaje, że coś nie zadziałało.
2. **Wykrywanie powtarzania działa za późno.** Odpala dopiero przy 3. razie (`REPEAT_LIMIT = 3`), czyli po szkodzie. Przy przekierowaniu wystarczy powiedzieć to od razu przy pierwszym.
3. **Etapy zrobione, ale nie zaliczone → „pominięte”.** Decydent nie dał `stage_done` dla żadnego etapu, tylko od razu `done`. `finish("ok")` zamyka wszystko, co otwarte, jako `skipped` ([executor.ts:253](../plugins/computer/src/executor.ts) → `closeOpen()`), a UI i raport piszą „pominięty (niepotrzebny)”. To nieprawda: nikt tego nie sprawdził.

---

## 2. joemonster: reklama, której nie da się zamknąć

### Przebieg

```
plan: 1. joemonster.org otwarta  2. artykuł otwarty  3. treść odczytana

1  navigate joemonster.org                 OVERLAY iframe 99% ekranu                 ✓ etap 1
2  click_at (0.95, 0.02)  „zamykam reklamę”  → strona bez zmian, OVERLAY 99%
3  click [63] artykuł                       → /art/80926                              (nakładka zniknęła)
4  scroll down                              → OVERLAY div#article-box 52%            ✓ etap 2
5  click [63]  „artykuł już otwarty”        ❌ klik w ten sam link, który już otworzył
6  click_at (0.95, 0.03)  → bez zmian, OVERLAY 99%
7  click_at (0.99, 0.03)  → bez zmian
8  click_at (0.99, 0.03)  → bez zmian
   ↻ replan (brak postępu): 1. Overlay zamknięty  2. Treść odczytana
9  click_at (0.99, 0.02)  → bez zmian, OVERLAY 99%
   ✓ etap 2 „treść odczytana”, a etap 1 „overlay zamknięty” → skipped             ❌ nakładka dalej była
10 click [30] (#art-header-5)               → nakładki brak
   done → ok
```

### Przyczyny

1. **4× prawie ten sam `click_at` nie jest pętlą.** Klucz pętli to dokładne współrzędne ([executor.ts:465](../plugins/computer/src/executor.ts)): `(0.95,0.03)`, `(0.99,0.03)`, `(0.99,0.02)` to dla executora trzy różne akcje. Strona się nie zmieniała, a detektor milczał.
2. **Wynik akcji nie dociera do UI.** Event `computer.action {status: completed}` nie niesie efektu („bez zmian”, „nowa strona: X”, „nakładka dalej 99%”). Ty w panelu widziałeś 4 razy „Zamykam reklamę” i nic więcej, stąd wrażenie, że „brakuje info, co się działo”. Executor to wie (`outcome`), tylko nie wysyła.
3. **Plan i etapy znikają z panelu.** Chat zapisuje do bazy tylko część eventów agenta ([session.ts:20](../apps/chat/src/session.ts), `PERSIST_AGENT`): `computer.plan`, `computer.stage` i `computer.resumed` są poza listą. Agent wysłał 2 plany i 4 zmiany etapów, w `chat.db` jest **zero**. Na żywo panel je pokazuje, ale po przeładowaniu albo przełączeniu rozmowy już nie. Tak samo w xkcd i leafly.
4. **Zaliczanie etapu „przeskokiem”.** `stage_done` dla etapu 2 automatycznie oznacza wcześniejsze otwarte jako `skipped`, nawet gdy to był warunek (nakładka), który wciąż nie był spełniony.
5. **Sima nie mogła zweryfikować treści.** Przy `ok` raport ucina OSTATNI WIDOK do 300 znaków ([executor.ts:219](../plugins/computer/src/executor.ts)), czyli do menu strony. Opis artykułu w WYNIK pochodził z DOM, ale Sima tego nie widziała i słusznie nie chciała go powtarzać jako pewnika.

---

## 3. leafly: filtry zgubione w planie

### Przebieg

```
cel: „…wejdź do bazy odmian i znajdź Gelato. Po drodze UŻYJ FILTRÓW (typ, efekty) i sprawdź, czy działają…
      podaj, które filtry udało się kliknąć i co zmieniły”

plan: 1. leafly.com otwarta  2. Strains otwarta  3. Gelato otwarta            ❌ ani słowa o filtrach

start: OBS xkcd.com/309  (strona z POPRZEDNIEGO zadania → trafia do „ODWIEDZONE”)  ❌
1  navigate leafly.com          OVERLAY zgody cookies
2  click [141] „Zgadzam się”    → CAPTCHA_SUSPECTED                              ❌ fałszywy alarm
3  wait                          „hint CAPTCHA, czekam”
4  click [15] Strains           → URL bez zmian (SPA jeszcze nie przeszło)
5  wait                          → /strains/lists  (filtry widoczne, 📝 zanotowane)
6  click [65] „see all strains” → bez zmian
7  click [65]                    → BŁĄD „brak elementu [65]”, ale URL = /strains  ❌ klik z kroku 6 zadziałał
   ↻ replan: 1. Strains z filtrami  2. Gelato otwarta                            ❌ filtry znowu tylko „widać”
8  click [77] Gelato            → /strains/gelato   ✓ etap 1, etap 2 → skipped
   done → ok  („Filtrów nie udało się użyć…”)                                    ❌ ok mimo niespełnionego wymagania
```

### Przyczyny

1. **Planner gubi wymagania celu.** Prompt mówi „Tylko etapy, które naprawdę są potrzebne” ([planner.ts:45](../plugins/computer/src/planner.ts)). „Użyj filtrów” to dla modelu droga, a nie cel, więc wypadło. Replan też go nie przywrócił.
2. **`done` = `ok`, zawsze** ([executor.ts:356](../plugins/computer/src/executor.ts)). Decydent sam napisał w wyniku, że filtrów nie użył, a status i tak `ok`. Nie ma pola „czego nie zrobiłem”.
3. **Opóźnione SPA.** `settle()` czeka na `domcontentloaded` i krótko na `networkidle`. Leafly zmienia URL po chwili, więc obserwacja po kliku pokazuje starą stronę (kroki 4 i 6). Następny klik trafia w zmienioną stronę i dostaje „brak elementu”. Raport mówi „link się wywalił”, choć zadziałał.
4. **CAPTCHA_SUSPECTED z byle czego.** Heurystyka to `/captcha/i` na całym HTML ([observe-script.ts:101](../plugins/computer/src/observe-script.ts)). Wystarczy skrypt reCAPTCHA w stopce albo w formularzu newslettera. Decydent dwa razy czekał przez fałszywy alarm.
5. **Strona startowa z poprzedniego zadania w raporcie.** Pierwsza obserwacja idzie do `trace.visits` ([executor.ts:240](../plugins/computer/src/executor.ts)), więc xkcd 309 wisi w „ODWIEDZONE” zadania o leafly.

---

## 4. Wspólny obraz: gdzie ginie informacja

```
                 ┌──────────── executor WIE ─────────────┐
 akcja ─────────▶│ URL przed/po (przekierowanie)         │──✗──▶ decydent   (log: „→ ok”)
                 │ efekt: bez zmian / nowa strona / błąd │──✗──▶ UI         (event bez outcome)
                 │ nakładka dalej jest                   │
                 └───────────────────────────────────────┘
 plan / etapy ──▶ agent emit ──▶ chat WS (na żywo ✓) ──✗──▶ chat.db (po przeładowaniu: brak)
 done ──────────▶ status = ok ──✗── nikt nie sprawdza etapów ani wymagań celu
                                 └──▶ Sima dostaje „ok” + etapy „pominięte (niepotrzebne)”
 partial ───────▶ task.succeeded ok:false ──▶ UI pokazuje ✗ „błąd” (nie „częściowo”)
```

---

## 5. Proponowany flow

### 5.1 Wymagania zamiast samych etapów (planner)

Planner najpierw rozpisuje **cel na wymagania**: każde polecenie z celu („użyj filtrów”, „podaj THC”, „wejdź w artykuł”) to pozycja listy. Dopiero do nich dobiera etapy. Wymaganie nie może zniknąć przy replanie.

```json
{
  "requirements": [
    { "id": "R1", "text": "strona odmiany Gelato otwarta", "check": "URL zawiera /strains/gelato" },
    { "id": "R2", "text": "co najmniej jeden filtr kliknięty i opisana zmiana listy", "check": "po kliknięciu filtra zmienia się lista/URL" },
    { "id": "R3", "text": "podane: typ, THC, efekty, smaki", "check": "dane w notatkach z tej strony" }
  ],
  "stages": [ … każdy etap wskazuje, które R zamyka … ]
}
```

W promptcie: „Tylko potrzebne etapy” zostaje dla **drogi**, ale wymagań z celu nie wolno pominąć.

### 5.2 Efekt każdej akcji, wprost (executor → decydent i UI)

Po każdej akcji executor składa `outcome` z faktów, które ma:

| Sytuacja | Co dostaje decydent i UI |
|---|---|
| navigate X, URL po = Y ≠ X | `→ przekierowano na Y „tytuł”. To JEST wynik tej akcji.` |
| strona bez zmian | `→ bez zmian (ten sam URL, ta sama treść)` |
| błąd, ale URL się zmienił | `→ element zniknął, bo strona przeszła na Y (poprzedni klik zadziałał z opóźnieniem)` |
| nakładka przed i po | `→ nakładka div#x dalej zasłania 99%` |

`computer.action {status: completed}` dostaje pola `outcome` i `url`, a UI pokazuje je pod krokiem (✓ nowa strona / · bez zmian / ✗ błąd).

### 5.3 Weryfikacja przed `ok` (nowy krok na końcu)

```
decydent: done ──▶ WERYFIKACJA ──▶ wszystkie R spełnione?  ── tak ──▶ ok
                   (1 tani call:      │
                   cel + wymagania +  └─ nie ──▶ partial + lista „NIE ZROBIONE: R2 filtry (powód)”
                   ostatnia obserwacja         albo, gdy zostały kroki: 1 szansa na dokończenie
                   + notatki)
```

- Wynik weryfikacji to per wymaganie: `met | unmet | unknown` + **cytat z ekranu** jako dowód.
- Etapy niezaliczone przez decydenta nie są już „pominięte (niepotrzebne)”. Dostają `met` / `unmet` z weryfikacji. „Pominięty” zostaje tylko dla etapu, który planner przy replanie świadomie usunął.
- Decydent może sam powiedzieć `done` z `"unmet": ["filtry: link do pełnej bazy nie działał"]`. Wtedy weryfikacja tylko to potwierdza.

### 5.4 Raport dla Simy

```
STATUS: partial
WYMAGANIA:
  ✓ R1 strona Gelato otwarta — „leafly.com/strains/gelato” (URL)
  ✗ R2 filtry — nie kliknięto żadnego; link „see all strains” → /strains (zadziałał z opóźnieniem)
  ✓ R3 dane — „THC 21% · CBD 0% · Hybrid” (cytat z ekranu)
DOWODY Z EKRANU: fragmenty tekstu, na których opiera się WYNIK (zamiast 300 znaków menu)
```

Sima dostaje wprost, czego nie zrobiono i dlaczego, więc może dopytać albo puścić zadanie jeszcze raz.

### 5.5 Drobne, ale potrzebne

- **Pętla `click_at`:** klucz z zaokrąglonych współrzędnych (siatka ~5%), czyli `(0.95,0.03)` ≈ `(0.99,0.02)`. Do tego reguła: nakładka zgłoszona przed i po 2 kolejnych `click_at` → podpowiedź „X nie działa: Escape, przewiń, otwórz artykuł inną drogą”.
- **SPA:** po kliku `settle()` czeka dodatkowo do ~1,5 s na zmianę URL albo treści (porównanie sygnatury), zanim zrobi obserwację.
- **CAPTCHA_SUSPECTED:** tylko widoczny element (iframe `recaptcha`/`hcaptcha` w viewporcie, `[class*=captcha]` z wymiarami), a nie słowo w HTML.
- **Strona startowa:** pierwsza obserwacja to `START: …` w raporcie, a nie pozycja w „ODWIEDZONE”.
- **Persist:** `computer.(plan|stage|resumed)` do `PERSIST_AGENT`, żeby plan był widoczny też po przeładowaniu.
- **UI dla `partial`:** zamiast ✗ „błąd” jest ⚠ „częściowo · N/M wymagań”. Klik pokazuje, czego brakuje.

---

## 6. Kolejność wdrożenia (propozycja)

> Pierwsza wersja, przed ustaleniami. Obowiązuje [7.5](#75-kolejność-wdrożenia-zaktualizowana).

| # | Zmiana | Pliki | Efekt | Ryzyko |
|---|---|---|---|---|
| 1 | Persist `computer.plan/stage/resumed` | `apps/chat/src/session.ts` | plan i etapy widoczne zawsze | żadne |
| 2 | `outcome` + przekierowanie w logu i evencie, UI pod krokiem | `executor.ts`, `cards.js` | koniec z xkcd ×3, widać, co dała akcja | małe |
| 3 | Pętla `click_at` na siatce + reguła nakładki | `executor.ts` | koniec z 4× X | małe |
| 4 | SPA settle + błąd „element zniknął, bo strona przeszła” | `browser.ts`, `executor.ts` | leafly krok 6/7 | małe |
| 5 | CAPTCHA tylko widoczna, START poza odwiedzonymi | `observe-script.ts`, `executor.ts` | mniej fałszywych alarmów | małe |
| 6 | Wymagania w plannerze, weryfikacja przed `ok`, `unmet` w `done` | `planner.ts`, `decider.ts`, `executor.ts`, nowy `verifier.ts` | **status mówi prawdę** | średnie: +1 call LLM na zadanie |
| 7 | Raport z WYMAGANIAMI i DOWODAMI, UI ⚠ częściowo | `executor.ts`, `runtime.ts`, `cards.js` | Sima wie, czego nie zrobiono | małe |

1–5 to naprawy „informacja nie dociera”. 6–7 to zmiana kontraktu (`requirements`, `unmet`, nowe statusy etapów), więc wymaga wpisu w changelogu i aktualizacji docsów `capabilities/computer`.

## 7. Ustalenia (24.11.2026)

Zakres: **tylko tryb przeglądarki.** Desktop przenosimy, gdy ten flow sprawdzi się w praktyce.

### 7.1 Wymagania określa ten, kto zleca

Sima przy zleceniu podaje kryteria akceptacji, jak w tickecie. Planner computera planuje już tylko **drogę** do nich i nie może ich zmienić ani pominąć, także przy replanie.

```xml
<computer.run>
  Otwórz leafly i znajdź Gelato, po drodze użyj filtrów.
  <done_when>jesteś na stronie Gelato</done_when>
  <done_when>kliknięty co najmniej jeden filtr i opisane, co zmienił</done_when>
  <done_when>podane: typ, THC, efekty, smaki</done_when>
</computer.run>
```

- `<done_when>` jest per zlecenie, a nie w globalnym `<plan>`. `<plan>` dalej opisuje tylko kolejność i zależności między krokami.
- Parser `nativeapi` się nie zmienia: zagnieżdżone tagi trafiają do `args._` jako tekst ([nativeapi.ts:116](../packages/core/src/nativeapi.ts)). Plugin computer wyciąga z niego `<done_when>`, a resztę traktuje jako cel.
- Gdy Sima nie poda `done_when` (proste „wejdź na xkcd”), planner wyciąga wymagania z celu sam: każde polecenie z celu to wymaganie, którego nie wolno pominąć. Wymagania od Simy mają flagę `from: "sim"`, wyciągnięte przez planner `from: "planner"`.
- Prompt Simy (opis `computer.run` w `bots.ts`) dostaje krótką zasadę: „przy zadaniu z kilkoma częściami wypisz `<done_when>`”.

### 7.2 Weryfikacja: deklaracja decydenta → kod → haiku tylko w razie wątpliwości

Sprawdzanie własnej roboty przez wykonawcę jest słabe, bo ma ten sam kontekst i nastawienie (leafly: „filtrów nie użyłem” + `done`). Sędzia, który widzi tylko ostatni ekran, też jest słaby, bo nie zobaczy, co działo się trzy kroki wcześniej. Dlatego trzy warstwy:

1. **Decydent** w `done` musi rozliczyć każde wymaganie:
   ```json
   {"action":"done","result":"…","requirements":[
     {"id":"R1","met":true,"evidence":{"quote":"Gelato aka Gelato 42"}},
     {"id":"R2","met":false,"why":"link do pełnej bazy nie działał","category":"nie_wyszło"},
     {"id":"R3","met":true,"evidence":{"step":8}}
   ]}
   ```
2. **Kod (za darmo)** sprawdza dowody:
   - `quote` musi być dosłownie w tekście którejś obserwacji albo notatki z tego zadania;
   - `url` musi pasować do odwiedzonego adresu;
   - `step` musi istnieć i nie może być błędem.

   Dowód się zgadza → wymaganie potwierdzone. Dowód się nie zgadza albo go nie ma → „niepotwierdzone”.
3. **Haiku (`QWE_EXECUTOR_MODEL`)** dostaje tylko niepotwierdzone wymagania: cel, wymaganie, dowody, przebieg w skrócie, ostatni tekst strony. Zwraca `met | unmet | unknown` z kategorią. Przy prostych zadaniach często nie będzie wołane wcale.

Etapy przestają udawać: „pominięty (niepotrzebny)” zostaje tylko dla etapu, który planner świadomie usunął przy replanie. Etap niezaliczony przez decydenta dziedziczy wynik wymagań, które zamyka.

### 7.3 Co dalej z niespełnionym wymaganiem: zależy od powodu

| Kategoria | Przykład | Co robimy |
|---|---|---|
| mechaniczne | klik obok, SPA nie zdążyło, reklama | normalna praca pętli executora, bez osobnego retry |
| `nie_próbował` / `nie_wyszło` | leafly: filtrów nie było w planie | **jedno** podejście naprawcze w executorze: log „BRAKUJE: R2 …”, budżet `min(zostało, 8)` kroków, potem weryfikacja jeszcze raz |
| `zablokowane` | logowanie, captcha, 403, funkcji nie ma na stronie | od razu do Simy jako `partial` z powodem; Sima zmienia plan albo pyta usera |

Naprawia executor, a nie Sima, bo ma przeglądarkę na właściwej stronie, notatki i przebieg. Nowe zlecenie od Simy straciłoby ten kontekst. Sima wkracza, gdy trzeba zmienić decyzję (inny cel, inna strona, pytanie do usera). To wzorzec z ograniczoną liczbą poprawek (Reflexion / evaluator–optimizer): jedna informacja zwrotna, jedna próba, koniec.

### 7.4 Status i raport

- `ok` = wszystkie wymagania potwierdzone.
- `partial` = część niespełniona albo `unknown`; raport ma sekcję WYMAGANIA (✓ / ✗ / ? + dowód albo powód) i DOWODY Z EKRANU zamiast 300 znaków menu.
- `failed` = nic się nie udało.
- UI dla `partial`: ⚠ „częściowo · 2/3” zamiast ✗ „błąd”.

### 7.5 Kolejność wdrożenia (zaktualizowana)

| # | Zmiana | Pliki |
|---|---|---|
| 1 | Persist `computer.plan/stage/resumed` | `apps/chat/src/session.ts` |
| 2 | `outcome` + przekierowanie w logu decydenta i w evencie `computer.action`, UI pod krokiem | `executor.ts`, `cards.js` |
| 3 | Pętla `click_at` na siatce ~5% + reguła „nakładka przed i po” | `executor.ts` |
| 4 | SPA: czekanie na zmianę URL/treści po kliku; „element zniknął, bo strona przeszła na Y” | `browser.ts`, `executor.ts` |
| 5 | CAPTCHA tylko widoczna; strona startowa jako START, nie w ODWIEDZONE | `observe-script.ts`, `executor.ts` |
| 6 | `<done_when>` od Simy + wymagania w plannerze (nie do pominięcia) | `bots.ts` (prompt Simy), `index.ts` pluginu, `planner.ts` |
| 7 | `done` z rozliczeniem wymagań, weryfikacja w kodzie + haiku, kategorie, jedno podejście naprawcze | `decider.ts`, nowy `verifier.ts`, `executor.ts` |
| 8 | Raport WYMAGANIA/DOWODY, `partial` w runtime i UI (⚠ częściowo) | `executor.ts`, `apps/agent/src/runtime.ts`, `cards.js` |

1–5: informacja ma docierać. 6–8: zmiana kontraktu (`done_when`, `requirements` w `done`, kategorie, statusy etapów), więc wpis w `status/changelog.md` i aktualizacja `capabilities/computer` w docsach. Każdy punkt z testem w `plugins/computer/src/selftest.ts` na atrapie przeglądarki, po jednym scenariuszu na każde z trzech zadań z tej analizy.

### 7.6 Do sprawdzenia przy review

- Czy dosłowny cytat to nie za ostre kryterium (modele lubią parafrazować)? Może normalizacja: małe litery, bez interpunkcji, dopasowanie ≥ 90%.
- Czy budżet 8 kroków na podejście naprawcze wystarczy przy filtrach na leafly?
- Czy Sima będzie realnie pisać `<done_when>`, czy zostaje głównie ścieżka „planner wyciąga z celu”?
