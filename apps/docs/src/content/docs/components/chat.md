---
title: Chat server
description: apps/chat — rozmowy w SQLite, simy, pętla LLM per sim, głos, AgentLink, WebSocket i UI.
sidebar:
  order: 2
status: implemented
sources:
  - apps/chat/src/index.ts
  - apps/chat/src/hub.ts
  - apps/chat/src/session.ts
  - apps/chat/src/chat.ts
  - apps/chat/src/bots.ts
  - apps/chat/src/agent-link.ts
  - apps/chat/src/models.ts
  - apps/chat/src/files.ts
---

Serce aplikacji. Trzyma rozmowy i simy, rozmawia z modelem, prowadzi głos, zleca zadania agentowi i serwuje UI. Port `3100`.

## Struktura

```mermaid
flowchart TB
  idx["index.ts<br/>HTTP API + statyczne UI"] --> hub
  wsg["ws.ts<br/>WS gateway"] --> hub
  hub["hub.ts — SessionHub<br/>żywe rozmowy + lobby + AgentLink"] --> sess
  hub --> link["agent-link.ts — AgentLink"]
  hub --> recap["recall.ts — RecapWriter"]
  hub --> ctx["context.ts — ContextKeeper"]
  sess["session.ts — ChatSession<br/>maszyna stanów rozmowy"] --> runner["chat.ts — BotRunner<br/>tura jednego sima"]
  sess --> voice["@qwe/voice<br/>VAD · STT · TTS"]
  runner --> bots["bots.ts — BotRegistry<br/>simy, prompt, pamięć"]
  runner --> link
  idx --> store["store.ts — Store<br/>SQLite"]
  sess --> store
```

## Pliki

| Plik | Odpowiada za |
|---|---|
| `index.ts` | Boot, konfiguracja, wszystkie [endpointy REST](/api/chat-rest/), statyczne `public/`, `/healthz`. |
| `hub.ts` | `SessionHub`: rejestr żywych `ChatSession` po id, lobby (`session.updated/removed`, `notify`, `agent.status`), jeden `AgentLink` na proces. |
| `session.ts` | `ChatSession`: stan rozmowy, dispatch `@`, kolejka simów i łańcuch (max 3), głos half-duplex, command router w trakcie pracy komputera, `control(op)`, zapis eventów. |
| `chat.ts` | `BotRunner`: historia z perspektywy sima → LLM stream → `say.*` / `<nativeapi>` → task → `<nativeresult>` → LLM. |
| `bots.ts` | `BotRegistry`: simy z `agents/`, prompt systemowy (kontrakt + persona + skille + narzędzia + pamięć + kontekst rozmowy), CRUD, profil usera, auto-tworzenie Simy. |
| `context.ts` | Co z rozmowy idzie do modelu: skracanie starych wyników, kroczące streszczenie. |
| `recall.ts` | Recap rozmów po ciszy, przegląd zaległych, lokalne narzędzie `memory.search`. |
| `models.ts` | Wybór modeli: `GET/PUT /api/llm`, start Ollamy, pobieranie modeli; zapis w `settings["llm"]`, przekazanie agentowi (`AgentLink.setLlm`). |
| `files.ts` | Folder plików rozmowy (`<data>/sessions/<id>/files`, z podfolderami): zapis, lista (`listDir`, `listAll`), nowy folder, przeniesienie, usunięcie, wymiary obrazów, `@[ścieżka]` (`resolveScope`), pliki w kontekście (budżet), narzędzia `files.list` / `files.read` / `files.look`. Zob. [Pliki rozmowy](/capabilities/files/). |
| `agent-link.ts` | `ensure()` (spawn albo `/health`), `submit()` (POST + czekanie na terminalny event), jedno SSE na cały chat. |
| `store.ts` | SQLite: schemat, migracje, zapytania. Zob. [Dane](/architecture/data/). |
| `ws.ts` | [WebSocket](/api/chat-ws/): mirror busa rozmowy, binarne audio, lobby. |
| `events.ts` | `ChatEvents` — typowana mapa eventów in-process. |
| `prompts/system.md` | [Kontrakt sima](/contracts/nativeapi/#prompt-systemowy) z placeholderami `{{BOT}}`, `{{USER}}`, `{{TOOLS}}`. |

## Prompt systemowy sima

Składany w `BotRegistry.systemPrompt()`:

1. `prompts/system.md` — kontrakt: jak mówić (głos vs tekst), `@`, narzędzia i `<nativeapi>`.
2. `{{TOOLS}}` — `toolsPrompt()` z deskryptorów capability, które sim ma w manifeście, plus `memory.search` i `files.*`.
3. Skille sima (`skills/*.md`).
4. `persona.md`.
5. Migawka pamięci (fakty o userze + notatki sima) i lista ostatnich rozmów.

Poza cache'owanym blokiem dochodzi `conversationPrompt()`: kto jest w rozmowie, workflow rozmowy i tryb bieżącej wiadomości (głos / tekst, `@sim.task`).

## Rozmowa żyje bez okna

`ChatSession` nie zależy od podłączonych klientów. Zamknięcie karty przeglądarki tylko resetuje VAD; zadanie w tle dojeżdża, wiadomości i eventy trafiają do bazy, `unread` rośnie, a sim wołający `@user` w rozmowie, na którą nikt nie patrzy, wysyła `notify` do lobby.
