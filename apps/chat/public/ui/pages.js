// PAGES — profil usera (onboarding), dodanie sima do rozmowy z Simą, workflowy (lista + edytor), puste stany.
import { $, api, confirmBox, esc, modal, timeAgo, toast } from './dom.js';
import { makeAvatar, randomConfig } from './avatar.js';
import { EXAMPLES, exampleBody, freeExamples } from './sims.js';
import { cfgOf, renderBuilder } from './builder.js';

/** Profil: imię + awatar. locked = onboarding (nie da się zamknąć bez imienia). */
export function profileDialog(app, { locked = false } = {}) {
  const me = app.config.me;
  const cfg = me.name ? cfgOf(me.look) : randomConfig(); // pierwszy raz: losowy awatar na dzień dobry
  return modal((box, close) => {
    box.innerHTML = `<h3>${locked ? 'Cześć! Jak masz na imię?' : 'Twój profil'}</h3><p>${locked ? 'Simy będą się tak do Ciebie zwracać, a @imię to Twój adres w rozmowie — tak simy wołają Cię, gdy potrzebują decyzji.' : 'Imię i awatar widzą simy i Ty w rozmowie.'}</p>
      <div class="form"><label class="field"><span>imię</span><input id="pfName" value="${esc(me.name)}" placeholder="np. Kacper" autocomplete="given-name" /></label><div id="pfBuilder"></div></div>
      ${locked ? '' : '<div class="pf-mem" id="pfMem"></div>'}
      <div class="modal__foot"><span class="muted" id="pfErr"></span>${locked ? '' : '<button class="btn" data-c>Anuluj</button>'}<button class="btn btn--primary" data-ok>${locked ? 'Dalej' : 'Zapisz'}</button></div>`;
    renderBuilder(box.querySelector('#pfBuilder'), cfg, () => {}, { compact: true });
    if (!locked) renderUserMemory(box.querySelector('#pfMem'));
    const name = box.querySelector('#pfName');
    const ok = async () => {
      const n = name.value.trim();
      if (!n) { box.querySelector('#pfErr').textContent = 'podaj imię'; name.focus(); return; }
      const { color, ...avatar } = cfg;
      try { app.config.me = await api.put('/api/me', { name: n, look: { color, avatar } }); close(app.config.me); } catch (e) { box.querySelector('#pfErr').textContent = e.message; }
    };
    name.onkeydown = e => { if (e.key === 'Enter') ok(); };
    box.querySelector('[data-c]') && (box.querySelector('[data-c]').onclick = () => close(undefined));
    box.querySelector('[data-ok]').onclick = ok;
  }, { locked, wide: true });
}

/** Wspólna pamięć o userze (fakty, które znają wszystkie simy): lista z usuwaniem pojedynczych linii i „wyczyść wszystko”. */
async function renderUserMemory(host) {
  let lines = [];
  try { lines = (await api.get('/api/me/memory')).lines; } catch { /* brak */ }
  const save = async next => { try { lines = (await api.put('/api/me/memory', { lines: next })).lines; } catch (e) { toast(e.message); } draw(); };
  const draw = () => {
    host.innerHTML = `<div class="pf-mem__head"><b>Co simy o Tobie wiedzą</b><span class="muted">${lines.length ? `${lines.length} ${lines.length === 1 ? 'fakt' : lines.length % 10 >= 2 && lines.length % 10 <= 4 && (lines.length % 100 < 10 || lines.length % 100 >= 20) ? 'fakty' : 'faktów'}` : ''}</span><span class="sp"></span>${lines.length ? '<button class="btn btn--sm btn--ghost" type="button" data-clear>wyczyść</button>' : ''}</div>
      <p class="muted">Wspólna pamięć wszystkich simów — zbierana sama z rozmów. Usuń, co nieaktualne albo czego nie chcesz, żeby wiedziały.</p>
      ${lines.length ? `<ul class="memlist">${lines.map((m, i) => { const mm = /^(\d{4}-\d{2}-\d{2}) · (.*)$/.exec(m); return `<li><span>${esc(mm ? mm[2] : m)}</span><small>${mm ? mm[1] : ''}</small><button type="button" data-i="${i}" title="Zapomnij">×</button></li>`; }).join('')}</ul>` : '<div class="muted">Jeszcze nic. Opowiedz simom o sobie — zapamiętają.</div>'}`;
    host.querySelectorAll('[data-i]').forEach(b => b.onclick = () => save(lines.filter((_, i) => i !== Number(b.dataset.i))));
    const c = host.querySelector('[data-clear]'); if (c) c.onclick = async () => { if (await confirmBox('Wyczyścić pamięć o Tobie?', 'Simy zapomną wszystkie zebrane fakty o Tobie. Ich notatki z pracy zostają.', 'Wyczyść')) save([]); };
  };
  draw();
}

