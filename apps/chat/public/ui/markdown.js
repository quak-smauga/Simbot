// MARKDOWN — odpowiedzi simów: nagłówki, akapity, listy (zagnieżdżone, numerowane, checkboxy), cytaty, kod (```), tabele, linie,
// inline: **pogrubienie**, *kursywa*, ~~skreślenie~~, `kod`, [linki](https://…), gołe adresy, @wzmianki.
// Bezpieczne: każdy tekst idzie przez esc(), linki tylko http(s)/mailto.
//
// Streaming (md(text, { streaming: true })): tekst przychodzi po kawałku i co klatkę renderujemy całość od nowa — więc ogon,
// który jeszcze nie jest skończoną konstrukcją, przytrzymujemy, zamiast pokazywać surowe znaczki i potem „przeskakiwać”:
//   • niedokończony wiersz tabeli → czeka na \n (tabela rośnie całymi wierszami, kolumny się nie rozjeżdżają)
//   • nagłówek tabeli bez linii |---| → placeholder „tabela…”, dopóki nie wiadomo, że to tabela
//   • niedomknięty link [tekst](… → czeka na „)”
//   • niedomknięte **, ~~, ` → domykamy tymczasowo (pogrubienie widać od razu, bez gwiazdek)
//   • samotny znacznik na końcu („-”, „1.”, „#”, „>”) → czeka na treść
//   • otwarty blok ``` → renderuje się jako kod od razu (kod „pisze się” w ramce)
import { mentions } from './dom.js';
import { icon } from './icons.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const RE = {
  fence: /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/,
  hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  quote: /^\s{0,3}>\s?/,
  item: /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/,
  sep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
};
const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '  ').length;
const isTableStart = (l, next) => next !== undefined && l.includes('|') && next.includes('|') && next.includes('-') && RE.sep.test(next);
const isBlockStart = (l, next) => RE.fence.test(l) || RE.hr.test(l) || RE.heading.test(l) || RE.quote.test(l) || RE.item.test(l) || isTableStart(l, next);

/** Główne wejście. opts: { user, known } dla @wzmianek, streaming: true w trakcie pisania. */
export function md(src, opts = {}) {
  let text = String(src ?? '').replace(/\r\n?/g, '\n');
  let pending = '';
  if (opts.streaming) ({ text, pending } = holdBack(text));
  const html = blocks(text.split('\n'), opts);
  return html + (pending ? `<div class="md-pending"><span></span><span></span><span></span>${esc(pending)}</div>` : '');
}

// ───────── bloki ─────────
function blocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }

    let m;
    if ((m = RE.fence.exec(l))) {
      const fence = m[1], lang = m[2];
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) { closed = true; i++; break; }
        body.push(lines[i]); i++;
      }
      out.push(codeBlock(lang, body.join('\n'), !closed));
      continue;
    }
    if (RE.hr.test(l)) { out.push('<hr>'); i++; continue; }
    if ((m = RE.heading.exec(l))) {
      const lvl = Math.min(3, m[1].length);
      out.push(`<h${lvl + 2} class="md-h md-h${lvl}">${inline(m[2], opts)}</h${lvl + 2}>`);
      i++; continue;
    }
    if (isTableStart(l, lines[i + 1])) {
      const rows = [l];
      const sep = lines[i + 1];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++]);
      out.push(table(rows[0], sep, rows.slice(1), opts));
      continue;
    }
    if (RE.quote.test(l)) {
      const q = [];
      while (i < lines.length && lines[i].trim() && (RE.quote.test(lines[i]) || !isBlockStart(lines[i], lines[i + 1]))) q.push(lines[i++].replace(RE.quote, ''));
      out.push(`<blockquote>${blocks(q, opts)}</blockquote>`);
      continue;
    }
    if (RE.item.test(l)) {
      const r = list(lines, i, opts);
      out.push(r.html); i = r.next;
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && (p.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) p.push(lines[i++].trim());
    out.push(`<p>${p.map(x => inline(x, opts)).join('<br>')}</p>`);
  }
  return out.join('');
}

function list(lines, start, opts) {
  const first = RE.item.exec(lines[start]);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) {
      // wiersz należy do poprzedniego punktu? (wcięty albo leniwa kontynuacja akapitu)
      if (items.length && lines[i].trim() && (indentOf(lines[i]) > base || !isBlockStart(lines[i], lines[i + 1]))) { items.at(-1).body.push(lines[i]); i++; continue; }
      if (items.length && !lines[i].trim()) {
        // pusta linia: lista trwa, jeśli dalej jest kolejny punkt albo wcięta treść
        let j = i; while (j < lines.length && !lines[j].trim()) j++;
        const nm = j < lines.length && RE.item.exec(lines[j]);
        if (j < lines.length && (indentOf(lines[j]) > base || (nm && indentOf(lines[j]) === base && /\d/.test(nm[2]) === ordered))) { items.at(-1).body.push(''); i = j; continue; }
      }
      break;
    }
    items.push({ num: parseInt(m[2], 10), body: [m[3]] });
    i++;
  }
  const html = items.map(it => {
    let [head, ...rest] = it.body;
    let task = '';
    const t = /^\[( |x|X)\]\s+(.*)$/.exec(head);
    if (t) { task = `<span class="md-check${t[1] === ' ' ? '' : ' on'}">${t[1] === ' ' ? '' : icon('check', 12)}</span>`; head = t[2]; }
    const ind = Math.min(...rest.filter(x => x.trim()).map(indentOf), 99);
    const sub = rest.map(x => x.slice(Math.min(ind, indentOf(x))));
    const nested = sub.some(x => x.trim()) ? blocks(sub, opts) : '';
    return `<li${task ? ' class="md-task"' : ''}>${task}${inline(head, opts)}${nested}</li>`;
  }).join('');
  const startAttr = ordered && items[0].num !== 1 ? ` start="${items[0].num}"` : '';
  return { html: ordered ? `<ol${startAttr}>${html}</ol>` : `<ul>${html}</ul>`, next: i };
}

