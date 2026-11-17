---
title: Agent server
description: apps/agent — execution engine. Rejestr capability, taski direct i plan, lifecycle, event store, screenshoty, SSE, dashboard.
sidebar:
  order: 3
status: implemented
sources:
  - apps/agent/src/index.ts
  - apps/agent/src/runtime.ts
  - apps/agent/public/index.html
---

Proces w tle (dev: `node`/`tsx` na hoście, prod: Docker), port `7777`. Nie zna rozmów ani UI — dostaje blok `<nativeapi>` jako `NativeBlock`, wykonuje go narzędziami i nadaje eventy.

## Boot

1. `listAgents(QWE_AGENTS_DIR)` — wszystkie simy z `agents/`.
2. Jeśli nie ma żadnego: fallback z wbudowanymi `web`, `computer`, `skills`, żeby sim dodany później w UI od razu miał narzędzia.
3. `loadCapabilities(specs, ctx)` — **unia** capability wszystkich simów, bez duplikatów.
4. `AgentRuntime` z tożsamością (`QWE_INSTANCE_ID`, nazwa, wersja, `QWE_BUILD_HASH`).
5. Router HTTP — [Agent API](/api/agent/).

## AgentRuntime

```ts
type TaskState = "queued" | "running" | "waiting_user" | "paused" | "succeeded" | "failed" | "cancelled";

interface Task {
  id: string;
  sessionId?: string;
  agent?: string;            // sim, który zlecił (skill.save pisze do jego folderu)
  kind: "direct" | "plan";
  block: NativeBlock;
  state: TaskState;
  waiting?: { reason: WaitReason; message: string; meta?; since: string };
  result?: { ok: boolean; parts: ResultPart[] };
  error?: string;
  // requestedBy, createdAt, startedAt, finishedAt
}
```

| Metoda | Co robi |
|---|---|
| `submit(block, meta)` | Tworzy task, emituje `task.enqueued`, startuje asynchronicznie. |
| `pause(id)` / `resume(id)` / `cancel(id)` | Sterowanie; `resume` zwalnia zarówno pauzę, jak i `waiting_user`. |
| `list()` / `get(id)` / `stats()` | Inspekcja. |
| `descriptors()` / `toolNames()` | Co umie. |

Dla każdego wywołania runtime buduje [`ToolCallContext`](/contracts/capability/#toolcallcontext): `emit`, `checkpoint`, `waitForUser`, `priorResults`, `screenshots`, `signal`. Każde wywołanie jest owinięte eventami `tool.call` / `tool.result`.

## Screenshoty

`Screenshots.put(buf)` zapisuje plik w `data/screenshots/` i zwraca id (`shot_…`). Indeks w pamięci trzyma 400 ostatnich; po restarcie plik jest odnajdywany na dysku. Eventy niosą tylko `screenshotId`, nigdy obrazek.

## Dashboard

`GET /dashboard/` — podgląd na żywo z „pulse railem” (oś eventów) i nazwą sima przy tasku.

:::caution[Do odświeżenia]
Dashboard nie przeszedł jeszcze na nowy wygląd (tokeny chatu, awatary simów przy taskach). Zob. [Roadmapa](/status/roadmap/).
:::
