---
title: Chat REST
description: HTTP API chat servera (:3100) — konfiguracja, profil usera, simy, workflowy, rozmowy, sterowanie zadaniami, screenshoty.
sidebar:
  order: 1
status: implemented
sources:
  - apps/chat/src/index.ts
---

Bazowy adres: `http://127.0.0.1:3100`. JSON w obie strony. Błędy: `{ "error": "…" }` z kodem 400 / 404 / 500 / 502. Brak autoryzacji — serwer słucha tylko na `127.0.0.1`.

## Konfiguracja i zdrowie

| Metoda | Ścieżka | Odpowiedź |
|---|---|---|
| `GET` | `/api/config` | `{ mock, llm, voice, agent: { url, mode, status }, me, bots[], sima, builtinAvailable, workflows[] }` — bootstrap UI; Electron używa go też do wykrycia działającego chatu |
| `GET` | `/healthz` | `{ ok: true }` |

## User

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/me` | — | profil: `{ name, slug, look: { color, avatar } }` |
| `PUT` | `/api/me` | `{ name?, look?: { color?, avatar? } }` | imię (max 40 zn.) → slug liczony automatycznie |
| `GET` | `/api/me/memory` | — | `{ lines: string[] }` — wspólna pamięć o userze |
| `PUT` | `/api/me/memory` | `{ lines: string[] }` | nadpisuje pamięć o userze |

## Simy

CRUD dookoła folderów `agents/<name>`.

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/bots` | — | `{ bots[], sima, builtinAvailable }` (Sima osobno) |
| `POST` | `/api/bots` | `{ name, description?, persona?, look?, builtin? }` | tworzy sima → 201 |
| `GET` | `/api/bots/:name` | — | widok sima |
| `PATCH` | `/api/bots/:name` | `{ description?, persona?, look?, builtin?, memoryEnabled?, model? }` | edycja |
| `DELETE` | `/api/bots/:name` | — | usuwa sima; rozmowy zostają, sim z nich znika. Simy nie da się usunąć |
| `POST` | `/api/bots/:name/skills` | `{ name, body, description? }` | zapisuje / nadpisuje skill |
| `DELETE` | `/api/bots/:name/skills/:skill` | — | usuwa skill |
| `PUT` | `/api/bots/:name/memory` | `{ lines: string[] }` | nadpisuje `memory.md` |

## Workflowy

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/workflows` | — | `{ workflows[] }` |
| `POST` | `/api/workflows` | `{ name, body? }` | → 201; nazwa max 60 zn. |
| `PATCH` | `/api/workflows/:id` | `{ name?, body? }` | edycja |
| `DELETE` | `/api/workflows/:id` | — | usuwa i odświeża listę rozmów w lobby |

## Serwery MCP

Tylko z własnego UI: `Host` lokalny, `Origin` (jeśli jest) równy `Host` — inaczej `403`. Szczegóły: [Serwery MCP](/capabilities/mcp/).

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/mcp` | — | `{ servers[], agent }`. Serwer: `name`, `transport`, `config` (wartości `env`/`headers` zamaskowane), `state` (`connected` · `connecting` · `error` · `disabled` · `idle` · `sleeping` = agent śpi), `error`, `serverInfo`, `instructions`, `tools[]`, `resources[]`, `prompts[]`, `sims[]`. Nie budzi agenta. |
| `PUT` | `/api/mcp/:name` | `{ config, sims? }` | dodaje / zmienia serwer, zapisuje `data/mcp.json`, budzi agenta i łączy → `{ server, agent }`. `sims` ustawia `capabilities.mcp` w manifestach. Maska w `env`/`headers` = bez zmian. |
| `DELETE` | `/api/mcp/:name` | — | usuwa serwer z konfiguracji i z manifestów simów |
| `POST` | `/api/mcp/:name/reconnect` | — | zamyka i łączy od nowa → `{ server, agent }` |

`PATCH /api/bots/:name` przyjmuje też `mcp: string[]` (serwery sima).

## Modele (LLM)

Wybór z przycisku modelu pod polem wiadomości. Zapis w `settings` (`llm`), przełączenie w locie w chacie i w agencie.

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/llm` | — | `{ mock, selection, chat, tools, anthropic: { available, models[] }, ollama: { url, installed, running, version?, models[] } }`. `chat` / `tools` = `ModelCaps` (`provider`, `model`, `vision`, `ctx`, `mock`). Model Ollamy: `id`, `size`, `params`, `family`, `vision`, `ctx` |
| `PUT` | `/api/llm` | `{ chat: { provider, model }, tools?: { provider, model } \| null }` | zapisuje wybór; `tools` puste = ten sam model. Sprawdza, czy model istnieje (Ollama: `/api/show`; Claude: klucz API). Bez `chat` = powrót do env → `{ selection, chat, tools }` |
| `POST` | `/api/llm/ollama/start` | — | uruchamia Ollamę (`open -a Ollama` na macu, inaczej `ollama serve`), czeka do 15 s. Tylko z UI |
| `POST` | `/api/llm/ollama/pull` | `{ model }` | pobiera model; odpowiedź NDJSON: `{ status, total?, completed? }` … `{ done: true }` albo `{ error }`. Tylko z UI |

## Agent

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/agent/status` | `{ status: "up" \| "starting" \| "down", url }` — sprawdza `/health` agenta |
| `POST` | `/api/agent/start` | `AgentLink.ensure()` — podnosi agenta teraz |