/** Dzieli wiersz tabeli po |, ale nie wewnątrz `kodu` i nie po \|. */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = []; let cur = '', code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
const NUM = /^[-+−]?\s?(?:[$€£]\s?)?\d[\d\s.,]*(?:\s?(?:%|zł|pln|eur|usd|€|\$|k|tys\.?|mln|mld|h|min|s|ms|kg|g|km|m|°c))?$/i;

function table(headLine, sepLine, rowLines, opts) {
  const head = cells(headLine);
  const n = head.length;
  const align = cells(sepLine).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const rows = rowLines.map(r => { const c = cells(r); return Array.from({ length: n }, (_, k) => c[k] ?? ''); });
  // kolumny liczbowe (ceny, procenty, czasy) → do prawej, cyfry równej szerokości
  const num = head.map((_, k) => !align[k] && rows.length > 0 && rows.every(r => !r[k] || NUM.test(r[k].replace(/\*\*/g, ''))) && rows.some(r => r[k]));
  const cls = k => [align[k] ? `a-${align[k]}` : '', num[k] ? 'num' : ''].filter(Boolean).join(' ');
  const td = (tag, v, k) => `<${tag}${cls(k) ? ` class="${cls(k)}"` : ''}>${inline(v, opts)}</${tag}>`;
  return `<div class="md-table"><table><thead><tr>${head.map((h, k) => td('th', h, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((v, k) => td('td', v, k)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function codeBlock(lang, code, open) {
  return `<div class="md-code${open ? ' open' : ''}"><div class="md-code__bar"><span>${esc(lang || 'kod')}</span><button class="md-code__copy" type="button" title="Kopiuj kod" data-copy-code>${icon('copy', 14)}<span>kopiuj</span></button></div><pre><code>${esc(code.replace(/\n+$/, ''))}</code></pre></div>`;
}

// ───────── inline ─────────
function inline(src, opts) {
  const keep = [];
  const hold = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = esc(s);
  // [tekst](url) — tylko bezpieczne schematy
  s = s.replace(/\[([^\]\n]+)\]\(\s*((?:https?:\/\/|mailto:)[^\s)]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/gi, (_, t, u) => hold(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`));
  // gołe adresy → krótki link (domena + początek ścieżki)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_, pre, u) => {
    let label = u.replace(/^https?:\/\/(www\.)?/, '');
    if (label.length > 42) label = label.slice(0, 40) + '…';
    return pre + hold(`<a href="${u}" target="_blank" rel="noopener">${label}</a>`);
  });
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<b>$2</b>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<i>$2</i>').replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>');
  s = mentions(s, opts);
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => keep[k]);
}

// ───────── streaming: co przytrzymać na końcu ─────────
function holdBack(text) {
  const lines = text.split('\n');
  // otwarty ``` → zostaw, kod renderuje się w otwartej ramce
  let inFence = false;
  for (const l of lines) if (RE.fence.test(l)) inFence = !inFence;
  if (inFence) return { text, pending: '' };

  let tail = lines.pop(); // ostatni, niedokończony wiersz (bez \n)
  // tabela: niepełny wiersz czeka na \n
  if (/^\s*\|/.test(tail)) tail = '';
  // samotny znacznik bloku czeka na treść
  if (/^\s*(?:[-*+•]|\d{1,3}[.)]|#{1,6}|>|`{1,2}|~{1,2})?\s*$/.test(tail)) tail = '';

  // ostatnia grupa wierszy „| …” bez linii |---| pod pierwszym → jeszcze nie wiadomo, czy to tabela → placeholder
  let pending = '';
  let k = lines.length;
  while (k > 0 && /^\s*\|/.test(lines[k - 1])) k--;
  const group = lines.slice(k);
  if (group.length && !(group.length >= 2 && RE.sep.test(group[1]))) { lines.splice(k); pending = 'tabela…'; }

  if (tail) {
    // niedomknięty link → czeka na „)”
    tail = tail.replace(/\[[^\]\n]*(?:\]\([^)\n]*)?$/, '');
    // wiszące znaczniki na samym końcu („**”, „~”, „`”) → czekają na treść
    tail = tail.replace(/(?:\*+|~+|`+|_+)$/, '');
    // niedomknięte ** / ~~ / ` → tymczasowo domknięte
    const plain = tail.replace(/`[^`]*`/g, '');
    if (((tail.match(/`/g) || []).length) % 2) tail += '`';
    else {
      if (((plain.match(/\*\*/g) || []).length) % 2) tail += '**';
      if (((plain.match(/~~/g) || []).length) % 2) tail += '~~';
    }
    lines.push(tail);
  }
  return { text: lines.join('\n'), pending };
}
