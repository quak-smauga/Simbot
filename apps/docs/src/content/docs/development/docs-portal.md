---
title: Ten portal
description: Jak uruchomić, zbudować i rozbudować Simbot Docs (apps/docs, Astro + Starlight).
sidebar:
  order: 4
status: implemented
sources:
  - apps/docs/astro.config.mjs
  - apps/docs/src/content.config.ts
  - apps/docs/src/components/PageTitle.astro
  - .github/workflows/docs.yml
---

```bash
pnpm docs                            # = pnpm --filter @qwe/docs dev → http://localhost:4321
```

```bash
pnpm docs:build                      # statyczny build do apps/docs/dist (+ indeks Pagefind)
```

```bash
pnpm --filter @qwe/docs preview
```

Stack: **Astro 6.4 + Starlight 0.40**, Mermaid przez `astro-mermaid`, wyszukiwarka Pagefind (wbudowana w Starlight). Wersje są dobrane pod Node 22.14 z tej maszyny — Astro 7 wymaga Node ≥ 22.23.

Skrypt nazywa się `docs:build`, a nie `build`, żeby `pnpm build` w korzeniu (budowanie `dist` aplikacji) nie budował też docsów.

## Struktura

```
apps/docs/
├── astro.config.mjs               sidebar, motyw, mermaid, nadpisane komponenty
├── public/llms.txt                mapa docsów dla agentów
├── src/content.config.ts          schemat frontmattera (status, sources)
├── src/content/docs/              ← TREŚĆ (Markdown / MDX)
├── src/components/                PageTitle (status + źródła), Status, ArchitectureMap, ThemeProvider (dark-first)
└── src/styles/theme.css           tokeny i wygląd
```

## Frontmatter

```yaml
---
title: Agent server
description: Jedno zdanie — trafia do wyszukiwarki i podglądu linku.
sidebar:
  order: 3
status: implemented        # implemented | partial | experimental | planned | deprecated
sources:                   # ścieżki względem korzenia repo
  - apps/agent/src/runtime.ts
---
```

`status` i `sources` renderują się pod tytułem. Ustaw `SIMBOT_REPO_URL` (np. `https://github.com/org/simbot/blob/main`), a ścieżki staną się linkami.

## Elementy treści

- Diagramy: blok ` ```mermaid `.
- Asides: `:::note`, `:::tip`, `:::caution`, `:::danger`.
- W `.mdx`: `import Status from '../../components/Status.astro'` → `<Status value="partial" />`; komponenty Starlight (`Card`, `CardGrid`, `Tabs`, `Steps`) z `@astrojs/starlight/components`.

## Publikacja (GitHub Pages)

Workflow `.github/workflows/docs.yml` buduje portal przy pushu na `main` (zmiany w `apps/docs/**`) albo ręcznie i wrzuca `dist` na GitHub Pages. W repo raz: **Settings → Pages → Source: GitHub Actions**.

| Zmienna | Skąd w CI | Po co |
|---|---|---|
| `SIMBOT_DOCS_SITE` | `configure-pages` → `origin` | pełny adres strony (sitemap, linki kanoniczne); lokalnie `http://localhost:4321` |
| `SIMBOT_DOCS_BASE` | `configure-pages` → `base_path` | ścieżka repo, np. `/simbot`; lokalnie pusta |
| `SIMBOT_REPO_URL` | `github.server_url` + repo + gałąź | `sources` pod tytułem stają się linkami do kodu |

Treść pisze linki od korzenia (`/status/roadmap/`). Po buildzie integracja `simbot-base-links` w `astro.config.mjs` dopisuje `SIMBOT_DOCS_BASE` do każdego `href="/…"` w HTML-u — Markdown, MDX i komponenty działają bez zmian. Wyjątek: `public/llms.txt` jest kopiowany 1:1, więc jego linki są względem korzenia domeny.

Podgląd jak na Pages:

```bash
SIMBOT_DOCS_BASE=/simbot pnpm docs:build && SIMBOT_DOCS_BASE=/simbot pnpm --filter @qwe/docs preview
```

Zasady pisania i aktualizacji: [Przewodnik utrzymania](/maintenance/guide/).
