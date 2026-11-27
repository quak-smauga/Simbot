// MODELE — jeden przycisk pod polem wiadomości (prawa strona). Domyślnie jeden model do wszystkiego; opcjonalnie osobny
// model do narzędzi (podmenu ›). Dostawcy: Claude (lista stała) i Ollama (status, start, lista, pobieranie z searcha).
// Serwer: GET/PUT /api/llm, POST /api/llm/ollama/start|pull.
import { $, api, esc, toast } from './dom.js';
import { icon } from './icons.js';

const S = { data: null, open: false, sub: false, q: '', subQ: '', pulling: null, loading: false };

const gb = n => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB';
const params = p => (p || '').replace(/^(\d+(?:\.\d+)?)M$/, (_, n) => (Number(n) >= 950 ? '1B' : `${Math.round(Number(n))}M`));
const kctx = n => (n ? (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)) : '');
const short = id => (id || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/:latest$/, '');
const sameSlot = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;

/** Wszystkie modele w jednym formacie: {provider, id, label, meta, vision, disabled}. */
function allModels() {
  const d = S.data;
  if (!d) return [];
  const claude = d.anthropic.models.map(m => ({ provider: 'anthropic', id: m.id, label: m.label, meta: kctx(m.ctx), vision: true, disabled: !d.anthropic.available && !d.mock }));
  const ollama = d.ollama.models.map(m => ({ provider: 'ollama', id: m.id, label: m.id.replace(/:latest$/, ''), meta: [params(m.params), kctx(m.ctx), gb(m.size)].filter(Boolean).join(' · '), vision: m.vision }));
  return [...claude, ...ollama];
}
const match = (m, q) => !q || (m.label + ' ' + m.id + ' ' + m.provider).toLowerCase().includes(q.toLowerCase());

/** Co potrafi model rozmowy (z ostatniego GET /api/llm) — np. czy widzi obrazy. */
export const modelCaps = () => S.data?.chat ?? null;

export async function refreshModels() {
  try { S.data = await api.get('/api/llm'); } catch (e) { S.data = null; }
  renderButton();
  if (S.open) renderMenu();
}

function renderButton() {
  const b = $('modelBtn');
  if (!b) return;
  const d = S.data;
  if (!d) { b.innerHTML = `<span class="mpick__t">model</span>${icon('chevron-down', 13)}`; return; }
  const chat = d.chat, tools = d.tools;
  const split = !sameSlot(chat, tools);
  const warn = !tools.vision;
  const offline = (chat.provider === 'ollama' || tools.provider === 'ollama') && !d.ollama.running;
  b.classList.toggle('warn', warn || offline);
  b.title = `Rozmowa: ${chat.model}${split ? `\nNarzędzia: ${tools.model}` : ''}${warn ? `\n⚠ ${tools.model} nie widzi obrazów — komputer bez zrzutów, desktop niedostępny` : ''}${offline ? '\n⚠ Ollama nie działa' : ''}`;
  b.innerHTML = `${warn || offline ? '<i class="mpick__dot"></i>' : ''}<span class="mpick__t">${esc(d.mock ? 'mock' : short(chat.model))}</span>${split ? `<span class="mpick__t2">+ ${esc(short(tools.model))}</span>` : ''}${icon('chevron-down', 13)}`;
}

/** Wybór: slot "chat" albo "tools". tools=null → ten sam co rozmowa. */
async function choose(slot, m) {
  const d = S.data;
  const cur = { chat: d.selection?.chat ?? { provider: d.chat.provider, model: d.chat.model }, tools: d.selection?.tools ?? null };
  const next = slot === 'chat' ? { chat: { provider: m.provider, model: m.id }, tools: cur.tools } : { chat: cur.chat, tools: m ? { provider: m.provider, model: m.id } : null };
  if (next.tools && sameSlot(next.tools, next.chat)) next.tools = null;
  try {
    await api.put('/api/llm', next);
    await refreshModels();
    if (slot === 'chat') close();
  } catch (e) { toast(e.message); }
}

async function startOllama() {
  S.loading = true; renderMenu();
  try { await api.post('/api/llm/ollama/start'); toast('Ollama działa'); }
  catch (e) { toast(e.message); }
  S.loading = false;
  await refreshModels();
}

