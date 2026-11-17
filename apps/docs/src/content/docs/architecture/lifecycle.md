---
title: Cykl życia tury
description: Co się dzieje od wiadomości usera do odpowiedzi sima — dispatch @, BotRunner, nativeapi, task, wynik.
sidebar:
  order: 2
status: implemented
sources:
  - apps/chat/src/session.ts
  - apps/chat/src/chat.ts
  - apps/agent/src/runtime.ts
  - packages/core/src/plan.ts
---

## Od wiadomości do odpowiedzi

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant S as ChatSession
  participant B as BotRunner (sim)
  participant L as Claude
  participant A as AgentLink
  participant R as Agent runtime
  participant C as Capability

  U->>S: tekst (WS) albo głos (VAD → STT)
  S->>S: resolveTargets(@) → kolejka simów
  S->>B: tura sima (bot.turn)
  B->>L: system + historia z perspektywy sima (stream)
  L-->>B: „Spoko, sprawdzę.” (say.* → UI, TTS)
  L-->>B: <nativeapi>…</nativeapi> (stop sequence)
  B->>A: submit(block)
  A->>R: POST /api/tasks → 202 {taskId}
  R->>C: tool(args, call)
  C-->>R: call.emit(…) — eventy postępu
  R-->>A: SSE: task.* / step.* / computer.* …
  A-->>S: eventy po sessionId → WS → karty
  C-->>R: ToolResult
  R-->>A: task.succeeded {parts}
  A-->>B: wynik
  B->>L: <nativeresult …>…</nativeresult>
  L-->>B: druga kwestia (odpowiedź)
  B-->>S: assistant.message
  S->>S: @inny-sim w odpowiedzi? → następne ogniwo (max 3)
```

### 1. Dispatch: kto odpowiada

`ChatSession` przepuszcza tekst przez `resolveTargets()` z [`mentions.ts`](/contracts/mentions/):

- bez `@` → odpowiada **prowadzący** (pierwszy członek rozmowy);
- `@sim` / `@sim.task` → wskazane simy, po kolei;
- `@user` → event `mention.user` (toast / powiadomienie), nikt nie odpowiada;
- `@sim` spoza rozmowy → `mention.absent`, UI proponuje „dodaj”.

Każdy sim może w odpowiedzi zawołać następnego (`@audytor sprawdź sumy`). Łańcuch ma limit **3 ogniw** po wiadomości usera (`MAX_CHAIN`).

:::note[Podczas pracy komputera]
Kiedy rozmowa jest w stanie `working` (computer task), wypowiedzi głosowe **nie idą do LLM** — trafiają do command routera (`matchVoiceCommand`): „zatrzymaj komputer”, „wznów”, „anuluj zadanie”, „przejmuję kontrolę”. Zob. [Komendy głosowe](/components/core/#command-router).
:::

### 2. Tura sima (BotRunner)

`BotRunner` buduje historię **z bazy przy każdej turze**, z perspektywy tego sima:

| Wpis w bazie | Co widzi sim |
|---|---|
| wiadomość usera | `user` |
| moja odpowiedź | `assistant` (pełny tekst z blokiem) |
| odpowiedź innego sima | `user`, jako `@nazwa: tekst` (bez bloków) |
| mój wynik narzędzia | `user` (`<nativeresult>`) — w całości tylko w bieżącej turze, starsze skrócone |
| cudzy wynik narzędzia | pominięty |

Na początek historii trafia kroczące **streszczenie** starszej części rozmowy (jeśli jest). Początek historii zmienia się rzadko, więc łapie się w cache promptu. Szczegóły: [Dane i pamięć](/architecture/data/#kontekst-modelu).

Strumień z modelu przechodzi przez `ToolStreamParser`: tekst przed `<nativeapi>` leci na bieżąco jako `say.*` (UI i TTS), a blok jest zbierany do końca. Model ma `stop_sequences: ["</nativeapi>"]`. Jedna tura może mieć do **3 wywołań** narzędzi z rzędu (`MAX_HOPS`).

### 3. Task w agencie

```mermaid
stateDiagram-v2
  [*] --> queued: POST /api/tasks
  queued --> running
  running --> waiting_user: call.waitForUser()
  waiting_user --> running: resume
  running --> paused: pause
  paused --> running: resume
  running --> succeeded
  running --> failed
  running --> cancelled: cancel
  waiting_user --> cancelled: cancel
  paused --> cancelled: cancel
  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
```

- **direct** — narzędzia z bloku wywoływane po kolei; wynik = lista `parts`.
- **plan** — [`executePlan()`](/contracts/nativeapi/#plan): kroki bez `after` równolegle, kroki z niespełnioną zależnością → `skipped`, anulowanie zachowuje to, co już zrobione.
- `checkpoint()` między krokami capability realizuje pauzę i anulowanie.
- Taski z **różnych** rozmów biegną równolegle; o zasoby (np. jedna przeglądarka) dba capability.

### 4. Wynik wraca do modelu

`AgentLink.submit()` czeka na terminalny event (`task.succeeded | failed | cancelled`) i oddaje wynik. `BotRunner` opakowuje go w `<nativeresult name="…" status="…">` i robi drugą rundę z modelem — sim mówi, co znalazł.

## Stany rozmowy

Rozmowa jako całość ma stan (`agent.state`), który napędza kropkę, widget i chip w sidebarze:

```mermaid
stateDiagram-v2
  direction LR
  idle --> listening: głos włączony
  listening --> thinking: user.text
  idle --> thinking: user.text
  thinking --> speaking: say.start
  thinking --> working: tool.call
  working --> waiting_user: task.waiting
  waiting_user --> working: task.resumed
  working --> thinking: tool.result
  speaking --> listening
  speaking --> idle
```

Half-duplex: kiedy sim mówi, VAD jest wyciszony. `Esc` / `user.interrupt` przerywa mowę (`voice.abort`).

## Po turze (w tle)

- **Pamięć** — tani model wyciąga fakty z tury do `memory.md` sima i do wspólnej pamięci o userze → event `memory.saved`.
- **Streszczenie** — gdy niestreszczona część rozmowy przekroczy ~40k znaków, najstarszy kawałek idzie do streszczenia.
- **Recap** — po 90 s ciszy rozmowa dostaje krótkie podsumowanie (do `memory.search`), czasem z propozycją nowego tytułu.

Zob. [Pamięć](/capabilities/memory/).
