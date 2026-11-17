// HTML → czytelny tekst dla LLM. Readability (jak w Firefoksie "widok czytnika") na linkedom,
// a gdy Readability nie znajdzie artykułu — prosty stripper (script/style/nav out, zbijanie białych znaków).
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export interface Readable {
  title: string;
  text: string;
  byline?: string;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toReadable(html: string, url: string): Readable {
  let title = "";
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tm) title = stripHtml(tm[1]);
  try {
    const { document } = parseHTML(html);
    // linkedom nie ustawia baseURI z URL-a — Readability tego nie potrzebuje do tekstu
    const art = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    if (art && art.textContent && art.textContent.trim().length > 200) {
      return { title: art.title || title, text: normalizeWs(art.textContent), byline: art.byline ?? undefined };
    }
  } catch {
    /* fallback niżej */
  }
  return { title: title || url, text: stripHtml(html) };
}

function normalizeWs(s: string): string {
  return s
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Przycina do limitu na granicy zdania/akapitu, żeby LLM nie dostał urwanego słowa. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (at >= max * 0.5 ? cut.slice(0, at + 1) : cut).trim() + " …";
}
