---
title: AgentManifest.yaml
description: Folder sima i jego manifest — capability, model, persona, wygląd, pamięć, skille.
sidebar:
  order: 3
status: implemented
sources:
  - packages/core/src/manifest.ts
  - agents/sima/AgentManifest.yaml
---

Trzy odpowiedzialności, trzy pliki: **manifest** opisuje, z czego zbudowany jest agent; **plan** — co chce zrobić; **capability** — jak wykonać robotę. YAML to deklaratywna konfiguracja, nie drugi język.

## Folder sima

```
agents/<name>/
├── AgentManifest.yaml
├── persona.md                 kim jest, jak mówi
├── memory.md                  "- 2026-11-02 · fakt" — jedna linia = jeden fakt
├── skills/<skill>.md          frontmatter + markdown → do promptu
└── plugins/<cap>/             lokalne capability: capability.yaml + index.(ts|js)
```

## Przykład (Sima)

```yaml
apiVersion: qwe/v1
kind: Agent
name: sima
version: 0.1.0
description: domyślna — szybka rozmowa o czymkolwiek
runtime:
  base: qwe/agent-runtime:0.1.0
capabilities:
  builtin: [web, computer, skills]
  plugins: ./plugins
  packages: []
  skills: ./skills
dependencies:
  npm: []
  system: []
model:
  provider: anthropic
persona: ./persona.md
look:
  color: "#8B5CF6"
  avatar: { shape: circle, eyes: round, mouth: smile, acc: [], pattern: none, idle: bob }
  voice: ""
memory:
  enabled: true
  max: 200
```

## Pola

| Pole | Typ | Opis |
|---|---|---|
| `apiVersion`, `kind` | `qwe/v1`, `Agent` | stałe |
| `name` | string | nazwa = `@` w rozmowie (bezpieczne znaki) |
| `version`, `description` | string | opis widoczny w UI |
| `runtime.base` | string | obraz bazowy dla `qwe build` |
| `capabilities.builtin` | string[] | wbudowane paczki z `plugins/` (`web`, `computer`, `skills`) |
| `capabilities.plugins` | ścieżka | folder lokalnych pluginów (każdy podfolder = capability) |
| `capabilities.packages` | string[] | capability jako paczki npm (`@acme/qwe-plugin-x@^1`) |
| `capabilities.skills` | ścieżka | folder skilli |
| `capabilities.mcp` | string[] | [serwery MCP](/capabilities/mcp/) (nazwy z `data/mcp.json`), do których sim ma dostęp |
| `dependencies.npm/system` | string[] | zależności sima (oprócz zależności pluginów) |
| `model` | `{ provider, chat?, executor? }` | override modeli |
| `server.port` | number | port agenta w kontenerze |
| `persona` | ścieżka | plik persony |
| `look` | obiekt | `color`, `emoji`, `voice` (ElevenLabs voiceId), `tempo` (`calm\|normal\|lively`), `avatar` |
| `memory` | `{ enabled?, max? }` | czy sim zbiera fakty po turze (domyślnie tak) i ile linii trzyma |

## Skill

```md
---
name: brave-nowa-karta
description: Otwieranie nowej karty w Brave bez walki z fokusem na macOS.
uses: []
---

# Nowa karta w Brave
1. …
```

Skill trafia do promptu sima jako „jak podchodzić do zadań”. Zapisuje go user (UI, `POST /api/bots/:name/skills`) albo sam sim przez [`skill.save`](/capabilities/skills/).

## Zarządzanie

- UI: strona sima (awatar w sidebarze) — setup, skille, pamięć.
- REST: `/api/bots…` — [Chat REST](/api/chat-rest/#simy).
- CLI: `qwe inspect agents/<name>` — co widzi manifest.
- Sima (`agents/sima`) tworzy się automatycznie i nie da się jej usunąć.
