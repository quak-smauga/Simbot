---
title: Przewodnik utrzymania
description: Zasady pisania i synchronizacji docsów z kodem — dla ludzi i dla sesji Claude Code.
sidebar:
  order: 1
---

## Zasada nadrzędna

> Nie dokumentujemy tego, co chcielibyśmy mieć. Dokumentujemy to, co faktycznie istnieje.

- Każde zdanie techniczne da się wskazać w kodzie. Jeśli nie da się — to plan i trafia do [Roadmapy](/status/roadmap/#planowane).
- Strona techniczna ma `status` i `sources` we frontmatterze.
- Kiedy kod i README się rozjeżdżają — **wygrywa kod**. README jest krótkie i odsyła tutaj; szczegóły trzymamy tylko w docsach.

## Trzy rodzaje treści

| Rodzaj | Źródło | Jak aktualizować |
|---|---|---|
| **Architektura** (procesy, przepływy, diagramy) | analiza kodu | przy zmianie procesu, kanału albo przepływu |
| **Referencja** (API, eventy, typy, env, manifest) | typy, routery, `capability.yaml`, `.env.example` | przy każdej zmianie kontraktu — to są tabele, sprawdzaj je grepem |
| **Przewodniki** (quickstart, plugin, debug) | pisane ręcznie | gdy zmienia się sposób pracy |

## Kiedy aktualizować

Zmiana w kodzie → aktualizacja docsów **w tym samym commicie**, jeśli zmienia:

- endpoint, wiadomość WS, kanał IPC albo komendę helpera,
- typ eksportowany z `@qwe/core` albo pole manifestu / `capability.yaml`,
- nazwę eventu albo payload, na którym polega UI,
- zmienną env (także nową, tylko w kodzie),
- proces, port, sposób uruchamiania,
- stan funkcji (plan → częściowo → działa).

Wpis do [Changelogu architektury](/status/changelog/) — tylko dla zmian, po których ktoś musiałby inaczej rozumieć system.

## Checklista: nowy moduł / capability

- [ ] Strona w odpowiedniej sekcji (`components/`, `capabilities/`) z `title`, `description`, `status`, `sources`.
- [ ] Wpis w [mapie repo → docs](/maintenance/mapping/).
- [ ] Nowe endpointy / eventy / env w tabelach referencji.
- [ ] Diagram, jeśli moduł dodaje proces albo kanał (`architecture/system.md`).
- [ ] Wiersz w [Roadmapie](/status/roadmap/) we właściwej sekcji.
- [ ] Linia w `apps/docs/public/llms.txt`.
- [ ] `pnpm --filter @qwe/docs docs:build` przechodzi.

## Procedura dla Claude Code

Gdy sesja zmienia kod:

1. Ustal, których stron dotyczy zmiana — [mapa repo → docs](/maintenance/mapping/) (albo grep ścieżki pliku w `apps/docs/src/content/docs`, bo `sources` ją zawiera).
2. Zaktualizuj te strony; nie dopisuj funkcji, których nie ma w kodzie.
3. Zweryfikuj tabele referencji grepem, np.:
   ```bash
   grep -nE '\.(get|post|put|patch|delete)\(\s*"' apps/chat/src/index.ts apps/agent/src/index.ts
   grep -rhoE "(QWE|ELEVEN|SEARCH|TAVILY|BRAVE|ANTHROPIC)_[A-Z_]+" apps/*/src packages/*/src plugins/*/src | sort -u
   grep -rhoE 'emit\("[a-z]+\.[a-z_]+"' plugins/*/src apps/agent/src | sort -u
   ```
4. Zbuduj portal: `pnpm --filter @qwe/docs docs:build`.

Pełna audyt-sesja (np. raz na kilka tygodni): przejdź mapę wiersz po wierszu, porównaj z kodem, popraw rozjazdy, zaktualizuj datę na stronie [Status](/status/roadmap/).

## Styl

- Po polsku, konkretnie, krótkie zdania. Nazwy z kodu w `backtickach`.
- Tabela, gdy porównujesz kilka rzeczy w tych samych kategoriach; diagram, gdy jest przepływ albo struktura.
- Ścieżki względem korzenia repo.
- Bez marketingu i bez „wkrótce”: plan ma swoje miejsce w Roadmapie.
