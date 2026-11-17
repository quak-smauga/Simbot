// search(query) → wyniki + treść stron gotowa dla LLM.
//   1. provider: tavily (ma własny "content") → brave → duckduckgo (HTML, bez klucza)
//   2. dla pierwszych N wyników: fetch strony → readable → clip
// Każdy provider to funkcja (query, n) → SearchResult[]; dodanie nowego = jedna funkcja + wpis w PROVIDERS.
import { clip, toReadable } from "./readable.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}
export interface SearchConfig {
  provider: "auto" | "tavily" | "brave" | "duckduckgo";
  tavilyKey: string;
  braveKey: string;
  maxResults: number;
  fetchPages: number;
  pageChars: number;
  timeoutMs: number;
}
export type Provider = (query: string, n: number, signal: AbortSignal, cfg: SearchConfig) => Promise<SearchResult[]>;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 qwe/0.1";

const tavily: Provider = async (query, n, signal, cfg) => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.tavilyKey}` },
    body: JSON.stringify({ query, max_results: n, include_answer: false, include_raw_content: false, search_depth: "basic" }),
    signal,
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, content: r.content }));
};

const brave: Provider = async (query, n, signal, cfg) => {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(n));
  u.searchParams.set("search_lang", "pl");
  u.searchParams.set("country", "PL");
  const res = await fetch(u, { headers: { accept: "application/json", "X-Subscription-Token": cfg.braveKey }, signal });
  if (!res.ok) throw new Error(`brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
};

const duckduckgo: Provider = async (query, n, signal) => {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.searchParams.set("q", query);
  u.searchParams.set("kl", "pl-pl");
  const res = await fetch(u, { headers: { "user-agent": UA, accept: "text/html" }, signal });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  return parseDuckHtml(await res.text()).slice(0, n);
};

export function parseDuckHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = m[1];
    const q = /[?&]uddg=([^&]+)/.exec(href);
    if (q) href = decodeURIComponent(q[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const title = textOf(m[2]);
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 2500);
    const s = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|span)>/.exec(tail);
    if (title) out.push({ title, url: href, snippet: s ? textOf(s[1]) : "" });
  }
  return out;
}
const textOf = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export const PROVIDERS: Record<string, Provider> = { tavily, brave, duckduckgo };

export function pickProvider(cfg: SearchConfig): { name: string; fn: Provider } {
  if (cfg.provider !== "auto") {
    if (!PROVIDERS[cfg.provider]) throw new Error(`nieznany SEARCH_PROVIDER: ${cfg.provider}`);
    return { name: cfg.provider, fn: PROVIDERS[cfg.provider] };
  }
  if (cfg.tavilyKey) return { name: "tavily", fn: tavily };
  if (cfg.braveKey) return { name: "brave", fn: brave };
  return { name: "duckduckgo", fn: duckduckgo };
}

export async function fetchReadable(url: string, maxChars: number, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, signal, redirect: "follow" });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !/html|xml|text\/plain/.test(ct)) return null;
    const html = (await res.text()).slice(0, 2_000_000);
    const r = /text\/plain/.test(ct) ? { text: html } : toReadable(html, url);
    return clip(r.text, maxChars) || null;
  } catch {
    return null;
  }
}

export interface SearchOutcome {
  provider: string;
  query: string;
  results: SearchResult[];
  ms: number;
}

export async function search(query: string, cfg: SearchConfig, onProgress?: (msg: string) => void, outer?: AbortSignal): Promise<SearchOutcome> {
  const t0 = Date.now();
  const { name, fn } = pickProvider(cfg);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  outer?.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    onProgress?.(`szukam (${name}): ${query}`);
    const results = (await fn(query, cfg.maxResults, ac.signal, cfg)).filter((r) => r.url && r.title);
    const toFetch = results.filter((r) => !r.content).slice(0, cfg.fetchPages);
    if (toFetch.length) {
      let done = 0;
      await Promise.all(
        toFetch.map(async (r) => {
          const text = await fetchReadable(r.url, cfg.pageChars, ac.signal);
          if (text) r.content = text;
          onProgress?.(`czytam ${++done}/${toFetch.length}`);
        }),
      );
    }
    return { provider: name, query, results, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Tekst dla modelu: snippety dla wszystkich, treść dla tych, które udało się przeczytać. */
export function toPromptText(o: SearchOutcome): string {
  if (!o.results.length) return "Brak wyników.";
  return o.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content ?? r.snippet}`)
    .join("\n\n");
}

export async function mockSearch(query: string, onProgress?: (m: string) => void): Promise<SearchOutcome> {
  onProgress?.(`szukam (mock): ${query}`);
  await new Promise((r) => setTimeout(r, 900));
  onProgress?.("czytam 1/2");
  await new Promise((r) => setTimeout(r, 500));
  onProgress?.("czytam 2/2");
  await new Promise((r) => setTimeout(r, 300));
  return {
    provider: "mock",
    query,
    ms: 1700,
    results: [
      { title: `Wynik o: ${query}`, url: "https://example.org/", snippet: "Pierwszy wynik testowy.", content: `To jest treść testowa strony o "${query}". Nic prawdziwego, tryb mock.` },
      { title: "Drugi wynik", url: "https://example.org/b", snippet: "Drugi wynik testowy.", content: "Druga strona też nic nie wie." },
      { title: "Trzeci wynik", url: "https://example.org/c", snippet: "Tylko snippet." },
    ],
  };
}
