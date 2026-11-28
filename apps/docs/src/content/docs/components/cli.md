---
title: CLI qwe
description: Jedno CLI do dev, build i run — qwe dev, desktop, inspect, build, run, ps, logs.
sidebar:
  order: 6
status: implemented
sources:
  - packages/cli/src/index.ts
  - packages/cli/src/build.ts
  - bin/qwe
---

`bin/qwe` → `@qwe/cli`. Dodaj `bin/` do `PATH` albo używaj `pnpm qwe …`.

| Komenda | Co robi |
|---|---|
| `qwe dev [--mock] [--agent]` | Chat na hoście (`tsx`), agent wstaje po pierwszej akcji albo od razu z `--agent`. |
| `qwe up [--mock]` | Jak `dev`, ale ze zbudowanych `dist` (najpierw `pnpm build`). |
| `qwe chat` / `qwe agent [--mock]` | Pojedynczy proces. |
| `qwe desktop [--mock]` | Electron: okno + widget + tray. |
| `qwe inspect [agentDir]` | Co widzi manifest: capability, tools, skille, zależności. |
| `qwe home` | Gdzie jest dom usera teraz i dom Simbot.app. |
| `qwe home import [--to DIR] [--force]` | Kopiuje `data/`, `agents/` i `.env` z repo do domu Simbot.app; serwerom MCP bez `cwd` dopisuje `cwd` = repo. |
| `pnpm app` / `pnpm app:dmg` | Simbot.app / `.dmg` — zob. [Desktop → Simbot.app](/components/desktop/#simbotapp-build). |
| `qwe build [agentDir] [--tag T] [--dry-run]` | Dockerfile z `AgentManifest.yaml` + pluginów → `docker build`. |
| `qwe build --runtime [--tag T]` | Obraz bazowy `qwe/agent-runtime:0.1.0` (monorepo + Chromium). |
| `qwe run [agentDir\|image] [--name N] [--port P] [--no-chat]` | Agent w kontenerze + chat na hoście (`QWE_AGENT_MODE=url`). |
| `qwe ps` / `qwe stop <name>` / `qwe logs <name>` | Zarządzanie kontenerami. |

`--mock` = bez kluczy API (skryptowany LLM, ton zamiast głosu, udawany search, skryptowany computer).

Szczegóły budowania obrazów: [Docker](/development/docker/).