## Rozmowy

| Metoda | Ścieżka | Body | Opis |
|---|---|---|---|
| `GET` | `/api/sessions` | — | lista do sidebara ze stanem, snippetem, nieprzeczytanymi |
| `POST` | `/api/sessions` | `{ title?, bots?: string[], workflowId? }` | → 201; bez `bots` → rozmowa z Simą |
| `GET` | `/api/sessions/:id` | — | odtworzenie wątku (niżej) |
| `PATCH` | `/api/sessions/:id` | `{ title?, bots?, workflowId? }` | zmiana tytułu (ręczny tytuł blokuje auto-tytuł z recapu), składu, workflow |
| `DELETE` | `/api/sessions/:id` | — | zamyka i usuwa (razem z folderem plików) |
| `GET` | `/api/sessions/:id/files?dir=` | — | `{ dir, entries[] }` — zawartość folderu (`dir` = ścieżka względna, puste = korzeń; foldery najpierw): `name`, `path`, `type` (`dir` · `file`), `size`, `mtime`, `kind` (`image` · `pdf` · `text` · `other`), `w`/`h`, `items` (folder). `?all=1` — wszystko rekurencyjnie (maks. 2000). 404, gdy folderu nie ma |
| `POST` | `/api/sessions/:id/files?name=&dir=` | surowe bajty | zapis do folderu `dir` (maks. 25 MB; nazwa zajęta → „x (2).png”) → 201 + `FileInfo` (`name` = ścieżka względna). Tylko z UI |
| `POST` | `/api/sessions/:id/files/mkdir` | `{ parent?, name? }` | nowy folder (domyślnie „nowy folder”, zajęte → „(2)”) → 201 `{ path }`. Tylko z UI |
| `POST` | `/api/sessions/:id/files/move` | `{ from, to }` | zmiana nazwy albo przeniesienie (pliku lub folderu); `to` = pełna nowa ścieżka. Błąd, gdy cel istnieje albo folder do własnego środka → `{ path }`. Tylko z UI |
| `POST` | `/api/sessions/:id/files/delete` | `{ paths[] }` | usuwa pliki / foldery (rekurencyjnie, trwale; maks. 500) → `{ removed }`. Tylko z UI |
| `GET` | `/api/sessions/:id/files/:path` | — | plik (ścieżka zakodowana `encodeURIComponent`, `/` jako `%2F`): obrazy i PDF jako takie, tekst/HTML/SVG jako `text/plain`, reszta do pobrania (`nosniff`; `CSP: sandbox` poza PDF — z nim przeglądarka PDF pokazuje pustą stronę) |
| `POST` | `/api/sessions/:id/files/open` | `{ path? }` | Finder / menedżer plików: bez `path` folder rozmowy, z `path` — ten element (na macOS zaznaczony, `open -R`). Tylko z UI |
| `POST` | `/api/sessions/:id/control` | `{ op: "pause" \| "resume" \| "cancel", taskId? }` | sterowanie zadaniem (bez `taskId` — aktywne zadanie rozmowy) |

Odpowiedź `GET /api/sessions/:id`:

```json
{
  "session": { "id": "…", "title": "…", "members": ["sima"], "workflow_id": null, "unread": 0 },
  "workflow": null,
  "state": "idle",
  "activeTaskId": null,
  "messages": [{ "id": "…", "role": "assistant", "author": "sima", "content": "…", "meta": null, "at": "…" }],
  "events": [{ "seq": 1, "type": "task.started", "at": "…", "taskId": "…" }]
}
```

Treść wiadomości `role: "tool"` jest pusta w odpowiedzi — pełne wyniki zostają w bazie, UI odtwarza karty z `events`.

## Screenshoty

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/screenshots/:id` | najpierw plik z `data/screenshots/` (działa, gdy agent śpi), potem proxy do agenta; `cache-control: max-age=86400`; 502, gdy agent offline |

## UI

`GET /` → `index.html`, `GET /*` → pliki z `apps/chat/public/` (`vendor/` z długim cache). WebSocket: [Chat WebSocket](/api/chat-ws/).
