// DOM — drobiazgi wspólne dla modułów UI: $, esc, @wzmianki, czas, tytuł z emoji, modal, toast.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const isDesktop = () => matchMedia('(min-width: 960px)').matches;
export const timeAgo = iso => { const d = (Date.now() - Date.parse(iso)) / 1000; return d < 60 ? 'teraz' : d < 3600 ? `${Math.floor(d / 60)}m` : d < 86400 ? `${Math.floor(d / 3600)}h` : `${Math.floor(d / 86400)}d`; };
export const clock = iso => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
export const splitTitle = t => { const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+(.*)$/u.exec(t || ''); return m ? { emoji: m[1], text: m[2] } : { emoji: '', text: t || '' }; };
export const wait = ms => new Promise(r => setTimeout(r, ms));

/** @nazwa / @nazwa.akcja → <span class="mention"> (user → mention--me). Działa na tekście już po esc(). */
export function mentions(html, { user, known } = {}) {
  return html.replace(/(^|[^\p{L}\p{N}_@])@([a-z0-9][a-z0-9-]*)(\.[a-z]+)?/giu, (m, pre, name, act) => {
    const n = name.toLowerCase();
    if (known && !known.includes(n) && n !== user) return m;
    return `${pre}<span class="mention${n === user ? ' mention--me' : ''}">@${name}${act ? `<span class="mention--act">${act}</span>` : ''}</span>`;
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
