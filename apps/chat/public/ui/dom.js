// DOM — drobiazgi wspólne dla modułów UI: $, esc, @wzmianki, czas, tytuł z emoji, modal, toast.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const isDesktop = () => matchMedia('(min-width: 960px)').matches;
export const timeAgo = iso => { const d = (Date.now() - Date.parse(iso)) / 1000; return d < 60 ? 'teraz' : d < 3600 ? `${Math.floor(d / 60)}m` : d < 86400 ? `${Math.floor(d / 3600)}h` : `${Math.floor(d / 86400)}d`; };
export const clock = iso => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
export const splitTitle = t => { const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+(.*)$/u.exec(t || ''); return m ? { emoji: m[1], text: m[2] } : { emoji: '', text: t || '' }; };
export const wait = ms => new Promise(r => setTimeout(r, ms));

/** @nazwa / @nazwa.akcja → <span class="mention"> (user → mention--me); @[ścieżka] → chip pliku (klik = panel plików).
 *  Działa na tekście już po esc(). */
let mentionColor = () => '';
/** Kolor sima dla pigułek @nazwa (ustawia app.js — wie, jak wyglądają simy). */
export const setMentionColor = fn => { mentionColor = fn; };
export function mentions(html, { user, known } = {}) {
  html = html.replace(/@\[([^\]\n]{1,300})\]/g, (m, path) => {
    const name = path.replace(/\/+$/, '').split('/').pop();
    const dir = !/\.[a-z0-9]{1,6}$/i.test(name);
    return `<button type="button" class="mention mention--file" data-fpath="${path}" title="${path}"><svg class="ic" width="13" height="13" viewBox="0 0 24 24">${dir ? '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'}</svg>${name}</button>`;
  });
  return html.replace(/(^|[^\p{L}\p{N}_@])@([a-z0-9][a-z0-9-]*)(\.[a-z]+)?/giu, (m, pre, name, act) => {
    const n = name.toLowerCase();
    if (known && !known.includes(n) && n !== user) return m;
    const c = n === user ? '' : mentionColor(n);
    return `${pre}<span class="mention${n === user ? ' mention--me' : ''}${c ? ' mention--sim' : ''}"${c ? ` style="--mc:${c}"` : ''}>@${name}${act ? `<span class="mention--act">${act}</span>` : ''}</span>`;
  });
}

/** Modal: render(box) buduje treść, zwraca Promise z wynikiem (close(value)). `locked` = bez zamykania kliknięciem w tło. */
export function modal(render, { locked = false, wide = false } = {}) {
  return new Promise(resolve => {
    const m = document.createElement('div'); m.className = 'modal';
    const box = document.createElement('div'); box.className = 'modal__box' + (wide ? ' wide' : '');
    m.append(box); document.body.append(m);
    const close = v => { m.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape' && !locked) close(undefined); };
    document.addEventListener('keydown', onKey);
    m.addEventListener('click', e => { if (e.target === m && !locked) close(undefined); });
    render(box, close);
    setTimeout(() => box.querySelector('input,textarea,[autofocus]')?.focus(), 60);
  });
}

export async function confirmBox(title, text, ok = 'Usuń') {
  return !!(await modal((box, close) => {
    box.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="modal__foot"><button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>${esc(ok)}</button></div>`;
    box.querySelector('[data-c]').onclick = () => close(false);
    box.querySelector('[data-ok]').onclick = () => close(true);
  }));
}

export async function promptBox(title, { value = '', placeholder = '', hint = '', ok = 'Zapisz' } = {}) {
  return modal((box, close) => {
    box.innerHTML = `<h3>${esc(title)}</h3>${hint ? `<p>${esc(hint)}</p>` : ''}<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" /><div class="modal__foot"><button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>${esc(ok)}</button></div>`;
    const i = box.querySelector('input');
    i.onkeydown = e => { if (e.key === 'Enter') close(i.value.trim()); };
    box.querySelector('[data-c]').onclick = () => close(undefined);
    box.querySelector('[data-ok]').onclick = () => close(i.value.trim());
  });
}

let toastT = 0;
/** toast(text) — tekst w rogu; toast({title, text, avatar, onClick}) — powiadomienie od sima. */
export function toast(arg) {
  const t = $('toast'), av = $('toastAv');
  av.innerHTML = '';
  if (typeof arg === 'string') { t.classList.add('plain'); av.hidden = true; $('toastT').textContent = ''; $('toastP').textContent = arg; t.onclick = null; }
  else { t.classList.remove('plain'); av.hidden = false; if (arg.avatar) av.append(arg.avatar); $('toastT').textContent = arg.title || ''; $('toastP').textContent = arg.text || ''; t.onclick = () => { t.classList.remove('on'); arg.onClick && arg.onClick(); }; }
  t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), typeof arg === 'string' ? 3500 : 7000);
}

export const api = {
  async get(url) { const r = await fetch(url); const d = await r.json(); if (!r.ok) throw new Error(d.error || r.statusText); return d; },
  async send(method, url, body) { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.statusText); return d; },
  post(url, body) { return this.send('POST', url, body); },
  patch(url, body) { return this.send('PATCH', url, body); },
  put(url, body) { return this.send('PUT', url, body); },
  del(url) { return this.send('DELETE', url); },
};
