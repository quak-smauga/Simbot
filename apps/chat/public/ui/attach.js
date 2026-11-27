// ZAŁĄCZNIKI — drop-zone (całe okno), wklejanie (⌘V) i pasek nad polem wiadomości. Każdy plik od razu leci do folderu
// rozmowy (POST /api/sessions/:id/files?name=…); wiadomość niesie potem same nazwy ({t:'text', text, files}).
// Obrazy przed wysłaniem zmniejszamy do 1568 px po dłuższym boku (GIF zostaje, bo animacja).
import { esc, toast } from './dom.js';
import { icon } from './icons.js';

/** Bezpiecznik (tyle przyjmuje serwer w jednej wiadomości) — o tym, co trafi do modelu, decyduje budżet po stronie serwera. */
const MAX_FILES = 50;
const MAX_SIDE = 1568;
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const fileUrl = (sessionId, name) => `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(name)}`;
export const isImageName = n => /\.(png|jpe?g|gif|webp)$/i.test(n);
const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Obraz > 1568 px → mniejszy (ten sam format). Mniejszy albo nieobsługiwany → bez zmian. */
export async function shrink(file) {
  if (!RESIZABLE.has(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = MAX_SIDE / Math.max(bmp.width, bmp.height);
    if (k >= 1) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise(r => c.toBlob(r, file.type, 0.9));
    return blob ? new File([blob], file.name, { type: file.type }) : file;
  } catch { return file; }
}

export function initAttach({ cbox, session, canDrop, onChange, warnVision, onUploaded }) {
  const tray = document.createElement('div');
  tray.className = 'tray'; tray.hidden = true;
  cbox.prepend(tray);
  /** {id, file, name (lokalna), url (podgląd), status: 'up'|'ok'|'err', saved (nazwa w folderze), error} */
  let items = [];
  let seq = 0;

  function render() {
    tray.hidden = !items.length;
    cbox.classList.toggle('has-tray', items.length > 0);
    tray.innerHTML = items.map(it => {
      const img = it.url ? `<img src="${it.url}" alt="" />` : `<span class="tray__ic">${icon(/\.(pdf|txt|md|csv|json)$/i.test(it.name) ? 'file-text' : 'file', 18)}</span><span class="tray__n">${esc(it.name)}<small>${kb(it.file.size)}</small></span>`;
      return `<div class="tray__i ${it.url ? 'img' : 'doc'} ${it.status}" data-id="${it.id}" title="${esc(it.error || it.name)}">${img}${it.status === 'up' ? '<span class="tray__spin"></span>' : ''}<button class="tray__x" data-x="${it.id}" title="Usuń" aria-label="Usuń ${esc(it.name)}">${icon('x', 12)}</button></div>`;
    }).join('');
    onChange && onChange();
  }

  async function upload(it) {
    const sid = session();
    try {
      const file = await shrink(it.file);
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/files?name=${encodeURIComponent(it.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (!items.includes(it)) return; // usunięty w trakcie
      it.status = 'ok'; it.saved = d.name;
      onUploaded && onUploaded(d.name);
    } catch (e) { it.status = 'err'; it.error = e.message; toast(`${it.name}: ${e.message}`); }
    render();
  }

  function add(fileList) {
    const files = [...fileList].filter(f => f && f.size >= 0);
    if (!files.length) return;
    if (!session()) { toast('Najpierw otwórz rozmowę'); return; }
    const room = MAX_FILES - items.length;
    if (room <= 0) { toast(`Maks. ${MAX_FILES} plików w jednej wiadomości`); return; }
    if (files.length > room) toast(`Dodaję ${room} z ${files.length} — maks. ${MAX_FILES} w jednej wiadomości`);
    const added = files.slice(0, room).map(f => ({ id: ++seq, file: f, name: f.name || `wklejony-${Date.now()}.png`, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '', status: 'up' }));
    items.push(...added);
    if (added.some(a => a.url)) warnVision && warnVision();
    render();
    added.forEach(upload);
  }

  function remove(id) {
    const it = items.find(x => x.id === id);
    if (it && it.url) URL.revokeObjectURL(it.url);
    items = items.filter(x => x.id !== id);
    render();
  }

  tray.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { e.stopPropagation(); remove(Number(x.dataset.x)); } });

  // ── drop-zone: całe okno, tylko gdy przeciągane są pliki ──
  const veil = document.createElement('div');
  veil.className = 'drop'; veil.hidden = true;
  veil.innerHTML = `<div class="drop__box"><div class="drop__ic">${icon('image-plus', 34)}</div></div><div class="drop__t">Upuść, żeby o tym pogadać</div><div class="drop__s">obrazy, PDF, tekst — trafią do folderu rozmowy</div>`;
  document.body.append(veil);
  // widoczność z dragover (przychodzi ciągle podczas przeciągania), nie z licznika enter/leave — ten gubi się przy
  // przejściu nad panel plików i z powrotem. Brak dragover przez chwilę (np. Esc w trakcie) = koniec.
  let hideT = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  // nad panelem plików upuszcza się do folderu (files.js), nie do wiadomości → bez zasłony
  const overPanel = e => !!(e.target && e.target.closest && e.target.closest('#fpanel'));
  const show = on => { clearTimeout(hideT); veil.hidden = !on; document.body.classList.toggle('dropping', on); if (on) hideT = setTimeout(() => show(false), 700); };
  const over = e => { if (!hasFiles(e) || !canDrop()) return; if (overPanel(e)) { show(false); return; } e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; show(true); };
  window.addEventListener('dragenter', over);
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', e => { if (hasFiles(e) && !e.relatedTarget) show(false); }); // wyjście poza okno
  window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); show(false); if (canDrop() && !overPanel(e)) add(e.dataTransfer.files); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !veil.hidden) show(false); });

  return {
    add,
    /** Wklejanie: obrazy ze schowka (zrzut ekranu ⌘⇧4 → ⌘V). Zwraca true, gdy coś przejęto. */
    paste(e) {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return false;
      e.preventDefault(); add(files); return true;
    },
    get count() { return items.length; },
    get busy() { return items.some(x => x.status === 'up'); },
    /** Nazwy w folderze rozmowy (gotowe do wysłania). */
    ready() { return items.filter(x => x.status === 'ok').map(x => x.saved); },
    hasImages() { return items.some(x => x.url); },
    clear() { items.forEach(x => x.url && URL.revokeObjectURL(x.url)); items = []; render(); },
  };
}

/** Miniatury plików w dymku wiadomości usera. */
export function filesHtml(sessionId, files) {
  if (!files || !files.length) return '';
  return `<div class="mfiles">${files.map(n => isImageName(n)
    ? `<a class="mfiles__img" href="${fileUrl(sessionId, n)}" target="_blank" rel="noopener" title="${esc(n)}"><img src="${fileUrl(sessionId, n)}" alt="${esc(n)}" loading="lazy" /></a>`
    : `<a class="mfiles__doc" href="${fileUrl(sessionId, n)}" target="_blank" rel="noopener">${icon(/\.(pdf|txt|md|csv|json)$/i.test(n) ? 'file-text' : 'file', 16)}<span>${esc(n)}</span></a>`).join('')}</div>`;
}
