---
title: Status i roadmapa
description: Co działa, co jest częściowe, co zaplanowane — na podstawie kodu.
sidebar:
  order: 1
---

Zasada tej strony: **„Działa” = jest w kodzie i ma ścieżkę wywołania.** Plany są oddzielone od tego, co istnieje. Stan na **17.11.2026**.

## Działa

| Funkcja | Gdzie |
|---|---|
| Rozmowy z wieloma simami, `@sim`, `@sim.task`, `@user`, łańcuch sim→sim (max 3) | `packages/core/src/mentions.ts`, `apps/chat/src/session.ts` |
| Simy jako foldery, CRUD w UI i REST, Sima domyślna i nieusuwalna | `apps/chat/src/bots.ts`, `packages/core/src/manifest.ts` |
| Workflowy rozmów | `apps/chat/src/store.ts`, `bots.ts` (`conversationPrompt`) |
| Serwery MCP: wiele serwerów (stdio i HTTP) jako narzędzia simów, dostęp per sim, UI | `packages/mcp`, `packages/core/src/mcp.ts`, `apps/chat/src/mcp.ts` |
| Kontrakt `<nativeapi>`: direct + plan z `after`, równoległość, skip, anulowanie | `packages/core/src/nativeapi.ts`, `plan.ts` |
| Agent server: taski, pause/resume/cancel, SSE, screenshoty, dashboard | `apps/agent/src/*` |
| Leniwy start agenta, tryby `spawn` / `url` | `apps/chat/src/agent-link.ts` |
| `web.query` z łańcuchem providerów | `plugins/web` |
| `computer.run` w przeglądarce: planner, pętla, pętle/replan, notatki, raport, human-in-the-loop, potwierdzenia z `details` | `plugins/computer` |
| `skill.save` | `plugins/skills` |
| Pamięć: fakty user/sim, kroczące streszczenie, recapy, `memory.search` | `apps/chat/src/bots.ts`, `context.ts`, `recall.ts` |
| Głos: VAD → STT → TTS, kropka, command router | `packages/voice`, `apps/chat/public/ui/kropka.js`, `packages/core/src/text.ts` |
| Desktop etap 1: okno główne, widget (stany, przeciąganie, chowanie), tray, skróty, attach do działającego chatu, sprzątanie procesów | `apps/desktop` |
| Docker: `qwe build` / `qwe run` / `ps` / `logs` / `stop` | `packages/cli`, `docker/` |

## Częściowo / świeże

| Funkcja | Stan | Gdzie |
|---|---|---|
| `computer.run target="desktop"` (macOS) | Zaimplementowane: helper Swift, most, `DesktopDriver`, `GUARDED_APPS`, wybór ekranu, uprawnienia w trayu. Świeże, bez selftestu dla desktopu. | `apps/desktop/helper`, `plugins/computer/src/desktop.ts` |
| Dashboard agenta | Działa, ale w starym wyglądzie (pokazuje tylko nazwę sima przy tasku i w evencie) | `apps/agent/public` |
| Widget a wszystkie rozmowy | Widget widzi rozmowy z pracującymi simami, ale nie ma jeszcze kolejki „czeka na Ciebie” z kilku simów naraz | `apps/chat/public/ui/widget.js`, `ws.ts` |
| Nowy plugin sima bez restartu | Unia capability ładuje się tylko na starcie agenta | `apps/agent/src/index.ts` |

## Planowane

**Tego nie ma w kodzie:**

| Plan | Obszar |
|---|---|
| **Kolejka „czeka na Ciebie”** w widgecie: kilka simów naraz czeka na decyzję — widget pokazuje je po kolei, z każdej rozmowy. Wymaga skróconego eventu `activity` w lobby (`sessionId`, sim, `taskId`, stan, krok, `screenshotId`, powód czekania) | desktop, chat WS |
| **Polecenie z widgetu z kontekstem**: aktywna aplikacja, tytuł okna, zrzut tylko przy wysłaniu (chipy wyłączalne); stany „polecenie” i „słucha”; endpoint z kontekstem, bo adapter LLM dokłada dziś tylko jeden obraz do ostatniej wiadomości | desktop, chat |
| Ruch myszą usera = pauza agenta, kursor agenta z imieniem, ramka ekranu w kolorze sima | computer (desktop) |
| Koordynaty 0..1 z vision jako fallback na desktopie | computer (desktop) |
| **Pakowanie**: electron-builder, **Chromium Playwrighta w paczce** (nie zakładamy Chrome'a u usera), bundle id (np. `pl.quak.simbot`), podpis Developer ID i notaryzacja (konto Apple Developer) | desktop |
| MCP: OAuth dla zdalnych serwerów, stary transport HTTP+SSE, sampling / elicitation (serwer → model / user), subskrypcje zasobów | [Serwery MCP](/capabilities/mcp/#klient-qwemcp) |
| Alternatywny backend planu jako DAG (kontrakt `PlanStep[]` → `StepResult[]` już jest) | core |
| Streaming STT, barge-in (`user.interrupt` → `voice.abort` już jest w eventach) | głos |
| Dashboard agenta w nowym wyglądzie (tokeny chatu, awatary simów) | agent |
| Architecture Explorer w tym portalu: graf modułów → docs → interfejsy → kod | docs |

Świadomie odłożone: agent w Dockerze dla wersji desktop — desktop używa agenta na hoście (zob. [Desktop](/components/desktop/)).
