---
title: Pamięć i memory.search
description: Fakty o userze, notatki sima, recapy rozmów i lokalne narzędzie memory.search bez embeddingów.
sidebar:
  order: 5
status: implemented
sources:
  - apps/chat/src/recall.ts
  - apps/chat/src/bots.ts
  - apps/chat/src/session.ts
---

Pamięć żyje w chat serverze — nie w agencie — bo potrzebuje bazy rozmów.

## Fakty po turze

Po każdej turze tani model (`QWE_EXECUTOR_MODEL`) wyciąga fakty, asynchronicznie:

- **o userze** → `settings["me.memory"]` — widzą je wszystkie simy,
- **o pracy sima** → `agents/<sim>/memory.md` — tylko ten sim (`memory.enabled`, limit `memory.max`).

Event `memory.saved { agent, scope: "user" | "sim", added[], removed[] }` → UI pokazuje, co doszło i co wyleciało. Obie listy można edytować w UI (strona sima, profil) i przez REST (`/api/me/memory`, `/api/bots/:name/memory`).

Migawka pamięci jest częścią promptu systemowego i odświeża się po 5 minutach bezczynności (cache promptu i tak wygasł).

## Recap rozmów

Każda rozmowa dostaje krótkie podsumowanie: o czym, co ustalono, konkrety. Pisze je tani model **w tle, po 90 s ciszy** (`QWE_RECAP_IDLE_MS`), nie po każdej wiadomości. Zaległe recapy (restart serwera, stare rozmowy) nadrabia przegląd przy starcie i co 5 minut (po 10 naraz). Jeśli rozmowa odjechała od tytułu, recap proponuje nowy — tylko gdy user nie nadał tytułu ręcznie.

## memory.search

```xml
<nativeapi>
  <memory.search>faktura Kowalski</memory.search>
</nativeapi>
```

- Przeszukuje **poprzednie** rozmowy wszystkich simów (bez bieżącej): tytuły, recapy, streszczenia i treść wiadomości.
- Bez embeddingów i bez FTS (`node:sqlite` go nie ma): normalizacja polskich znaków + rdzenie słów (faktura / fakturę / faktury → „faktur”).
- Zwraca 5 najlepszych rozmów z fragmentami; trafność ocenia już sam sim.
- W UI wynik jest rozwijaną kartą (`tool.result.found`).

W prompcie sim widzi tytuły 6 ostatnich rozmów, żeby wiedział, że jest do czego sięgnąć.
