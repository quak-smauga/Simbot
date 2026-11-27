---
title: Mapa repo → docs
description: Który plik w repo opisuje która strona dokumentacji. Punkt wyjścia przy każdej aktualizacji.
sidebar:
  order: 2
---

| Ścieżka w repo | Strony docsów |
|---|---|
| `packages/core/src/events.ts` | [Eventy](/events/), [@qwe/core](/components/core/) |
| `packages/core/src/nativeapi.ts`, `plan.ts` | [nativeapi i plany](/contracts/nativeapi/), [Cykl życia tury](/architecture/lifecycle/) |
| `packages/core/src/capability.ts`, `loader.ts` | [Kontrakt capability](/contracts/capability/), [Napisz capability](/capabilities/writing-plugins/) |
| `packages/core/src/manifest.ts` | [AgentManifest.yaml](/contracts/agent-manifest/), [Dane](/architecture/data/) |
| `packages/core/src/mentions.ts` | [Mentions](/contracts/mentions/) |
| `packages/core/src/text.ts` | [@qwe/core → command router](/components/core/#command-router) |
| `packages/core/src/llm.ts`, `ollama.ts`, `env.ts`, `http.ts` | [@qwe/core](/components/core/), [Konfiguracja](/development/configuration/) |
| `packages/core/src/mcp.ts`, `packages/mcp/src/*`, `apps/chat/src/mcp.ts`, `apps/chat/public/ui/mcp.js` | [Serwery MCP](/capabilities/mcp/), [Chat REST → MCP](/api/chat-rest/#serwery-mcp), [Agent API → MCP](/api/agent/#serwery-mcp) |
| `packages/voice/src/*` | [@qwe/voice](/components/voice/) |
| `packages/cli/src/*` | [CLI](/components/cli/), [Docker](/development/docker/) |
| `apps/chat/src/index.ts` | [Chat REST](/api/chat-rest/), [Chat server](/components/chat/) |
| `apps/chat/src/ws.ts`, `hub.ts`, `events.ts` | [Chat WebSocket](/api/chat-ws/), [Eventy](/events/) |
| `apps/chat/src/session.ts`, `chat.ts` | [Cykl życia tury](/architecture/lifecycle/), [Chat server](/components/chat/) |
| `apps/chat/src/bots.ts` | [Chat server → prompt](/components/chat/#prompt-systemowy-sima), [Pamięć](/capabilities/memory/) |
| `apps/chat/src/store.ts`, `context.ts` | [Dane i pamięć](/architecture/data/) |
| `apps/chat/src/recall.ts` | [Pamięć i memory.search](/capabilities/memory/) |
| `apps/chat/src/files.ts`, `public/ui/attach.js`, `public/ui/files.js` | [Pliki rozmowy](/capabilities/files/), [REST](/api/chat-rest/), [UI](/components/ui/) |
| `apps/chat/src/models.ts`, `public/ui/models.js` | [REST](/api/chat-rest/), [UI](/components/ui/), [Konfiguracja](/development/configuration/) |
| `apps/chat/src/agent-link.ts` | [Procesy i komunikacja](/architecture/system/) |
| `apps/chat/prompts/system.md` | [nativeapi → prompt systemowy](/contracts/nativeapi/#prompt-systemowy) |
| `apps/chat/public/ui/*` | [UI](/components/ui/), [Desktop → widget](/components/desktop/#widget) |
| `apps/agent/src/*` | [Agent server](/components/agent/), [Agent API](/api/agent/) |
| `apps/agent/public/*` | [Agent server → dashboard](/components/agent/#dashboard) |
| `apps/desktop/src/main.js` | [Desktop](/components/desktop/), [Desktop API](/api/desktop/) |
| `apps/desktop/src/preload.cjs` | [Desktop API → window.qwe](/api/desktop/#windowqwe-preload) |
| `apps/desktop/src/desktop.js`, `helper/qwe-helper.swift` | [Desktop API → bridge i helper](/api/desktop/#desktop-bridge), [computer → desktop](/capabilities/computer/#target-desktop-macos) |
| `apps/desktop/src/server.js` | [Procesy i komunikacja](/architecture/system/#kto-kogo-uruchamia) |
| `plugins/web/*` | [web.query](/capabilities/web/) |
| `plugins/computer/*` | [computer.run](/capabilities/computer/) |
| `plugins/skills/*` | [skill.save](/capabilities/skills/) |
| `agents/*` | [Pojęcia](/overview/concepts/), [AgentManifest.yaml](/contracts/agent-manifest/) |
| `docker/runtime.Dockerfile` | [Docker](/development/docker/) |
| `.env.example` | [Konfiguracja](/development/configuration/) |
| `README.md` | [Szybki start](/overview/quickstart/) — README to skrót, szczegóły tylko w docsach |
| `examples/kucharz/` | [Napisz własną capability](/capabilities/writing-plugins/), [Konfiguracja](/development/configuration/) |
| `apps/docs/*`, `CLAUDE.md` | [Ten portal](/development/docs-portal/), [Przewodnik utrzymania](/maintenance/guide/) |