/** „Dodaj sima” w rozmowie z Simą: wybór sima + obok Simy albo zamiast niej. Zwraca { bot, replace } albo undefined. */
export function addSimToChatDialog(app) {
  let replace = false;
  const sima = app.sima?.name;
  const inChat = app.members.filter(m => m !== sima);
  return modal((box, close) => {
    const render = () => {
      const list = app.bots.filter(b => !inChat.includes(b.name));
      const examples = freeExamples(app);
      box.innerHTML = `<h3>Dodaj sima</h3><p>Sim to agent z własną rolą, narzędziami i pamięcią. Dołączy do tej rozmowy — obok Simy albo zamiast niej.</p>
        ${app.members.includes(sima) ? `<div class="seg" role="tablist"><button class="${replace ? '' : 'on'}" data-mode="add">Obok Simy</button><button class="${replace ? 'on' : ''}" data-mode="replace">Zamiast Simy</button></div>` : ''}
        ${list.length ? '<div class="pick-k">Twoje simy</div>' : ''}<div class="pick">${list.map(b => `<button class="pb" data-b="${esc(b.name)}"><span class="a"></span><span style="min-width:0"><b>@${esc(b.name)}</b><small>${esc(b.description || 'bez opisu')}</small></span></button>`).join('')}<button class="pb" data-new><span class="a" style="display:grid;place-items:center;font-size:22px;color:var(--ink-3)">+</span><span><b>Nowy sim</b><small>stwórz i dodaj</small></span></button></div>
        ${examples.length ? `<div class="pick-k">Gotowe przykłady — kliknij, żeby dodać</div><div class="pick">${examples.map(ex => `<button class="pb" data-ex="${esc(ex.name)}"><span class="a"></span><span style="min-width:0"><b>@${esc(ex.name)}</b><small>${esc(ex.description)}</small></span></button>`).join('')}</div>` : ''}
        <div class="modal__foot"><span class="muted" id="asErr"></span><button class="btn" data-c>Anuluj</button></div>`;
      box.querySelectorAll('[data-mode]').forEach(el => el.onclick = () => { replace = el.dataset.mode === 'replace'; render(); });
      box.querySelectorAll('.pb[data-b]').forEach(el => { const b = app.bots.find(x => x.name === el.dataset.b); el.querySelector('.a').append(makeAvatar({ ...cfgOf(b.look), id: '' }, 40)); el.onclick = () => close({ bot: b.name, replace }); });
      box.querySelectorAll('.pb[data-ex]').forEach(el => {
        const ex = EXAMPLES.find(x => x.name === el.dataset.ex);
        el.querySelector('.a').append(makeAvatar({ ...ex.look, id: '' }, 40));
        el.onclick = async () => {
          el.disabled = true;
          try { const b = await api.post('/api/bots', exampleBody(ex)); await app.loadBots(); close({ bot: b.name, replace }); }
          catch (e) { el.disabled = false; box.querySelector('#asErr').textContent = e.message; }
        };
      });
      box.querySelector('[data-new]').onclick = async () => { const b = await app.addSim({ quiet: true }); if (b) close({ bot: b.name, replace }); };
      box.querySelector('[data-c]').onclick = () => close(undefined);
    };
    render();
  }, { wide: true });
}

