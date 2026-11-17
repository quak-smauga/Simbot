---
title: Kontrakt capability
description: capability.yaml + create(ctx) → ToolMap. ToolCallContext, ToolResult, human-in-the-loop, eventy, screenshoty.
sidebar:
  order: 4
status: implemented
sources:
  - packages/core/src/capability.ts
  - packages/core/src/loader.ts
  - plugins/web/capability.yaml
---

Capability to samodzielny plugin z **własną implementacją i własnymi zależnościami**. qwe ma lifecycle i wykonanie. Plugin nie instaluje niczego sam w runtime — deklaruje, `qwe build` zbiera. Capability nie wie, czy wywołał ją direct call, czy executor planu.

## Pliki

```
plugins/hello/                  (albo @scope/qwe-plugin-x jako paczka npm)
├── capability.yaml             deskryptor
└── index.(ts|js)               export async function create(ctx) → ToolMap
```

Loader szuka: w dev `src/index.ts`, `index.ts`, `index.js`, `index.mjs`, `dist/index.js`; w buildzie `dist/index.js`, `index.js`, `index.mjs`. Lokalny plugin w folderze sima: ESM `.js` (albo `dist/index.js`); `.ts` działa w dev (tsx).

## capability.yaml

```yaml
apiVersion: qwe/v1
kind: Capability
name: web
version: 0.1.0
description: Wyszukiwanie w internecie i czytanie stron (readability).
dependencies:
  npm: ["@mozilla/readability@^0.6.0", "linkedom@^0.18.5"]
  system: []
tools:
  - name: web.query
    usage: "<web.query>zapytanie</web.query> — szuka w internecie i oddaje treść stron"
    notes: "Jedno zapytanie w tagu, konkretne jak do Google. Nie wymyślaj wyników."
```

`usage` (jedna linia) i `notes` trafiają do promptu sima przez `toolsPrompt()`. YAML jest źródłem prawdy; moduł może nadpisać deskryptor eksportem `descriptor`. Tool zadeklarowany w YAML, a niezwrócony przez `create()`, daje ostrzeżenie.

## create(ctx)

```ts
export async function create(ctx: CapabilityContext): Promise<ToolMap> {
  return {
    "hello.ping": async (args, call) => {
      call.emit("hello.progress", { n: 1 });
      await call.checkpoint();
      return { ok: true, text: `pong: ${args._}` };
    },
  };
}
```

### CapabilityContext

| Pole | Opis |
|---|---|
| `mock` | tryb `--mock` |
| `dataDir` | `QWE_DATA_DIR` |
| `agentsDir` | katalog simów — dla capability piszących do folderu sima |
| `env` | `process.env` |
| `llm` | [`LlmAdapter`](/components/core/#adapter-llm) z runtime'u (`stream`, `json`) |
| `log(level, msg)` | log procesu agenta |

### ToolCallContext

| Pole / metoda | Opis |
|---|---|
| `args._`, `args.<attr>` | treść tagu i atrybuty |
| `taskId`, `sessionId`, `stepId`, `planId` | kontekst wywołania |
| `agent` | sim, który wywołał (folder: `${agentsDir}/${agent}`) |
| `signal` | `AbortSignal` — anulowanie |
| `priorResults` | wyniki wcześniejszych kroków planu (id → `ToolResult`); w direct puste |
| `emit(type, data)` | event do streamu; koperta dostaje `taskId/sessionId/stepId` automatycznie |
| `checkpoint()` | między krokami: czeka przy pauzie, rzuca przy anulowaniu |
| `waitForUser(reason, message, meta?)` | human-in-the-loop: task → `waiting_user` do „Wznów” (albo anulowanie → throw) |
| `screenshots.put(buf, mime?)` | zapis obrazu → id dla UI (`/api/screenshots/:id`) |

`WaitReason`: `LOGIN_REQUIRED` · `CONFIRM_ACTION` · `CAPTCHA` · `USER_CONTROL` · `OTHER`.

:::caution[Wznów ≠ potwierdzenie]
Przycisk „Wznów” to **zgoda na wznowienie**, nie potwierdzenie, że stan jest dobry. Po `waitForUser()` capability sama sprawdza stan (np. computer robi nową obserwację).
:::

### ToolResult

```ts
interface ToolResult {
  ok: boolean;
  text: string;      // co wraca do modelu (runtime opakuje w <nativeresult>)
  data?: unknown;    // lekki strukturalny wynik dla UI / kolejnych kroków (bez pełnych treści)
  status?: string;   // dokładniejszy status → <nativeresult status=…>
}
```

## Przewodnik

Krok po kroku z przykładem: [Napisz własną capability](/capabilities/writing-plugins/).
