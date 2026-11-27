// PLIKI ROZMOWY — panel po prawej (przełącznik w nagłówku). Myślenie jak w Finderze, bez udawania systemu:
//   • nawigacja: wejście w folder (dwuklik / Enter), wstecz–dalej (‹ ›, ⌘[ ⌘]), okruszki (klik = skok, upuść = przenieś),
//     ⌘↑ folder wyżej; przejście między folderami to krótki slajd (w głąb → z prawej, w górę → z lewej),
//   • widoki: lista (nazwa · rozmiar · data, klik w nagłówek sortuje) i siatka z miniaturami; wybór zapamiętany,
//   • zaznaczanie: klik, ⌘klik, ⇧klik (zakres), ⌘A, strzałki; Spacja = podgląd (←/→ między plikami), F2 = zmiana nazwy,
//     ⌫ = usuń (z potwierdzeniem), Esc = odznacz,
//   • zmiana nazwy w miejscu (zaznaczona nazwa bez rozszerzenia), nowy folder od razu w trybie zmiany nazwy,
//   • przeciąganie: pliki z systemu → do bieżącego folderu albo na folder; wiersz → na folder / okruszek = przeniesienie;
//     wiersz → do pola wiadomości = @[ścieżka] (sim dostaje ten plik albo cały folder w tej turze),
//   • menu kontekstowe, szukanie (w całym folderze rozmowy), pasek stanu (ile elementów, zaznaczone, rozmiar).
import { $, api, confirmBox, esc, toast } from './dom.js';
import { icon } from './icons.js';
import { fileUrl, isImageName, shrink } from './attach.js';

