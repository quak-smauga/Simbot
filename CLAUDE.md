# qwe / Simbot

Simbot (kod: qwe) — simy, rozmowy, agent z komputerem, desktop na Electronie. Monorepo pnpm, TypeScript, Node ≥ 22.13. Start i komendy: `README.md`.

## Dokumentacja (`apps/docs`)

Żywa dokumentacja systemu: Astro + Starlight, treść w `apps/docs/src/content/docs/**/*.md`. Zasady szczegółowo: `apps/docs/CLAUDE.md`.

**Reguła: zmiana kodu → aktualizacja docsów w tym samym kroku**, jeśli zmiana dotyka:

- endpointu, wiadomości WS, kanału IPC albo komendy helpera,
- typu eksportowanego z `@qwe/core`, pola `AgentManifest.yaml` albo `capability.yaml`,
- nazwy albo payloadu eventu,
- zmiennej env (także nowej, tylko w kodzie),
- procesu, portu, sposobu uruchamiania,
- stanu funkcji (plan → częściowo → działa).

Jak:

1. Znajdź strony: `apps/docs/src/content/docs/maintenance/mapping.md` albo grep ścieżki zmienionego pliku w `apps/docs/src/content/docs` (frontmatter `sources`).
2. Zaktualizuj je. Dokumentuj tylko to, co jest w kodzie — plany wyłącznie w `status/roadmap.md`.
3. Zmiana architektury (proces, kanał, kontrakt, capability, event) → wpis w `status/changelog.md`.
4. Sprawdź: `pnpm docs:build`.

Nie podbijaj Astro do 7 — wymaga Node ≥ 22.23 (na tej maszynie jest 22.14).
