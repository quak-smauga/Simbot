---
title: "Mentions (@)"
description: Adresowanie w rozmowie — @sim, @sim.task, @user, cytat @nazwa:, łańcuch sim→sim.
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
| (bez @) | user | odpowiada **prowadzący** (pierwszy członek rozmowy) |
| `@sim …` | user / sim | sim odpowiada (akcja `ask`) |
| `@sim.task …` | user | **zlecenie**: dopisek do promptu „wykonaj narzędziami bez dopytywania, na końcu zaraportuj” |
| `@kacper …` | sim | event `mention.user` → toast; w nieoglądanej rozmowie `notify` w lobby |
| `@nazwa: …` | (cytat) | **nie woła** — tak sim widzi cudze wypowiedzi |
| `@sim` spoza rozmowy | user | nie odpowiada; `mention.absent` → UI proponuje „dodaj” |

```ts
// user: "@ksiegowy.task wystaw fakturę, @audytor patrz na ręce"
resolveTargets(text, { members: ["ksiegowy", "audytor"], known: [...], user: "kacper" })
// → bots: [{ name: "ksiegowy", action: "task" }, { name: "audytor", action: "ask" }]
```

## Reguły `resolveTargets()`

- Nazwy porównywane małymi literami; dozwolone `[a-z0-9-]`.
- Ta sama nazwa liczy się raz; sim nie woła sam siebie (`from`).
- Nieznana nazwa → `unknown`; znana, ale spoza rozmowy → `absent`.
- Nikt z rozmowy nie zawołany **i pisze user** → prowadzący. Sim bez `@` nikogo nie woła.
- Akcje to rejestr `MENTION_ACTIONS` (dziś: `ask`, `task`) — nowa akcja = nowy wpis z promptem.

## Łańcuch sim → sim

Odpowiedź sima jest przepuszczana przez ten sam parser (`from` = ten sim). Wołani simy odpowiadają po nim i widzą jego wypowiedź. Limit: **3 ogniwa** po wiadomości usera (`MAX_CHAIN` w `session.ts`).

## Slug usera

`userSlug("Kacper Walczak")` → `kacper`: pierwsze słowo, bez polskich znaków, `[a-z0-9-]`; puste → `ty`. Slug jest w `settings.me` i w prompcie (`{{USER_SLUG}}`).
