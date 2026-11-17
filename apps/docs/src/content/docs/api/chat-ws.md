---
title: Chat WebSocket
description: /ws?session=<id>|lobby — lustro busa rozmowy, wiadomości klienta, binarne audio i ramki głosu.
sidebar:
  order: 2
status: implemented
sources:
  - apps/chat/src/ws.ts
  - apps/chat/src/hub.ts
  - apps/chat/src/events.ts
  - apps/chat/public/ui/net.js
---

Jeden endpoint, dwa tryby: **rozmowa** (`/ws?session=<id>`) i **lobby** (`/ws?session=lobby`). Wiele kart może patrzeć na jedną rozmowę.

## Rozmowa

### Serwer → klient

JSON `{ t: "<event>", ...payload }`. Na start `hello`:

```json
{ "t": "hello", "sessionId": "…", "state": "idle", "voice": false, "members": ["sima"],
  "workflow": null, "mock": false, "sampleRate": 16000, "ttsSampleRate": 24000,
  "agentUrl": "http://127.0.0.1:7777", "activeTaskId": null }
```

Potem mirror eventów busa rozmowy (`MIRROR` w `ws.ts`):

| Grupa | Eventy |
|---|---|
| sim | `agent.state` · `agent.thinking` · `agent.error` · `bot.turn` · `assistant.message` |
| mowa | `say.start` · `say.text` · `say.end` · `voice.end` |
| narzędzia | `tool.call` · `tool.result` (bez pełnego tekstu; `found` dla `memory.search`) |
| user | `user.text` · `user.heard` · `user.level` (max 10/s) · `user.command` |
| rozmowa | `session.voice` · `session.title` · `session.members` · `session.workflow` · `memory.saved` · `mention.user` · `mention.absent` · `log` |
| z agenta | każdy `AgentEvent` spłaszczony: `{ t: e.type, agent: true, seq, at, taskId, stepId, planId, ...e.data }` |

Payloady eventów busa: `apps/chat/src/events.ts` (`ChatEvents`) i [Eventy](/events/).

### Klient → serwer

| Wiadomość | Działanie |
|---|---|
| `{ t: "text", text }` | wiadomość usera (dispatch `@`) |
| `{ t: "voice", on }` | włącz / wyłącz głos |
| `{ t: "played", sayId }` | klient odtworzył kwestię |
| `{ t: "interrupt" }` | przerwij mowę |
| `{ t: "reset" }` | reset rozmowy |
| `{ t: "member.add", bot }` / `{ t: "member.remove", bot }` | skład rozmowy |
| `{ t: "workflow", workflowId }` | workflow (`null` = brak) |
| `{ t: "control", op, taskId? }` | `pause \| resume \| cancel` → odpowiedź `{ t: "control.result", op, … }` |
| *binarnie* | PCM s16le 16 kHz z mikrofonu |

Błąd obsługi → `{ t: "error", message }`. Nieznana rozmowa → `error` i zamknięcie połączenia. Podłączenie oznacza rozmowę jako przeczytaną. Zamknięcie ostatniego klienta tylko resetuje VAD — rozmowa żyje dalej.

### Ramki binarne

`voice.chunk` idzie jako ramka binarna (`packVoice`):

```
[u8 magic=1][u32 seq LE][u32 sampleRate LE][u8 idLen][sayId (utf8)][pcm s16le]
```

## Lobby

`/ws?session=lobby` — dla sidebara i widgetu, niezależnie od otwartej rozmowy.

| Event | Payload |
|---|---|
| `hello` | `{ lobby: true, agent: "down" \| "starting" \| "up" }` |
| `session.updated` | `{ session: SessionRow, state }` — snippet, nieprzeczytane, tytuł, skład, stan |
| `session.removed` | `{ id }` |
| `notify` | `{ sessionId, bot, text, title }` — sim zawołał usera w rozmowie, na którą nikt nie patrzy |
| `agent.status` | `{ status: "down" \| "starting" \| "up" }` |
| `mcp.status` | `{ name, state }` — serwer MCP zmienił stan albo listę narzędzi (strona „Serwery MCP” odświeża się) |
