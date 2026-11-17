# Simbot Docs — instrukcje dla Claude Code

Portal dokumentacji Simbota (kod: qwe). Astro 6.4 + Starlight 0.40, Mermaid (astro-mermaid), Pagefind. Po polsku.

- Treść: `src/content/docs/**/*.md(x)`. Markdown = źródło prawdy.
- Frontmatter stron technicznych: `title`, `description`, `status` (implemented | partial | experimental | planned | deprecated), `sources` (ścieżki względem korzenia repo).
- Dev: `pnpm --filter @qwe/docs dev` (http://localhost:4321). Build: `pnpm --filter @qwe/docs docs:build`.
- Node na tej maszynie: 22.14 → **nie podbijaj Astro do 7** (wymaga Node ≥ 22.23).

## Zasady

1. Dokumentujemy to, co jest w kodzie. Plany tylko w `status/roadmap.md` (sekcja „Planowane”).
2. Kod wygrywa z README. README jest krótkie — szczegóły tylko w docsach.
3. Przy zmianie kodu: znajdź strony w `maintenance/mapping.md` (albo grep ścieżki pliku w `src/content/docs`), zaktualizuj je w tym samym commicie.
4. Tabele referencji (API, eventy, env) weryfikuj grepem — komendy w `maintenance/guide.md`.
5. Nowa strona → wpis w `maintenance/mapping.md` i linia w `public/llms.txt`.
6. Zmiana architektury (proces, kanał, kontrakt, capability, event) → wpis w `status/changelog.md`.
7. Po zmianach: `pnpm --filter @qwe/docs docs:build` musi przejść.
