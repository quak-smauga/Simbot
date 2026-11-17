// @qwe/plugin-web — capability "web": tool web.query.
// Eventy: web.started { query } · web.progress { message } · web.completed { provider, ms, results[] (lekkie) }
import type { CapabilityContext, CapabilityDescriptor, ToolMap } from "@qwe/core";
import { mockSearch, search, toPromptText, type SearchConfig } from "./search.js";

export { search, toPromptText, parseDuckHtml } from "./search.js";
export { toReadable, stripHtml, clip } from "./readable.js";

export const descriptor: Partial<CapabilityDescriptor> = { name: "web" };

export function create(ctx: CapabilityContext): ToolMap {
  const e = ctx.env;
  const cfg: SearchConfig = {
    provider: (e.SEARCH_PROVIDER as SearchConfig["provider"]) || "auto",
    tavilyKey: e.TAVILY_API_KEY ?? "",
    braveKey: e.BRAVE_API_KEY ?? "",
    maxResults: Number(e.SEARCH_MAX_RESULTS ?? 5),
    fetchPages: Number(e.SEARCH_FETCH_PAGES ?? 3),
    pageChars: Number(e.SEARCH_PAGE_CHARS ?? 3500),
    timeoutMs: Number(e.SEARCH_TIMEOUT_MS || 8000),
  };
  return {
    "web.query": async (args, call) => {
      const query = (args._ ?? args.query ?? "").trim();
      if (!query) return { ok: false, text: "Puste zapytanie." };
      call.emit("web.started", { query });
      const progress = (message: string) => call.emit("web.progress", { message });
      const out = ctx.mock ? await mockSearch(query, progress) : await search(query, cfg, progress, call.signal);
      const light = out.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet.slice(0, 200), read: !!r.content }));
      call.emit("web.completed", { query, provider: out.provider, ms: out.ms, results: light });
      return { ok: true, text: toPromptText(out), data: { query, provider: out.provider, results: light } };
    },
  };
}
