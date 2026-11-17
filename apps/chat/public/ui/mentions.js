// MENTIONS — podpowiedzi @ w composerze. Piszesz "@" → lista simów (+ Ty), filtrowana w locie; po wybraniu sima
// "." → akcje (@sim.task). Strzałki / Tab / Enter wybierają, Esc chowa. Parser po stronie serwera robi resztę.
import { esc } from './dom.js';
import { makeAvatar } from './avatar.js';

const ACTIONS = [{ name: 'task', label: 'zleć zadanie', desc: 'wykonaj narzędziami i zaraportuj' }];

/** items(): [{ name, label, desc, cfg, kind:'sim'|'user' }] */
export function attachMentions(textarea, { items, anchor }) {
  const pop = document.createElement('div'); pop.className = 'mpop'; pop.hidden = true;
  anchor.append(pop);
  let list = [], idx = 0, range = null; // range = { start, end, mode:'name'|'action', name }

  function scan() {
    const v = textarea.value, c = textarea.selectionStart;
    const before = v.slice(0, c);
    const m = /(^|[^\p{L}\p{N}_@])@([a-z0-9-]*)(?:\.([a-z]*))?$/iu.exec(before);
    if (!m) return null;
    const start = c - m[0].length + m[1].length;
    if (m[3] !== undefined) return { start, end: c, mode: 'action', name: m[2].toLowerCase(), q: m[3].toLowerCase() };
    return { start, end: c, mode: 'name', q: m[2].toLowerCase() };
  }
  function render() {
    range = scan();
    if (!range) return hide();
    if (range.mode === 'name') {
      list = items().filter(i => i.name.startsWith(range.q)).slice(0, 8).map(i => ({ ...i, insert: `@${i.name}` }));
    } else {
      const sim = items().find(i => i.name === range.name && i.kind === 'sim');
      list = sim ? ACTIONS.filter(a => a.name.startsWith(range.q)).map(a => ({ name: a.name, label: `@${sim.name}.${a.name}`, desc: `${a.label} — ${a.desc}`, cfg: sim.cfg, insert: `@${sim.name}.${a.name}` })) : [];
    }
    if (!list.length) return hide();
    idx = Math.min(idx, list.length - 1);
    pop.innerHTML = list.map((i, n) => `<button class="mpop__i${n === idx ? ' on' : ''}" data-i="${n}"><span class="av"></span><b>${esc(i.label)}</b><small>${esc(i.desc || '')}</small>${i.kind === 'user' ? '<span class="tag">Ty</span>' : i.kind === 'sim' ? '<span class="tag">sim</span>' : ''}</button>`).join('');
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
