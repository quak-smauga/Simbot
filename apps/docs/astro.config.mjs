// Simbot Docs — Astro + Starlight. Treść: src/content/docs (Markdown/MDX = źródło prawdy).
// Linki do źródeł: ustaw SIMBOT_REPO_URL (np. https://github.com/org/simbot/blob/main), inaczej ścieżki są tylko tekstem.
// GitHub Pages pod ścieżką repo: SIMBOT_DOCS_BASE=/<repo> (ustawia workflow .github/workflows/docs.yml).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

const base = (process.env.SIMBOT_DOCS_BASE ?? "").replace(/\/+$/, "");

// Treść pisze linki od korzenia (`/status/roadmap/`), żeby działały w dev i w Markdownie bez base.
// Po buildzie dopisujemy base do każdego `href="/…"`, który go jeszcze nie ma (Markdown, MDX, komponenty).
const baseLinks = () => ({
  name: "simbot-base-links",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      if (!base) return;
      const root = fileURLToPath(dir);
      const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".html"));
      for (const f of files) {
        const path = join(root, f);
        const html = await readFile(path, "utf8");
        const out = html.replace(/(\shref=")(\/(?!\/)[^"]*)"/g, (m, attr, url) =>
          url === base || url.startsWith(base + "/") ? m : `${attr}${base}${url}"`);
        if (out !== html) await writeFile(path, out);
      }
    },
  },
});

const group = (label, directory, collapsed = false) => ({ label, collapsed, items: [{ autogenerate: { directory } }] });

export default defineConfig({
  site: process.env.SIMBOT_DOCS_SITE ?? "http://localhost:4321",
  base: base || "/",
  integrations: [
    // mermaid MUSI być przed starlight (przetwarza bloki ```mermaid zanim zrobi to Expressive Code)
    mermaid({ theme: "neutral", autoTheme: true }),
    starlight({
      title: "Simbot Docs",
      description: "Żywa dokumentacja Simbota: simy, rozmowy, agent, komputer, desktop.",
      logo: { src: "./src/assets/logo.svg", alt: "Simbot" },
      favicon: "/favicon.svg",
      defaultLocale: "root",
      locales: { root: { label: "Polski", lang: "pl" } },
      lastUpdated: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ["./src/styles/theme.css"],
      components: {
        PageTitle: "./src/components/PageTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
      },
      expressiveCode: {
        themes: ["github-dark-default", "github-light-default"],
        styleOverrides: { borderRadius: "10px", codeFontSize: "0.85rem" },
      },
      head: [{ tag: "meta", attrs: { name: "theme-color", content: "#0e0f0e" } }],
      sidebar: [
        group("Wprowadzenie", "overview"),
        group("Architektura", "architecture"),
        group("Komponenty", "components"),
        group("Kontrakty", "contracts"),
        group("API", "api"),
        { label: "Eventy", items: [{ slug: "events" }] },
        group("Capabilities", "capabilities"),
        group("Development", "development"),
        group("Status i roadmapa", "status"),
        group("Utrzymanie docsów", "maintenance", true),
      ],
    }),
    baseLinks(),
  ],
});