/** Edytor workflow (nowy albo istniejący). Zwraca zapisany workflow. */
export function workflowEditor(app, wf) {
  return modal((box, close) => {
    box.innerHTML = `<h3>${wf ? 'Workflow' : 'Nowy workflow'}</h3><p>Instrukcja dla simów w rozmowie: kto za co odpowiada, w jakiej kolejności, co wymaga potwierdzenia. Trafia do promptu każdego sima w tej rozmowie.</p>
      <div class="form"><label class="field"><span>nazwa</span><input id="wfName" value="${esc(wf?.name || '')}" placeholder="np. Faktura z kontrolą" /></label>
      <label class="field"><span>treść (markdown)</span><textarea id="wfBody" style="min-height:220px" placeholder="1. @ksiegowy wystawia fakturę w inFakcie.&#10;2. Zanim kliknie „Wystaw”, @audytor sprawdza kontrahenta, kwoty i VAT.&#10;3. Audytor woła @kacper do potwierdzenia.">${esc(wf?.body || '')}</textarea></label></div>
      <div class="modal__foot"><span class="muted" id="wfErr"></span>${wf ? '<button class="btn btn--danger" data-del>Usuń</button>' : ''}<button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>Zapisz</button></div>`;
    box.querySelector('[data-c]').onclick = () => close(undefined);
    box.querySelector('[data-ok]').onclick = async () => {
      const name = box.querySelector('#wfName').value.trim(), body = box.querySelector('#wfBody').value;
      if (!name) { box.querySelector('#wfErr').textContent = 'podaj nazwę'; return; }
      try { const w = wf ? await api.patch(`/api/workflows/${wf.id}`, { name, body }) : await api.post('/api/workflows', { name, body }); await app.loadConfig(); close(w); } catch (e) { box.querySelector('#wfErr').textContent = e.message; }
    };
    const del = box.querySelector('[data-del]'); if (del) del.onclick = async () => { if (!(await confirmBox('Usunąć workflow?', `„${wf.name}” zniknie z rozmów, które go mają.`))) return; await api.del(`/api/workflows/${wf.id}`); await app.loadConfig(); close(null); };
  }, { wide: true });
}

export async function renderWorkflowsPage(app) {
  const { workflows } = await api.get('/api/workflows');
  const page = $('page');
  page.innerHTML = `<div class="pg"><div class="pg__head"><div style="flex:1"><div class="pg__name">Workflowy</div><div class="muted" style="margin-top:4px">Scenariusze dla simów: dopinasz do rozmowy, a simy wiedzą, kto za co odpowiada i co wymaga Twojego potwierdzenia.</div><div class="pg__actions"><button class="btn btn--primary" id="wfNew">+ Nowy workflow</button></div></div></div>
    <section><div class="wfl">${workflows.length ? workflows.map(w => `<button class="wfr" data-id="${esc(w.id)}"><span style="min-width:0;flex:1"><b>${esc(w.name)}</b><small>${esc(w.body.split('\n').find(l => l.trim()) || 'pusty')}</small></span><span class="t">${timeAgo(w.updated_at)}</span></button>`).join('') : '<div class="muted">Jeszcze żadnego. Przykład: „@ksiegowy wystawia, @audytor sprawdza, potem woła mnie do potwierdzenia”.</div>'}</div></section></div>`;
  $('wfNew').onclick = async () => { await workflowEditor(app); renderWorkflowsPage(app); };
  page.querySelectorAll('.wfr').forEach(b => b.onclick = async () => { await workflowEditor(app, workflows.find(w => w.id === b.dataset.id)); renderWorkflowsPage(app); });
}

/** Pusty stan w głównym oknie (brak rozmów). */
export function renderEmpty(app) {
  const page = $('page');
  page.innerHTML = `<div class="pg"><div class="empty" style="margin-top:14vh"><div class="avs" id="emAvs"></div><h2>Zacznij rozmowę</h2><p>Nowa rozmowa startuje z Simą. Innego sima dodasz albo podmienisz już w rozmowie — w grupie adresujesz ich przez <code class="kbd">@nazwa</code>, a <code class="kbd">@nazwa.task</code> zleca zadanie.</p><div class="btns"><button class="btn btn--primary" id="emNew">+ Nowa rozmowa</button><button class="btn" id="emSim">+ Dodaj sima</button></div></div></div>`;
  app.allBots().slice(0, 4).forEach(b => $('emAvs').append(makeAvatar({ ...cfgOf(b.look), id: b.name, state: 'idle' }, 56)));
  $('emNew').onclick = () => app.quickSession();
  $('emSim').onclick = () => app.addSim();
}