async function pull(name) {
  if (S.pulling) return;
  S.pulling = { name, pct: 0, status: 'start…' };
  renderMenu();
  try {
    const r = await fetch('/api/llm/ollama/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) });
    if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const p = JSON.parse(line);
        if (p.error) throw new Error(p.error);
        if (p.done) continue;
        S.pulling = { name, status: p.status, pct: p.total ? Math.round((p.completed || 0) / p.total * 100) : S.pulling.pct };
        updatePull();
      }
    }
    toast(`Pobrano ${name}`);
    S.q = ''; S.subQ = '';
  } catch (e) { toast(`Pobieranie ${name}: ${e.message}`); }
  S.pulling = null;
  await refreshModels();
}
function updatePull() {
  const el = document.querySelector('.mmenu__pull');
  if (!el || !S.pulling) return renderMenu();
  el.querySelector('.mmenu__bar i').style.width = S.pulling.pct + '%';
  el.querySelector('small').textContent = `${S.pulling.status}${S.pulling.pct ? ` · ${S.pulling.pct}%` : ''}`;
}

/** Lista modeli (z sekcjami) dla slotu. `selected` = aktualny model slotu. */
function listHtml(slot, q) {
  const d = S.data;
  const models = allModels().filter(m => match(m, q));
  const sel = slot === 'chat' ? d.chat : (sameSlot(d.chat, d.tools) ? null : d.tools);
  const row = m => `<button class="mmenu__i${m.disabled ? ' off' : ''}" data-slot="${slot}" data-p="${m.provider}" data-id="${esc(m.id)}"${m.disabled ? ' disabled' : ''}>
      <span class="mmenu__l"><b>${esc(m.label)}</b>${m.meta ? `<small>${esc(m.meta)}</small>` : ''}</span>
      ${m.vision ? `<span class="mmenu__eye" title="widzi obrazy">${icon('eye', 14)}</span>` : `<span class="mmenu__eye no" title="nie widzi obrazów">${icon('eye', 14)}</span>`}
      <span class="mmenu__ok">${sel && sel.provider === m.provider && sel.model === m.id ? icon('check', 15) : ''}</span>
    </button>`;
  const claude = models.filter(m => m.provider === 'anthropic');
  const ollama = models.filter(m => m.provider === 'ollama');
  const o = d.ollama;
  const oHead = `<div class="mmenu__k">Ollama <span class="mmenu__st ${o.running ? 'ok' : ''}">${o.running ? `działa${o.version ? ' · ' + esc(o.version) : ''}` : o.installed ? 'wyłączona' : 'nie zainstalowana'}</span>${!o.running && o.installed ? `<button class="mmenu__btn" data-start${S.loading ? ' disabled' : ''}>${S.loading ? 'uruchamiam…' : 'Uruchom'}</button>` : ''}${!o.installed ? `<a class="mmenu__btn" href="https://ollama.com/download" target="_blank" rel="noopener">Pobierz</a>` : ''}</div>`;
  // search bez trafień w Ollamie → „pobierz z Ollamy” (tylko dla nazw wyglądających na model)
  const qn = q.trim();
  const canPull = slot === 'chat' && o.running && qn.length >= 3 && /^[\w.\-/:]+$/.test(qn) && !ollama.length;
  const pullRow = S.pulling
    ? `<div class="mmenu__pull"><span class="mmenu__l"><b>${icon('download', 14)} ${esc(S.pulling.name)}</b><small>${esc(S.pulling.status)}</small></span><span class="mmenu__bar"><i style="width:${S.pulling.pct}%"></i></span></div>`
    : canPull ? `<button class="mmenu__i" data-pull="${esc(qn)}"><span class="mmenu__l"><b>${icon('download', 14)} Pobierz „${esc(qn)}” z Ollamy</b><small>np. gemma3:12b, qwen3:8b, llama3.2-vision</small></span></button>` : '';
  return `${claude.length ? `<div class="mmenu__k">Claude${!d.anthropic.available && !d.mock ? ' <span class="mmenu__st">brak klucza API</span>' : ''}</div>${claude.map(row).join('')}` : ''}
    ${oHead}${ollama.map(row).join('')}${o.running && !d.ollama.models.length && !q ? '<div class="mmenu__empty">brak modeli — wpisz nazwę wyżej, żeby pobrać</div>' : ''}
    ${!models.length && !pullRow ? '<div class="mmenu__empty">nic nie pasuje</div>' : ''}${pullRow}`;
}

