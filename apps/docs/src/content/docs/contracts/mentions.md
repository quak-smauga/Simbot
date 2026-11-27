---
title: "Mentions (@)"
description: Adresowanie w rozmowie — @sim, @sim.task, @user, cytat @nazwa:, łańcuch sim→sim, przejęcie rozmowy, @[plik].
sidebar:
  order: 2
status: implemented
sources:
  - packages/core/src/mentions.ts
  - apps/chat/src/session.ts
  - apps/chat/public/ui/mentions.js
---

`@` to jedyny sposób adresowania w rozmowie z wieloma simami.

| Zapis | Kto pisze | Efekt |
|---|---|---|
| (bez @) | user | odpowiada **prowadzący** (pierwszy członek rozmowy): sim, którego user zawołał ostatnio |
| `@sim …` | user | sim odpowiada (akcja `ask`) i **zostaje prowadzącym** (przy kilku @ — pierwszy z nich) |
| `@sim …` na początku zdania / linii / punktu | sim | sim odpowiada raz; prowadzący się nie zmienia |
| `… napisał @sim …` (w środku zdania) | sim | **nie woła** — to wzmianka (`Mention.opens = false`) |
| `` `@sim` ``, blok ```` ``` ````, cytat `> …`, cudzysłów `„@sim”` / `"@sim"` | user / sim | **nie woła** — to omawianie (`maskQuoted()`) |
| `Księgowy, …` / `hej Simo, …` (głos, bez @) | user | woła tego sima — `voiceAddress()`: nazwa (albo wołacz na -o) jako pierwsze słowo transkrypcji |
| `@sim.task …` | user | **zlecenie**: dopisek do promptu „wykonaj narzędziami bez dopytywania, na końcu zaraportuj” |
| `@kacper …` | sim | event `mention.user` → toast; w nieoglądanej rozmowie `notify` w lobby |
| `@nazwa: …` | (cytat) | **nie woła** — stary format cudzych wypowiedzi w prompcie |
| `@sim` spoza rozmowy | user | **przejmuje rozmowę**: dołącza jako prowadzący i odpowiada; Sima (pośrednik) wychodzi, inni simy zostają |
| `@sim` spoza rozmowy | sim | nie odpowiada; `mention.absent` → UI proponuje „dodaj” |
| `@[ścieżka]` | user | plik albo folder z folderu rozmowy w tej turze — nie wołanie sima, zob. [Pliki rozmowy](/capabilities/files/) |

```ts
// user: "@ksiegowy.task wystaw fakturę, @audytor patrz na ręce"
resolveTargets(text, { members: ["ksiegowy", "audytor"], known: [...], user: "kacper" })
// → bots: [{ name: "ksiegowy", action: "task" }, { name: "audytor", action: "ask" }]
```

## Reguły `resolveTargets()`

- Nazwy porównywane małymi literami; dozwolone `[a-z0-9-]`.
- Ta sama nazwa liczy się raz; sim nie woła sam siebie (`from`).
- Gdy pisze sim (`from`), liczą się tylko wzmianki otwierające zdanie, linię albo punkt listy (`opens`) — „jak pisał @sima” to wzmianka. User woła z dowolnego miejsca.
- Nieznana nazwa → `unknown`; znana, ale spoza rozmowy → `absent`, chyba że `adopt: true` i pisze user — wtedy `bots` z `joined: true`.
- Chat server woła `resolveTargets` dla usera z `adopt: true` (po wycięciu `@[…]`); `joined` → `Session.takeOver()`: nowi na początek składu, Sima wychodzi (o ile nie była też wołana), jeden event `session.members` z `joined` i `left`.
- Nikt z rozmowy nie zawołany **i pisze user** → prowadzący. Sim bez `@` nikogo nie woła.
- Akcje to rejestr `MENTION_ACTIONS` (dziś: `ask`, `task`) — nowa akcja = nowy wpis z promptem.

## Prowadzący

Prowadzący to `members[0]` i jest „przyklejony”: zmienia go tylko user — `@sim` w wiadomości (`Session.setLead()`), chip „Odpowiada: @sim” nad polem (WS `{ t: "lead", bot }`), dodanie sima albo przejęcie rozmowy. Zmiana idzie eventem `session.members` z `lead` i `prev`; UI rysuje w wątku linię „@sima → @ksiegowy · prowadzi”. `resolveTargets()` zwraca `defaulted: true`, gdy nikt nie był zawołany wprost — wtedy prowadzący się nie zmienia.

Sim w prompcie dostaje regułę: żeby zawołać sima, zaczyna zdanie od `@nazwa`; wspominając kogoś, pisze nazwę bez `@`.

## Historia w prompcie: `<msg from to>`

W rozmowie z więcej niż jednym simem (`BotRunnerOptions.room`) wiadomości usera i innych simów idą do modelu jako

```xml
<msg from="kacper" to="ksiegowy">
@ksiegowy policz VAT
</msg>
```

`to` ustala aplikacja, nie model: u usera to `meta.to` zapisane przy wiadomości (kto odpowiadał — zawołani albo prowadzący), u sima — kogo zawołał według tych samych reguł (`opens`, bez kodu i cytatów). Własne wypowiedzi sim widzi jako zwykłe tury `assistant`. Rozmowa 1:1 — wiadomości usera bez znacznika. Sim pisze zwykły tekst, bez znaczników.

## Łańcuch sim → sim

Odpowiedź sima jest przepuszczana przez ten sam parser (`from` = ten sim). Wołani simy odpowiadają po nim i widzą jego wypowiedź. Limit: domyślnie **3 przekazania** po wiadomości usera (`CHAIN_DEFAULT` w `session.ts`); workflow rozmowy zmienia go linią `łańcuch: 20` albo `łańcuch: bez limitu` (do Stopu, bezpiecznik `CHAIN_HARD` = 100) — `chainLimitOf()`. Na limicie event `chain.limit` → linia w wątku z przyciskiem **Kontynuuj** (WS `chain.continue`).

**Stop**: przycisk wysyłania zamienia się w Stop, gdy simy myślą/mówią, a pole jest puste. Stop i Esc (WS `interrupt`) przerywają bieżącą wypowiedź i kończą łańcuch; nowa wiadomość usera też kończy łańcuch (po bieżącej wypowiedzi) i ma pierwszeństwo. Zadania komputera trwają — te anuluje się wprost.

## Slug usera

`userSlug("Kacper Walczak")` → `kacper`: pierwsze słowo, bez polskich znaków, `[a-z0-9-]`; puste → `ty`. Slug jest w `settings.me` i w prompcie (`{{USER_SLUG}}`).