const MIME_DRAG = 'application/x-simbot-paths';
const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const when = iso => {
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `dziś, ${t}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `wczoraj, ${t}`;
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
};
const baseOf = p => p.split('/').pop();
const parentOf = p => p.split('/').slice(0, -1).join('/');
const join = (a, b) => (a ? `${a}/${b}` : b);
const KIND_PL = { image: 'obraz', pdf: 'PDF', text: 'tekst', other: 'plik' };
const kindIcon = e => (e.type === 'dir' ? 'folder' : e.kind === 'image' ? 'image' : e.kind === 'pdf' || e.kind === 'text' ? 'file-text' : 'file');
const plural = (n, a, b, c) => (n === 1 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const items = n => `${n} ${plural(n, 'element', 'elementy', 'elementów')}`;

export function initFiles({ root, toggleBtn, session, onMention, onOpenChange }) {
  const st = {
    sid: null, cwd: '', back: [], fwd: [], entries: [], all: [], sel: new Set(), anchor: null, q: '',
    view: localStorage.getItem('qwe.files.view') || 'list',
    sort: JSON.parse(localStorage.getItem('qwe.files.sort') || '{"key":"name","dir":1}'),
    renaming: null, slide: '', uploads: [], loading: false,
  };
  const open = () => document.body.dataset.files === 'open';

  root.innerHTML = `<div class="fp">
    <div class="fp__head"><span class="fp__title">Pliki</span><span class="fp__count" id="fpCount"></span><span class="sp"></span>
      <button class="ib" id="fpUp" title="Dodaj pliki">${icon('upload', 17)}</button>
      <button class="ib" id="fpMk" title="Nowy folder (⇧⌘N)">${icon('folder-plus', 17)}</button>
      <button class="ib" id="fpView" title="Widok"></button>
      <button class="ib" id="fpClose" title="Zamknij (⇧⌘F)">${icon('x', 17)}</button></div>
    <div class="fp__bar"><button class="ib ib--s" id="fpBack" title="Wstecz (⌘[)">${icon('chevron-left', 16)}</button><button class="ib ib--s" id="fpFwd" title="Dalej (⌘])">${icon('chevron-right', 16)}</button><nav class="fp__crumbs" id="fpCrumbs"></nav></div>
    <label class="fp__search">${icon('search', 14)}<input id="fpQ" placeholder="Szukaj w plikach rozmowy" spellcheck="false" /></label>
    <div class="fp__body" id="fpBody" tabindex="0" role="listbox" aria-multiselectable="true"></div>
    <div class="fp__foot"><span id="fpStatus"></span><span class="sp"></span><button class="fp__link" id="fpFinder">Pokaż w Finderze</button></div>
    <input type="file" id="fpInput" multiple hidden />
  </div>`;
  const body = $('fpBody');
  const ctx = document.createElement('div'); ctx.className = 'fp__ctx'; ctx.hidden = true; document.body.append(ctx);

  // ───────── dane ─────────
  const base = () => `/api/sessions/${encodeURIComponent(st.sid)}/files`;
  async function load(dir = st.cwd) {
    if (!st.sid) return;
    st.loading = !st.entries.length;
    try {
      const [d, a] = await Promise.all([api.get(`${base()}?dir=${encodeURIComponent(dir)}`), api.get(`${base()}?all=1`)]);
      st.entries = d.entries; st.all = a.entries;
    } catch (e) {
      if (dir) { st.cwd = ''; return load(''); } // folder zniknął (np. zmieniony w Finderze) → do korzenia
      st.entries = []; st.all = [];
    }
    st.loading = false;
    const live = new Set(st.entries.map(e => e.path));
    st.sel = new Set([...st.sel].filter(p => live.has(p)));
    render();
  }
  async function go(dir, { push = true, slide } = {}) {
    if (dir === st.cwd && !st.q) return;
    if (push) { st.back.push(st.cwd); st.fwd = []; }
    st.slide = slide || (dir.startsWith(st.cwd) && dir.length > st.cwd.length ? 'in' : 'out');
    st.cwd = dir; st.sel.clear(); st.anchor = null; st.q = ''; $('fpQ').value = '';
    await load(dir);
  }
  const goBack = () => { if (st.back.length) { st.fwd.push(st.cwd); go(st.back.pop(), { push: false, slide: 'out' }); } };
  const goFwd = () => { if (st.fwd.length) { st.back.push(st.cwd); go(st.fwd.pop(), { push: false, slide: 'in' }); } };
  const goUp = () => { if (st.cwd) go(parentOf(st.cwd), { slide: 'out' }); };

  /** Widoczne wpisy: folder albo wyniki szukania; posortowane, foldery najpierw. */
  function shown() {
    const q = st.q.trim().toLowerCase();
    const list = q ? st.all.filter(e => e.name.toLowerCase().includes(q)) : st.entries.slice();
    const { key, dir } = st.sort;
    const val = e => (key === 'size' ? (e.type === 'dir' ? -1 : e.size) : key === 'mtime' ? e.mtime : key === 'kind' ? (e.type === 'dir' ? '' : KIND_PL[e.kind] || '') : e.name.toLowerCase());
    return list.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : a.name.localeCompare(b.name, 'pl')) * dir));
  }

  // ───────── render ─────────
  function thumb(e, size) {
    if (e.type === 'file' && e.kind === 'image') return `<span class="fp__th img"><img src="${fileUrl(st.sid, e.path)}?v=${encodeURIComponent(e.mtime)}" alt="" loading="lazy" draggable="false" /></span>`;
    return `<span class="fp__th ${e.type === 'dir' ? 'dir' : esc(e.kind || 'other')}">${icon(kindIcon(e), size)}</span>`;
  }
  function nameHtml(e) {
    if (st.renaming === e.path) return `<input class="fp__ren" value="${esc(e.name)}" spellcheck="false" />`;
    return `<span class="fp__n" title="${esc(e.path)}">${esc(e.name)}</span>`;
  }
  function render() {
    $('fpView').innerHTML = icon(st.view === 'list' ? 'layout-grid' : 'list', 17);
    $('fpView').title = st.view === 'list' ? 'Widok: siatka' : 'Widok: lista';
    $('fpBack').disabled = !st.back.length; $('fpFwd').disabled = !st.fwd.length;
    // okruszki
    const parts = st.cwd ? st.cwd.split('/') : [];
    $('fpCrumbs').innerHTML = st.q.trim()
      ? `<span class="fp__crumb on">Wyniki: „${esc(st.q.trim())}”</span>`
      : [`<button class="fp__crumb${parts.length ? '' : ' on'}" data-go="">${icon('folder', 14)}Pliki</button>`, ...parts.map((p, i) => `<span class="fp__sep">${icon('chevron-right', 12)}</span><button class="fp__crumb${i === parts.length - 1 ? ' on' : ''}" data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)].join('');
    const list = shown();
    const q = st.q.trim();
    let html;
    if (st.loading) html = `<div class="fp__sk">${'<span class="sk sk--line"></span>'.repeat(5)}</div>`;
    else if (!list.length && !st.uploads.length) {
      html = q
        ? `<div class="fp__empty">${icon('search', 28)}<b>Nic nie pasuje</b><span>Szukam w nazwach wszystkich plików tej rozmowy.</span></div>`
        : `<div class="fp__empty">${icon(st.cwd ? 'folder-open' : 'folder', 30)}<b>${st.cwd ? 'Pusty folder' : 'Tu będą pliki rozmowy'}</b><span>Przeciągnij pliki tutaj albo <button class="fp__link" data-act="upload">wybierz z dysku</button>. W wiadomości wskażesz je przez <code>@[nazwa]</code>.</span></div>`;
    } else if (st.view === 'grid') {
      html = `<div class="fp__grid">${list.map(e => `<div class="fp__tile${st.sel.has(e.path) ? ' sel' : ''}" data-p="${esc(e.path)}" data-t="${e.type}" draggable="true" role="option" aria-selected="${st.sel.has(e.path)}">${thumb(e, 30)}${nameHtml(e)}${q ? `<small>${esc(parentOf(e.path) || 'Pliki')}</small>` : `<small>${e.type === 'dir' ? items(e.items) : kb(e.size)}</small>`}</div>`).join('')}${upRows()}</div>`;
    } else {
      const h = (key, label) => `<button class="fp__hc${st.sort.key === key ? ' on' : ''}" data-sort="${key}">${label}${st.sort.key === key ? icon(st.sort.dir > 0 ? 'chevron-up' : 'chevron-down', 12) : ''}</button>`;
      html = `<div class="fp__lh">${h('name', 'Nazwa')}${h('size', 'Rozmiar')}${h('mtime', 'Zmieniono')}</div><div class="fp__list">${list.map(e => `<div class="fp__row${st.sel.has(e.path) ? ' sel' : ''}" data-p="${esc(e.path)}" data-t="${e.type}" draggable="true" role="option" aria-selected="${st.sel.has(e.path)}">${thumb(e, 16)}<span class="fp__nm">${nameHtml(e)}${q && parentOf(e.path) ? `<small>${esc(parentOf(e.path))}</small>` : ''}</span><span class="fp__sz">${e.type === 'dir' ? items(e.items) : kb(e.size)}</span><span class="fp__dt">${when(e.mtime)}</span></div>`).join('')}${upRows()}</div>`;
    }
    body.innerHTML = `<div class="fp__pane${st.slide ? ' slide-' + st.slide : ''}">${html}</div>`;
    st.slide = '';
    paintSel();
    const files = st.all.filter(e => e.type === 'file').length;
    $('fpCount').textContent = files ? String(files) : '';
    toggleBtn.dataset.count = files ? String(files) : '';
    // zmiana nazwy: focus + zaznaczenie bez rozszerzenia
    const ren = body.querySelector('.fp__ren');
    if (ren) {
      ren.focus();
      const dot = ren.value.lastIndexOf('.');
      ren.setSelectionRange(0, body.querySelector('.fp__ren').closest('[data-t="file"]') && dot > 0 ? dot : ren.value.length);
      ren.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(ren.value); if (e.key === 'Escape') { st.renaming = null; render(); body.focus(); } };
      ren.onblur = () => st.renaming && commitRename(ren.value);
      ren.onclick = e => e.stopPropagation();
      ren.ondblclick = e => e.stopPropagation();
    }
  }
  /** Zaznaczenie bez przerysowania (przerysowanie w dragstart przerwałoby przeciąganie, a miniatury by mrugały). */
  function paintSel() {
    body.querySelectorAll('[data-p]').forEach(el => { const on = st.sel.has(el.dataset.p); el.classList.toggle('sel', on); el.setAttribute('aria-selected', on); });
    const list = shown(), sel = list.filter(e => st.sel.has(e.path));
    const bytes = (sel.length ? sel : list).reduce((s, e) => s + (e.type === 'file' ? e.size : 0), 0);
    $('fpStatus').textContent = sel.length ? `${sel.length} z ${items(list.length)} · ${kb(bytes)}` : `${items(list.length)}${bytes ? ' · ' + kb(bytes) : ''}`;
  }
  const upRows = () => st.uploads.map(u => `<div class="${st.view === 'grid' ? 'fp__tile' : 'fp__row'} up"><span class="fp__th">${icon('file', 16)}</span><span class="fp__nm"><span class="fp__n">${esc(u.name)}</span></span><span class="fp__spin"></span></div>`).join('');

  // ───────── akcje ─────────
  const byPath = p => shown().find(e => e.path === p) || st.all.find(e => e.path === p);
  const selected = () => shown().filter(e => st.sel.has(e.path));
  function openEntry(e) {
    if (!e) return;
    if (e.type === 'dir') go(e.path, { slide: 'in' });
    else quickLook(e);
  }
  async function commitRename(value) {
    const from = st.renaming; st.renaming = null;
    const name = value.trim();
    if (!from || !name || name === baseOf(from)) { render(); return; }
    if (/[/\\[\]]/.test(name)) { toast('Nazwa nie może zawierać / \\ [ ]'); render(); return; }
    try { const r = await api.post(`${base()}/move`, { from, to: join(parentOf(from), name) }); st.sel = new Set([r.path]); } catch (e) { toast(e.message); }
    await load(); body.focus();
  }
  function rename(p) { if (!p || st.q) return; st.renaming = p; st.sel = new Set([p]); render(); }
  async function mkdir() {
    if (!st.sid) return;
    if (st.q) { st.q = ''; $('fpQ').value = ''; }
    try { const r = await api.post(`${base()}/mkdir`, { parent: st.cwd }); await load(); rename(r.path); } catch (e) { toast(e.message); }
  }
  async function remove(list = selected()) {
    if (!list.length) return;
    const what = list.length === 1 ? `„${list[0].name}”` : items(list.length);
    const dirs = list.filter(e => e.type === 'dir').length;
    if (!(await confirmBox(`Usunąć ${what}?`, `${dirs ? 'Razem z zawartością folderów. ' : ''}Pliki znikną z folderu rozmowy na dobre — nie trafiają do kosza.`, 'Usuń'))) return;
    try { await api.post(`${base()}/delete`, { paths: list.map(e => e.path) }); } catch (e) { toast(e.message); }
    st.sel.clear(); await load();
  }
  async function move(paths, target) {
    const todo = paths.filter(p => p !== target && parentOf(p) !== target && !target.startsWith(p + '/'));
    if (!todo.length) return;
    let ok = 0;
    for (const p of todo) { try { await api.post(`${base()}/move`, { from: p, to: join(target, baseOf(p)) }); ok++; } catch (e) { toast(e.message); } }
    if (ok) toast(`Przeniesiono ${items(ok)} do ${target ? `„${baseOf(target)}”` : 'głównego folderu'}`);
    st.sel.clear(); await load();
  }
  async function upload(fileList, dir = st.cwd) {
    const files = [...fileList];
    if (!files.length || !st.sid) return;
    const sid = st.sid;
    const ups = files.map(f => ({ name: f.name || 'plik' }));
    if (dir === st.cwd) { st.uploads.push(...ups); render(); }
    const done = [];
    await Promise.all(files.map(async (f, i) => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/files?name=${encodeURIComponent(ups[i].name)}&dir=${encodeURIComponent(dir)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await shrink(f) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || r.statusText);
        done.push(d.name);
      } catch (e) { toast(`${ups[i].name}: ${e.message}`); }
    }));
    st.uploads = st.uploads.filter(u => !ups.includes(u));
    if (sid !== st.sid) return;
    st.sel = new Set(done.filter(p => parentOf(p) === st.cwd));
    await load();
  }
  const finder = async path => { try { await api.post(`${base()}/open`, path ? { path } : {}); } catch (e) { toast(e.message); } };
  const mention = list => list.length && onMention(list.map(e => e.path));

  // ───────── podgląd (Spacja) ─────────
  let ql = null;
  function quickLook(start) {
    const files = shown().filter(e => e.type === 'file');
    let i = Math.max(0, files.findIndex(e => e.path === start.path));
    closeLook();
    ql = document.createElement('div'); ql.className = 'ql';
    document.body.append(ql);
    const paint = async () => {
      const e = files[i]; if (!e) return closeLook();
      st.sel = new Set([e.path]); paintSel();
      const url = fileUrl(st.sid, e.path);
      ql.innerHTML = `<div class="ql__box"><div class="ql__head"><span class="fp__th ${esc(e.kind)}">${icon(kindIcon(e), 15)}</span><b title="${esc(e.path)}">${esc(e.name)}</b><small>${files.length > 1 ? `${i + 1} / ${files.length} · ` : ''}${KIND_PL[e.kind] || 'plik'}${e.w ? ` ${e.w}×${e.h}` : ''} · ${kb(e.size)}</small><span class="sp"></span>
        <button class="ib ib--s" data-q="mention" title="Wspomnij w wiadomości">${icon('at-sign', 16)}</button><a class="ib ib--s" href="${url}" download="${esc(e.name)}" title="Pobierz">${icon('download', 16)}</a><button class="ib ib--s" data-q="finder" title="Pokaż w Finderze">${icon('external-link', 16)}</button><button class="ib ib--s" data-q="x" title="Zamknij (Esc)">${icon('x', 16)}</button></div>
        <div class="ql__body">${e.kind === 'image' ? `<img src="${url}?v=${encodeURIComponent(e.mtime)}" alt="${esc(e.name)}" />` : e.kind === 'pdf' ? `<iframe src="${url}" title="${esc(e.name)}"></iframe>` : e.kind === 'text' ? '<pre class="ql__txt">…</pre>' : `<div class="fp__empty">${icon('file', 34)}<b>Brak podglądu</b><span>Otwórz w Finderze.</span></div>`}</div>
        ${files.length > 1 ? `<button class="ql__nav l" data-q="prev" title="Poprzedni (←)">${icon('chevron-left', 20)}</button><button class="ql__nav r" data-q="next" title="Następny (→)">${icon('chevron-right', 20)}</button>` : ''}</div>`;
      if (e.kind === 'text') {
        try { const t = await (await fetch(url)).text(); const pre = ql && ql.querySelector('.ql__txt'); if (pre && files[i] === e) pre.textContent = t.length > 200000 ? t.slice(0, 200000) + '\n… (dalej w pliku)' : t; } catch { /* zostaje „…” */ }
      }
    };
    ql.onclick = ev => {
      const b = ev.target.closest('[data-q]');
      if (!b) { if (ev.target === ql) closeLook(); return; }
      const a = b.dataset.q;
      if (a === 'x') closeLook();
      else if (a === 'prev') { i = (i - 1 + files.length) % files.length; paint(); }
      else if (a === 'next') { i = (i + 1) % files.length; paint(); }
      else if (a === 'mention') { mention([files[i]]); closeLook(); }
      else if (a === 'finder') finder(files[i].path);
    };
    ql.onkeydown = null;
    ql._key = ev => {
      if (ev.key === 'Escape' || ev.key === ' ') { ev.preventDefault(); ev.stopImmediatePropagation(); closeLook(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); i = (i - 1 + files.length) % files.length; paint(); }
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); i = (i + 1) % files.length; paint(); }
    };
    document.addEventListener('keydown', ql._key, true);
    paint();
  }
  function closeLook() { if (!ql) return; document.removeEventListener('keydown', ql._key, true); ql.remove(); ql = null; body.focus(); }

  // ───────── menu kontekstowe ─────────
  function menu(x, y, list) {
    const one = list.length === 1 ? list[0] : null;
    const rows = list.length
      ? [
          one && ['open', one.type === 'dir' ? 'folder-open' : 'eye', one.type === 'dir' ? 'Otwórz' : 'Podgląd', 'Spacja'],
          ['mention', 'at-sign', list.length > 1 ? `Wspomnij ${items(list.length)} w wiadomości` : 'Wspomnij w wiadomości', '@'],
          one && !st.q && ['rename', 'pencil', 'Zmień nazwę', 'F2'],
          one && one.type === 'file' && ['download', 'download', 'Pobierz'],
          one && ['finder', 'external-link', 'Pokaż w Finderze'],
          '-',
          ['delete', 'trash-2', list.length > 1 ? `Usuń ${items(list.length)}` : 'Usuń', '⌫', 'bad'],
        ]
      : [['mkdir', 'folder-plus', 'Nowy folder', '⇧⌘N'], ['upload', 'upload', 'Dodaj pliki…'], '-', ['finder', 'external-link', 'Pokaż folder w Finderze']];
    ctx.innerHTML = rows.filter(Boolean).map(r => (r === '-' ? '<hr/>' : `<button data-c="${r[0]}" class="${r[4] || ''}">${icon(r[1], 15)}<span>${esc(r[2])}</span>${r[3] ? `<kbd>${r[3]}</kbd>` : ''}</button>`)).join('');
    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = `${Math.min(x, innerWidth - w - 8)}px`; ctx.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
    ctx.onclick = ev => {
      const c = ev.target.closest('[data-c]')?.dataset.c; if (!c) return;
      ctx.hidden = true;
      if (c === 'open') openEntry(one);
      else if (c === 'mention') mention(list);
      else if (c === 'rename') rename(one.path);
      else if (c === 'download') { const a = document.createElement('a'); a.href = fileUrl(st.sid, one.path); a.download = one.name; a.click(); }
      else if (c === 'finder') finder(one ? one.path : st.cwd);
      else if (c === 'delete') remove(list);
      else if (c === 'mkdir') mkdir();
      else if (c === 'upload') $('fpInput').click();
    };
  }
  document.addEventListener('mousedown', e => { if (!ctx.hidden && !e.target.closest('.fp__ctx')) ctx.hidden = true; }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ctx.hidden) { ctx.hidden = true; e.stopImmediatePropagation(); } }, true);

  // ───────── mysz ─────────
  const itemEl = t => t.closest('[data-p]');
  function clickSelect(e, p) {
    const list = shown().map(x => x.path);
    if (e.shiftKey && st.anchor && list.includes(st.anchor)) {
      const [a, b] = [list.indexOf(st.anchor), list.indexOf(p)].sort((x, y) => x - y);
      st.sel = new Set(list.slice(a, b + 1));
    } else if (e.metaKey || e.ctrlKey) { st.sel.has(p) ? st.sel.delete(p) : st.sel.add(p); st.anchor = p; }
    else { st.sel = new Set([p]); st.anchor = p; }
    paintSel();
  }
  body.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (a && a.dataset.act === 'upload') return $('fpInput').click();
    const s = e.target.closest('[data-sort]');
    if (s) { const k = s.dataset.sort; st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: k === 'mtime' ? -1 : 1 }; localStorage.setItem('qwe.files.sort', JSON.stringify(st.sort)); return render(); }
    const it = itemEl(e.target);
    if (!it) { if (st.sel.size) { st.sel.clear(); paintSel(); } return; }
    // klik w nazwę już jedynego zaznaczonego (z przerwą) = zmiana nazwy, jak w Finderze
    if (!e.metaKey && !e.shiftKey && st.sel.size === 1 && st.sel.has(it.dataset.p) && e.target.closest('.fp__n') && e.detail === 1) {
      clearTimeout(st.renT); st.renT = setTimeout(() => rename(it.dataset.p), 650); return;
    }
    clickSelect(e, it.dataset.p);
  });
  body.addEventListener('dblclick', e => { clearTimeout(st.renT); const it = itemEl(e.target); if (it) openEntry(byPath(it.dataset.p)); });
  body.addEventListener('contextmenu', e => {
    e.preventDefault();
    const it = itemEl(e.target);
    if (it && !st.sel.has(it.dataset.p)) { st.sel = new Set([it.dataset.p]); st.anchor = it.dataset.p; paintSel(); }
    menu(e.clientX, e.clientY, it ? selected() : []);
  });
  $('fpCrumbs').addEventListener('click', e => { const c = e.target.closest('[data-go]'); if (c) go(c.dataset.go); });

  // ───────── klawiatura ─────────
  body.addEventListener('keydown', e => {
    if (st.renaming) return;
    const list = shown();
    const cur = list.findIndex(x => x.path === st.anchor);
    const cols = st.view === 'grid' ? Math.max(1, Math.round(body.clientWidth / (body.querySelector('.fp__tile')?.offsetWidth + 8 || 100))) : 1;
    const moveTo = (i, extend) => {
      const n = Math.max(0, Math.min(list.length - 1, i)); const p = list[n]?.path; if (!p) return;
      if (extend) st.sel.add(p); else st.sel = new Set([p]);
      st.anchor = p; paintSel();
      body.querySelector(`[data-p="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown' && meta) { e.preventDefault(); openEntry(list[cur]); }
    else if (e.key === 'ArrowUp' && meta) { e.preventDefault(); goUp(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(cur < 0 ? 0 : cur + cols, e.shiftKey); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTo(cur < 0 ? 0 : cur - cols, e.shiftKey); }
    else if (e.key === 'ArrowRight' && st.view === 'grid') { e.preventDefault(); moveTo(cur + 1, e.shiftKey); }
    else if (e.key === 'ArrowLeft' && st.view === 'grid') { e.preventDefault(); moveTo(cur - 1, e.shiftKey); }
    else if (e.key === 'Enter') { e.preventDefault(); openEntry(list[cur] || selected()[0]); }
    else if (e.key === ' ') { e.preventDefault(); const f = selected().find(x => x.type === 'file') || list[cur]; if (f && f.type === 'file') quickLook(f); else if (f) openEntry(f); }
    else if (e.key === 'F2') { e.preventDefault(); rename(selected()[0]?.path); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); remove(); }
    else if (e.key === 'a' && meta) { e.preventDefault(); st.sel = new Set(list.map(x => x.path)); paintSel(); }
    else if (e.key === '[' && meta) { e.preventDefault(); goBack(); }
    else if (e.key === ']' && meta) { e.preventDefault(); goFwd(); }
    else if (e.key === '@') { e.preventDefault(); mention(selected()); }
    else if (e.key === 'Escape' && st.sel.size) { e.stopPropagation(); st.sel.clear(); paintSel(); }
  });
  $('fpQ').addEventListener('input', e => { st.q = e.target.value; st.sel.clear(); render(); });
  $('fpQ').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); st.q = ''; e.target.value = ''; render(); body.focus(); } if (e.key === 'ArrowDown') { e.preventDefault(); body.focus(); } });

  // ───────── przeciąganie ─────────
  let dragPaths = null;
  body.addEventListener('dragstart', e => {
    const it = itemEl(e.target); if (!it) return;
    if (!st.sel.has(it.dataset.p)) { st.sel = new Set([it.dataset.p]); st.anchor = it.dataset.p; paintSel(); }
    dragPaths = selected().map(x => x.path);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(MIME_DRAG, JSON.stringify(dragPaths));
    // do pola wiadomości trafia gotowa wzmianka
    e.dataTransfer.setData('text/plain', dragPaths.map(p => `@[${p}]`).join(' ') + ' ');
    const n = dragPaths.length;
    if (n > 1) { const g = document.createElement('div'); g.className = 'fp__ghost'; g.textContent = items(n); document.body.append(g); e.dataTransfer.setDragImage(g, 12, 12); setTimeout(() => g.remove()); }
  });
  body.addEventListener('dragend', () => { dragPaths = null; clearHot(); });
  const isOs = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const isOurs = e => [...(e.dataTransfer?.types || [])].includes(MIME_DRAG);
  let hot = null;
  const clearHot = () => { root.querySelectorAll('.hot').forEach(x => x.classList.remove('hot')); hot = null; };
  /** Cel upuszczenia: folder (wiersz / okruszek) albo bieżący folder (tło panelu, tylko pliki z systemu). */
  function dropTarget(e) {
    const crumb = e.target.closest('[data-go]');
    if (crumb && !st.q) return { el: crumb, dir: crumb.dataset.go };
    const it = itemEl(e.target);
    if (it && it.dataset.t === 'dir' && !(dragPaths || []).includes(it.dataset.p)) return { el: it, dir: it.dataset.p };
    if (isOs(e) && e.target.closest('.fp__body') && !st.q) return { el: body, dir: st.cwd };
    return null;
  }
  root.addEventListener('dragover', e => {
    if (!isOs(e) && !isOurs(e)) return;
    const t = dropTarget(e);
    e.preventDefault(); // bez stopPropagation: attach.js widzi, że to nad panelem, i chowa zasłonę
    e.dataTransfer.dropEffect = t ? (isOs(e) ? 'copy' : 'move') : 'none';
    if (t?.el !== hot) { clearHot(); if (t) { t.el.classList.add('hot'); hot = t.el; } }
  });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) clearHot(); });
  root.addEventListener('drop', e => {
    if (!isOs(e) && !isOurs(e)) return;
    e.preventDefault(); e.stopPropagation();
    const t = dropTarget(e); clearHot();
    if (!t) return;
    if (isOs(e)) upload(e.dataTransfer.files, t.dir);
    else move(JSON.parse(e.dataTransfer.getData(MIME_DRAG) || '[]'), t.dir);
  });

  // ───────── przyciski ─────────
  $('fpUp').onclick = () => $('fpInput').click();
  $('fpInput').onchange = e => { upload(e.target.files); e.target.value = ''; };
  $('fpMk').onclick = mkdir;
  $('fpView').onclick = () => { st.view = st.view === 'list' ? 'grid' : 'list'; localStorage.setItem('qwe.files.view', st.view); render(); };
  $('fpClose').onclick = () => setOpen(false);
  $('fpBack').onclick = goBack; $('fpFwd').onclick = goFwd;
  $('fpFinder').onclick = () => finder(st.cwd);

  function setOpen(on) {
    document.body.dataset.files = on ? 'open' : 'closed';
    localStorage.setItem('qwe.files', on ? 'open' : 'closed');
    toggleBtn.classList.toggle('on', on);
    toggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) { load(); setTimeout(() => body.focus({ preventScroll: true }), 50); }
    onOpenChange && onOpenChange(on);
  }
  toggleBtn.onclick = () => setOpen(!open());
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    if (e.key.toLowerCase() === 'f' && st.sid) { e.preventDefault(); setOpen(!open()); }
    else if (e.key.toLowerCase() === 'n' && open() && root.contains(document.activeElement)) { e.preventDefault(); mkdir(); }
  });
  addEventListener('focus', () => st.sid && load());
  setOpen(localStorage.getItem('qwe.files') === 'open' && matchMedia('(min-width: 960px)').matches);

  return {
    setOpen,
    get isOpen() { return open(); },
    /** Nowa rozmowa: korzeń, czysta historia, świeże dane (wpisy też dla @ w polu wiadomości). */
    setSession(id) { st.sid = id; st.cwd = ''; st.back = []; st.fwd = []; st.sel.clear(); st.q = ''; $('fpQ').value = ''; st.entries = []; st.all = []; render(); if (id) load(); },
    refresh() { if (st.sid) load(); },
    /** Wszystko w folderze rozmowy (płasko) — podpowiedzi @[…]. */
    all() { return st.all; },
    /** Klik w @[ścieżka] w wątku: otwórz panel w folderze rodzica i zaznacz. */
    async reveal(path) {
      const e = st.all.find(x => x.path === path);
      if (!e) { toast(`Nie ma już „${path}” w plikach rozmowy`); return; }
      if (!open()) setOpen(true);
      const dir = e.type === 'dir' ? e.path : parentOf(e.path);
      if (dir !== st.cwd) await go(dir); else await load();
      if (e.type === 'file') { st.sel = new Set([e.path]); st.anchor = e.path; paintSel(); body.querySelector(`[data-p="${CSS.escape(e.path)}"]`)?.scrollIntoView({ block: 'nearest' }); }
    },
    isImageName,
  };
}