function renderMenu() {
  let m = $('modelMenu');
  if (!S.open) { m && m.remove(); return; }
  const d = S.data;
  if (!m) { m = document.createElement('div'); m.id = 'modelMenu'; m.className = 'mmenu'; $('composer').append(m); }
  if (!d) { m.innerHTML = '<div class="mmenu__empty">nie mogę pobrać listy modeli</div>'; return; }
  const tools = sameSlot(d.chat, d.tools) ? null : d.tools;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.q : null;
  const main = `<div class="mmenu__p">
      <label class="mmenu__s">${icon('search', 14)}<input data-q="main" placeholder="Szukaj albo pobierz model…" value="${esc(S.q)}" spellcheck="false" /></label>
      <div class="mmenu__list">${listHtml('chat', S.q)}</div>
      <button class="mmenu__tools${S.sub ? ' on' : ''}" data-sub>${icon('wrench', 14)}<span>Model do narzędzi</span><small>${tools ? esc(short(tools.model)) : 'ten sam'}</small>${icon('chevron-right', 14)}</button>
      ${!d.tools.vision ? `<div class="mmenu__warn">${esc(short(d.tools.model))} nie widzi obrazów — komputer bez zrzutów ekranu, tryb desktop niedostępny</div>` : ''}
    </div>`;
  const sub = S.sub ? `<div class="mmenu__p mmenu__sub">
      <div class="mmenu__subh"><button class="ib" data-back title="Wróć">${icon('chevron-left', 16)}</button><span>Narzędzia: komputer, streszczenia, tytuły, pamięć</span></div>
      <label class="mmenu__s">${icon('search', 14)}<input data-q="sub" placeholder="Szukaj…" value="${esc(S.subQ)}" spellcheck="false" /></label>
      <div class="mmenu__list"><button class="mmenu__i" data-same><span class="mmenu__l"><b>Ten sam co rozmowa</b><small>${esc(short(d.chat.model))}</small></span><span class="mmenu__ok">${!tools ? icon('check', 15) : ''}</span></button>${listHtml('tools', S.subQ)}</div>
    </div>` : '';
  m.classList.toggle('has-sub', S.sub);
  m.innerHTML = sub + main;
  if (focused) { const i = m.querySelector(`input[data-q="${focused}"]`); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}

function close() { S.open = false; S.sub = false; S.q = ''; S.subQ = ''; renderMenu(); $('modelBtn')?.setAttribute('aria-expanded', 'false'); }

export function initModels() {
  const b = $('modelBtn');
  if (!b) return;
  b.onclick = async e => {
    e.stopPropagation();
    if (S.open) return close();
    S.open = true; b.setAttribute('aria-expanded', 'true');
    renderMenu();
    await refreshModels(); // świeży status Ollamy przy każdym otwarciu
    setTimeout(() => $('modelMenu')?.querySelector('input[data-q="main"]')?.focus(), 30);
  };
  $('composer').addEventListener('click', e => {
    const m = e.target.closest('#modelMenu');
    if (!m) return;
    e.stopPropagation();
    const t = e.target.closest('button,a');
    if (!t || t.disabled) return;
    if (t.dataset.start !== undefined) return void startOllama();
    if (t.dataset.pull) return void pull(t.dataset.pull);
    if (t.dataset.sub !== undefined) { S.sub = !S.sub; renderMenu(); setTimeout(() => m.querySelector('input[data-q="sub"]')?.focus(), 30); return; }
    if (t.dataset.back !== undefined) { S.sub = false; renderMenu(); return; }
    if (t.dataset.same !== undefined) return void choose('tools', null);
    if (t.dataset.id) return void choose(t.dataset.slot, allModels().find(x => x.provider === t.dataset.p && x.id === t.dataset.id));
  });
  $('composer').addEventListener('input', e => {
    const i = e.target.closest('#modelMenu input[data-q]');
    if (!i) return;
    if (i.dataset.q === 'main') S.q = i.value; else S.subQ = i.value;
    renderMenu();
  });
  $('composer').addEventListener('keydown', e => {
    if (!e.target.closest('#modelMenu')) return;
    if (e.key === 'Escape') { e.stopPropagation(); if (S.sub) { S.sub = false; renderMenu(); } else { close(); b.focus(); } }
    if (e.key === 'Enter' && e.target.matches('input[data-q]')) {
      // Enter w searchu = pierwszy pasujący model (albo pobranie)
      const list = e.target.closest('.mmenu__p').querySelector('.mmenu__i:not([disabled])');
      list && list.click();
    }
  });
  document.addEventListener('click', e => { if (S.open && !e.target.closest('#modelMenu') && !e.target.closest('#modelBtn')) close(); });
  // wybór mógł się zmienić gdzie indziej (drugie okno, widget) — odśwież po powrocie do okna
  window.addEventListener('focus', () => { if (!S.open) void refreshModels(); });
  void refreshModels();
}
