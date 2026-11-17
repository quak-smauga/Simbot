---
title: "@qwe/core"
description: Wspólne fundamenty — eventy, parser nativeapi, executor planu, kontrakt capability, manifest, LLM, mentions, command router, mini HTTP.
sidebar:
  order: 1
status: implemented
sources:
  - packages/core/src/index.ts
  - packages/core/src/selftest.ts
---

Biblioteka bez stanu aplikacji. Importują ją chat, agent, CLI i pluginy. Testy: `pnpm --filter @qwe/core test` (bez API).

## Moduły

| Plik | Odpowiada za | Najważniejsze eksporty |
|---|---|---|
| `events.ts` | Kręgosłup eventów | `AgentEvent`, `EventStore`, `MemoryEventStore`, `EventBus<M>`, `newId()` |
| `nativeapi.ts` | Kontrakt modelu ze światem | `ToolStreamParser`, `parseNativeBlock()`, `nativeResult()`, `NativeBlock`, `PlanStep` |
| `plan.ts` | Executor zależności | `executePlan()`, `validatePlan()`, `StepResult`, `StepStatus` |
| `capability.ts` | Kontrakt pluginów | `CapabilityDescriptor`, `ToolCallContext`, `ToolResult`, `WaitReason`, `toolsPrompt()` |
| `manifest.ts` | Foldery simów | `AgentManifest`, `AgentSpec`, `loadAgentSpec()`, `listAgents()`, `createAgent()`, `writeSkill()`, `writeMemory()` |
| `loader.ts` | Ładowanie capability | `loadCapabilities()` — `src/index.ts` w dev, `dist/index.js` w buildzie |
| `llm.ts` | Adapter LLM | `createLlm()` → `LlmAdapter { stream(), json() }` (Anthropic albo mock), `extractJson()` |
| `mentions.ts` | Adresowanie `@` | `parseMentions()`, `resolveTargets()`, `userSlug()`, `MENTION_ACTIONS` |
| `text.ts` | Tekst z dziurawego STT | `normalize()`, `levenshtein()`, `containsPhrase()`, `matchVoiceCommand()` |
| `env.ts` | Konfiguracja | `commonConfig()`, `loadDotenv()`, `REPO_ROOT`, `MOCK` |
| `http.ts` | Mini router | `Router`, `json()`, `readJson()`, `serveStatic()`, `sse()` |

## EventBus vs EventStore

Dwa poziomy eventów:

- **`EventBus<M>`** — typowany bus *in-process*. `M` to mapa nazwa → payload (w chacie: `ChatEvents` z `apps/chat/src/events.ts`). Metody: `on`, `once`, `onAny`, `emit`, `wait(name, pred, timeout)`. Zepsuty handler loguje błąd, nie psuje reszty.
- **`MemoryEventStore`** — append-only log `AgentEvent` z monotonicznym `seq`, limit 5000 w pamięci, opcjonalny `sink` (agent dopisuje do `agent-events.jsonl`), fan-out do subskrybentów (SSE to jeden z nich).

Szczegóły kontraktu: [Eventy](/events/).

## Adapter LLM

```ts
interface LlmAdapter {
  readonly mock: boolean;
  // strumień tekstu (chat): pełny tekst + stop_reason
  stream(system: string, history: Turn[], onDelta: (d: string) => void, opts?: StreamOptions):
    Promise<{ text: string; stopReason: string | null; usage: LlmUsage }>;
  // jedna odpowiedź jako JSON (executor, planner, pamięć, recap); rzuca, gdy nie da się sparsować
  json<T>(system: string, history: Turn[], opts?: JsonOptions): Promise<{ value: T; raw: string; usage: LlmUsage }>;
}
```

- Modele: `QWE_CHAT_MODEL` (rozmowa, domyślnie `claude-sonnet-5-5`) i `QWE_EXECUTOR_MODEL` (computer, pamięć, streszczenia — domyślnie `claude-haiku-5-5`).
- `QWE_CHAT_THINKING=1` — model myśli przed odpowiedzią (limit +4000 tokenów).
- Cache promptu: `cache_control` na prompcie systemowym i ostatniej wiadomości.
- Ograniczenie: jeden obraz dołożony do ostatniej wiadomości (wystarcza dla vision w computer).

## Command router

Podczas computer taska zwykłe wypowiedzi nie idą do LLM — `matchVoiceCommand()` rozpoznaje charakterystyczne frazy z tolerancją na błędy STT (Levenshtein, próg zależny od długości frazy). Nie reaguje na gołe „stop” / „start”.

| Komenda | Przykładowe frazy |
|---|---|
| `cancel` | „anuluj zadanie”, „przerwij komputer”, „zostaw to” |
| `pause` | „zatrzymaj komputer”, „poczekaj chwilę”, „wstrzymaj” |
| `resume` | „wznów zadanie”, „kontynuuj”, „zalogowałem się”, „zrobione, leć dalej” |
| `take_control` | „przejmuję kontrolę”, „daj mi kontrolę” |
| `give_control` | „oddaję kontrolę”, „twoja kolej” |

## Selftest

`packages/core/src/selftest.ts` sprawdza bez sieci: parser strumienia i bloków, executor planu (równoległość, `after`, skip, cykle), `extractJson`, command router i mentions.
