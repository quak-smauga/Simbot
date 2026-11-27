// MENTIONS — podpowiedzi @ w composerze. Piszesz "@" → lista simów (+ Ty), filtrowana w locie; po wybraniu sima
// "." → akcje (@sim.task). Pliki i foldery rozmowy też: "@ra" podpowiada simy, a pod nimi pasujące pliki; "@[" — same
// pliki (dowolne znaki w nazwie). Wybrany plik wstawia się jako @[ścieżka] — serwer dorzuca go (folder: całą
// zawartość) do tej tury. Strzałki / Tab / Enter wybierają, Esc chowa. Parser po stronie serwera robi resztę.
import { esc } from './dom.js';
import { makeAvatar } from './avatar.js';
import { icon } from './icons.js';

const ACTIONS = [{ name: 'task', label: 'zleć zadanie', desc: 'wykonaj narzędziami i zaraportuj' }];

const fileIcon = e => (e.type === 'dir' ? 'folder' : e.kind === 'image' ? 'image' : e.kind === 'pdf' || e.kind === 'text' ? 'file-text' : 'file');
/** Pliki pasujące do zapytania: najpierw nazwy od niego zaczynające się, potem zawierające; foldery przed plikami. */
function matchFiles(all, q, n) {
  const s = q.toLowerCase();
  const hit = all.filter(e => !s || e.name.toLowerCase().includes(s) || e.path.toLowerCase().includes(s));
  const rank = e => (e.name.toLowerCase().startsWith(s) ? 0 : 1) * 2 + (e.type === 'dir' ? 0 : 1);
  return hit.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'pl')).slice(0, n)
    .map(e => ({ name: e.path, label: e.name + (e.type === 'dir' ? '/' : ''), desc: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '', kind: 'file', icon: fileIcon(e), insert: `@[${e.path}]`, entry: e }));
}

/** items(): [{ name, label, desc, cfg, kind:'sim'|'user' }]; files(): wpisy z folderu rozmowy ({ name, path, type, kind }). */
export function attachMentions(textarea, { items, anchor, files = () => [] }) {
  const pop = document.createElement('div'); pop.className = 'mpop'; pop.hidden = true;
  anchor.append(pop);
  let list = [], idx = 0, range = null; // range = { start, end, mode:'name'|'action', name }

  function scan() {
    const v = textarea.value, c = textarea.selectionStart;
    const before = v.slice(0, c);
    const f = /(^|[^\p{L}\p{N}_@])@\[([^\]\n]*)$/u.exec(before);
    if (f) return { start: c - f[0].length + f[1].length, end: c, mode: 'file', q: f[2] };
    const m = /(^|[^\p{L}\p{N}_@])@([a-z0-9-]*)(?:\.([a-z]*))?$/iu.exec(before);
    if (!m) return null;
    const start = c - m[0].length + m[1].length;
    if (m[3] !== undefined) return { start, end: c, mode: 'action', name: m[2].toLowerCase(), q: m[3].toLowerCase() };
    return { start, end: c, mode: 'name', q: m[2].toLowerCase() };
  }
  function render() {
    range = scan();
    if (!range) return hide();
    if (range.mode === 'file') {
      list = matchFiles(files(), range.q, 10);
    } else if (range.mode === 'name') {
      const sims = items().filter(i => i.name.startsWith(range.q)).slice(0, 8).map(i => ({ ...i, insert: `@${i.name}` }));
      list = [...sims, ...matchFiles(files(), range.q, Math.max(3, 9 - sims.length))];
    } else {
      const sim = items().find(i => i.name === range.name && i.kind === 'sim');
      list = sim ? ACTIONS.filter(a => a.name.startsWith(range.q)).map(a => ({ name: a.name, label: `@${sim.name}.${a.name}`, desc: `${a.label} — ${a.desc}`, cfg: sim.cfg, insert: `@${sim.name}.${a.name}` })) : [];
    }
    if (!list.length) return hide();
    idx = Math.min(idx, list.length - 1);
    pop.innerHTML = list.map((i, n) => `${i.kind === 'file' && (n === 0 || list[n - 1].kind !== 'file') ? `<div class="mpop__k">pliki rozmowy</div>` : ''}<button class="mpop__i${n === idx ? ' on' : ''}${i.kind === 'file' ? ' f' : ''}" data-i="${n}"><span class="av">${i.icon ? icon(i.icon, 15) : ''}</span><b>${esc(i.label)}</b><small>${esc(i.desc || '')}</small>${i.kind === 'user' ? '<span class="tag">Ty</span>' : i.kind === 'sim' ? '<span class="tag">sim</span>' : i.entry?.type === 'dir' ? '<span class="tag">folder</span>' : ''}</button>`).join('');
    pop.querySelectorAll('.mpop__i').forEach(b => { const it = list[Number(b.dataset.i)]; if (it.cfg) b.querySelector('.av').append(makeAvatar({ ...it.cfg, id: '' }, 24)); b.onmousedown = e => { e.preventDefault(); pick(Number(b.dataset.i)); }; });
    pop.hidden = false;
  }
  function hide() { pop.hidden = true; list = []; range = null; }
  function pick(n) {
    const it = list[n]; if (!it || !range) return;
    const v = textarea.value;
    const tail = v.slice(range.end);
    const ins = it.insert + (tail.startsWith(' ') ? '' : ' ');
    textarea.value = v.slice(0, range.start) + ins + tail;
    const pos = range.start + ins.length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input'));
    hide();
    textarea.focus();
  }
  textarea.addEventListener('input', e => {
    // po wyborze sima wstawiamy spację; kropka zaraz po niej = akcja → sklej "@sim ." w "@sim."
    if (e.inputType === 'insertText' && e.data === '.') {
      const c = textarea.selectionStart, v = textarea.value;
      const m = /@[a-z0-9-]+ \.$/i.exec(v.slice(0, c));
      if (m) { textarea.value = v.slice(0, c - 2) + '.' + v.slice(c); textarea.setSelectionRange(c - 1, c - 1); }
    }
    render();
  });
  textarea.addEventListener('click', render);
  textarea.addEventListener('blur', () => setTimeout(hide, 120));
  textarea.addEventListener('keydown', e => {
    if (pop.hidden) return;
    if (e.key === 'ArrowDown') { idx = (idx + 1) % list.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = (idx - 1 + list.length) % list.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { pick(idx); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Escape') { hide(); e.stopPropagation(); }
  }, true);
  return { hide, get open() { return !pop.hidden; } };
}
