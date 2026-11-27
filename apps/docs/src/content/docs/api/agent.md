---
title: Agent API
description: HTTP + SSE agent servera (:7777) — tożsamość, capability, taski, sterowanie, eventy, screenshoty, dashboard.
sidebar:
  order: 3
status: implemented
sources:
  - apps/agent/src/index.ts
  - apps/agent/src/runtime.ts
---

Bazowy adres: `http://127.0.0.1:7777` (w Dockerze nasłuch na `0.0.0.0`). Klient w praktyce: `AgentLink` w chat serverze.

## Tożsamość i stan

| Metoda | Ścieżka | Odpowiedź |
|---|---|---|
| `GET` | `/health` | `{ ok: true }` — healthcheck Dockera, bez zależności |
| `GET` | `/api/identity` | `{ instanceId, name, version, description, buildHash, startedAt, mock }` |
| `GET` | `/api/status` | `{ identity, state: "ready", mock, tasks: { queued, running, waiting_user, paused, … } }` |
| `GET` | `/api/capabilities` | `{ name, agents[], capabilities[] }` — deskryptory (chat buduje z nich prompt) |
| `GET` | `/api/capabilities/:name` | deskryptor jednej capability; 404, gdy brak |

## Taski

```http
POST /api/tasks
Content-Type: application/json

{
  "sessionId": "ses_…",
  "agent": "sima",
  "requestedBy": "chat",
  "block": { "kind": "direct", "calls": [{ "name": "web.query", "args": { "_": "pogoda Poznań" } }] }
}
```

→ `202 { "taskId": "task_…", "state": "queued" }`. Blok bez kroków → 400. `block` to [`NativeBlock`](/contracts/nativeapi/#typy) — `direct` albo `plan`.

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/tasks?sessionId=` | do 100 tasków, opcjonalnie dla rozmowy |
| `GET` | `/api/tasks/:id` | pełny [`Task`](/components/agent/#agentruntime) |
| `POST` | `/api/tasks/:id/pause` | → `{ taskId, state }` |
| `POST` | `/api/tasks/:id/resume` | wznawia pauzę albo `waiting_user` |
| `POST` | `/api/tasks/:id/cancel` | anuluje (plan zachowuje wykonane kroki) |

## Eventy

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/events?since=&limit=&sessionId=&taskId=` | log z kursorem `seq`; `limit` domyślnie 200, max 1000 |
| `GET` | `/api/events/stream?since=&sessionId=` | **SSE**: najpierw do 500 zaległych od `since`, potem na żywo; `id:` = `seq` |

Payload każdego zdarzenia SSE to [`AgentEvent`](/events/). Chat trzyma **jedno** połączenie SSE na cały proces i rozdziela eventy po `sessionId`.

## Serwery MCP

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/mcp` | `{ servers: McpServerStatus[] }` — `name`, `transport`, `state`, `error`, liczba narzędzi / zasobów / promptów |
| `POST` | `/api/mcp/reload` | czyta `data/mcp.json` od nowa: łączy nowe i zmienione, zamyka usunięte; czeka na wynik połączeń |
| `POST` | `/api/mcp/:name/reconnect` | jeden serwer od nowa; 404, gdy brak |

Narzędzia `mcp.*` nie są w rejestrze capability — runtime pyta o nie menedżera (`dynamicTool`). Patrz [Serwery MCP](/capabilities/mcp/).

## Modele (LLM)

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/llm` | `{ selection, chat, tools }` — aktualny wybór i `ModelCaps` slotów |
| `POST` | `/api/llm` | `{ selection: LlmSelection \| null }` — wysyła chat po starcie agenta i po każdej zmianie w UI. Przy spawnie wybór idzie też w env `QWE_LLM` |

## Screenshoty i dashboard

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/screenshots/:id` | obraz (`image/jpeg` / `image/png`), cache 1 dzień, CORS `*` |
| `GET` | `/` | 302 → `/dashboard/` |
| `GET` | `/dashboard/*` | podgląd na żywo (pulse rail) |
