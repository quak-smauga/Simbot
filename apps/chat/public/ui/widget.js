// WIDGET — kokpit agenta na pulpicie. Okno główne = centrum dowodzenia; runtime pracuje niezależnie od obu.
//   compact   kropka przy krawędzi: logo (nic się nie dzieje) albo awatar sima pracującego w tej rozmowie;
//             kolor plakietki = stan: niebieski pracuje · żółty czeka na Ciebie · czerwony błąd / ktoś Cię woła · szary wstrzymane
//   expanded  karta, tylko gdy trzeba: polecenie · pracuje · czeka na Ciebie · gotowe / błąd
// Zasady: start zadania nie rozwija widgetu (tylko plakietka). Rozwija się sam, gdy agent czeka na Ciebie (ustawienie w trayu)
// albo gdy sam coś zleciłeś z widgetu. Gotowe = krótka informacja i powrót do kropki; błąd zostaje na plakietce, aż go obejrzysz.
// Przeciąganie: za kropkę albo nagłówek karty (nie za przyciski); puszczenie przy krawędzi = przyklejenie. × chowa widget,
// agenta nie zatrzymuje. ↗ otwiera okno główne dokładnie na tej rozmowie i tym zadaniu.
// Źródło prawdy: WS bieżącej rozmowy (te same eventy co okno główne) + lobby (inne rozmowy, powiadomienia).
import { connect } from './net.js';
import { makeAvatar, startBlinking } from './avatar.js';
import { makeLogo, blinkLogos } from './logo.js';
import { cfgOf } from './builder.js';
import { icon } from './icons.js';
import { api, esc } from './dom.js';

const shell = window.qwe || null;
const root = document.getElementById('w');
document.documentElement.dataset.theme = localStorage.getItem('qwe.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
addEventListener('storage', e => { if (e.key === 'qwe.theme' && e.newValue) document.documentElement.dataset.theme = e.newValue; });
blinkLogos(); startBlinking();

const REASON_Q = { LOGIN_REQUIRED: 'Zaloguj się w przeglądarce', CAPTCHA: 'Rozwiąż captchę', USER_CONTROL: 'Masz kontrolę', OTHER: 'Potrzebna pomoc' };
const W = {
  session: new URLSearchParams(location.search).get('session') || null,
  net: null, lobby: null, config: null, members: [], chatState: 'idle',
  view: 'compact', task: null, done: null, call: null, target: null, awaitReply: false, hover: false,
  error: null, callMe: false, sessions: new Map(), // id → { state, title, members }
};

// ───────── pomocnicze ─────────
const botOf = name => (W.config ? [W.config.sima, ...W.config.bots].filter(Boolean).find(b => b.name === name) : null);
const avatar = (name, size, state) => { const b = botOf(name); return makeAvatar({ ...cfgOf(b?.look), id: b?.name || name || '?', state }, size); };
const lead = () => W.members[0] || W.config?.sima?.name || 'sima';
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const live = t => t && ['queued', 'running', 'paused', 'waiting_user'].includes(t.state);
const shot = id => `/api/screenshots/${id}`;
const EXPANDED = ['command', 'working', 'waiting', 'done'];

// ───────── model zadania z eventów (te same co karty w oknie głównym) ─────────
function newTask(id, bot) {
  return { id, bot: bot || lead(), state: 'queued', kind: 'direct', name: null, goal: '', step: 0, maxSteps: 0, label: '', think: '', shotId: null, url: '', title: '', startedAt: Date.now(), waiting: null, result: '', ok: null, steps: [] };
}
function reduce(t, m) {
  let task = W.task;
  if (t === 'tool.call' && m.block) { W.call = { bot: m.bot, block: m.block }; W.pendingSay = null; return; }
  if (!m.taskId) return;
  if (t === 'task.enqueued' || !task || task.id !== m.taskId) {
    if (t !== 'task.enqueued' && task && live(task)) return; // event ze starszego zadania
    task = W.task = newTask(m.taskId, typeof m.agent === 'string' ? m.agent : W.call?.bot);
    if (W.call?.block?.kind === 'plan') { task.kind = 'plan'; task.steps = W.call.block.steps.map(s => ({ id: s.id, name: s.name, status: 'pending' })); }
    else if (W.call?.block?.calls?.[0]) task.name = W.call.block.calls[0].name;
  }
  switch (t) {
    case 'task.started': task.state = 'running'; task.startedAt = m.at ? Date.parse(m.at) : Date.now(); break;
    case 'task.waiting': task.state = 'waiting_user'; task.waiting = { reason: m.reason, message: m.message, title: m.title, details: m.details, action: m.action }; if (m.step) task.step = m.step; if (m.maxSteps) task.maxSteps = m.maxSteps; if (m.screenshotId) task.shotId = m.screenshotId; break;
    case 'task.resumed': task.state = 'running'; task.waiting = null; break;
    case 'task.paused': task.state = 'paused'; break;
    case 'task.succeeded': task.state = m.ok !== false || (m.parts || []).filter(p => !p.ok).every(p => p.status === 'partial') ? 'succeeded' : 'failed'; task.waiting = null; if (!task.result) task.result = (m.parts || []).map(p => p.text).filter(Boolean).join(' ').slice(0, 400); break;
    case 'task.failed': task.state = 'failed'; task.waiting = null; task.result = m.error || task.result; break;
    case 'task.cancelled': task.state = 'cancelled'; task.waiting = null; task.result = 'Anulowane.'; break;
    case 'plan.started': task.kind = 'plan'; task.steps = (m.steps || []).map(s => ({ id: s.id, name: s.name, status: 'pending' })); break;
    case 'step.started': { const s = task.steps.find(x => x.id === m.stepId); if (s) s.status = 'running'; break; }
    case 'step.completed': case 'step.failed': case 'step.skipped': { const s = task.steps.find(x => x.id === m.stepId); if (s) s.status = t.split('.')[1]; break; }
    case 'tool.call': if (!task.name) task.name = m.name; if (m.name === 'web.query') task.label = `szukam: ${(m.args && m.args._) || ''}`; else if (String(m.name).startsWith('mcp.')) { const x = /^mcp\.([^.]+)\.(.+)$/.exec(m.name); task.label = x ? `${x[1]}: ${x[2]}` : `${(m.args && m.args.server) || 'mcp'}: ${(m.args && m.args.tool) || m.name.slice(4)}`; } break;
    case 'web.started': task.label = `szukam: ${m.query || ''}`; break;
    case 'web.completed': task.label = `${(m.results || []).length} wyników · ${m.query || ''}`; break;
    case 'computer.started': task.name = 'computer.run'; task.goal = m.goal || ''; task.maxSteps = m.maxSteps || task.maxSteps; task.mode = m.mode || 'browser'; task.label = task.mode === 'desktop' ? 'biorę komputer' : 'otwieram przeglądarkę'; break;
    case 'computer.plan': if (m.budget) task.maxSteps = m.budget; task.label = m.alreadyDone ? 'cel już spełniony' : `plan: ${(m.stages || []).length} etap(y) · ~${m.estimatedSteps || '?'} kroków`; break;
    case 'computer.stage': if (m.status === 'done') task.label = `✓ ${m.title || `etap ${m.id}`}`; break;
    case 'computer.observation': if (m.screenshotId) task.shotId = m.screenshotId; task.url = m.url || task.url; task.title = m.title || task.title; break;
    case 'computer.action': if (m.status === 'started') { task.step = m.step || task.step; task.label = m.label || ''; task.think = m.think || ''; } else if (m.status === 'failed') task.think = `błąd: ${m.error || ''}`; break;
    case 'computer.completed': task.result = m.result || task.result; task.ok = true; break;
    case 'computer.failed': task.result = m.error || task.result; task.ok = false; break;
  }
}

// ───────── widoki ─────────
/** Nagłówek karty = uchwyt do przeciągania. Przyciski: zwiń · otwórz w aplikacji · schowaj widget. */
function headHtml(task, sub, s) {
  return `<div class="whead" data-drag><span data-av></span>
    <div class="whead__t"><div class="whead__name">@${esc(task?.bot || lead())}</div><div class="whead__sub" data-s="${s}"><i></i><span data-sub>${sub}</span></div></div>
    <button class="ib" data-act="collapse" title="Zwiń do kropki (Esc)">${icon('minimize-2', 15)}</button><button class="ib" data-act="open" title="Otwórz w simbot — to zadanie">${icon('external-link', 15)}</button><button class="ib" data-act="hide" title="Schowaj widget (agent pracuje dalej)">${icon('x', 15)}</button></div>`;
}
function stepOf(t) { return t.kind === 'plan' ? `${t.steps.filter(s => ['completed', 'failed', 'skipped'].includes(s.status)).length + (t.steps.some(s => s.status === 'running') ? 1 : 0)}/${t.steps.length}` : t.maxSteps ? `${t.step || 0}/${t.maxSteps}` : ''; }
function subOf(t) {
  const st = t.state === 'paused' ? 'wstrzymane' : t.state === 'waiting_user' ? 'czeka na Ciebie' : t.state === 'queued' ? 'w kolejce' : 'pracuje';
  const k = stepOf(t);
  return `${st}${k ? ` · krok ${k}` : ''}${t.state === 'waiting_user' ? '' : ` · <span class="mono">${clock(Date.now() - t.startedAt)}</span>`}`;
}
function progressHtml(t) {
  if (t.kind === 'plan' && t.steps.length) return `<div class="wprog">${t.steps.map(s => `<span class="${s.status === 'completed' ? 'done' : s.status === 'running' ? 'cur' : s.status === 'failed' ? 'bad' : ''}"></span>`).join('')}</div>`;
  if (t.maxSteps) return `<div class="wbar"><i style="width:${Math.min(100, Math.round(((t.step || 0) / t.maxSteps) * 100))}%"></i></div>`;
  return '';
}
const othersBusy = () => [...W.sessions.entries()].filter(([id, s]) => id !== W.session && (s.state === 'working' || s.state === 'waiting_user'));
/** Inne rozmowy, w których simy teraz pracują / czekają — jeden globalny „pracuje” kłamałby przy kilku simach. */
function othersHtml() {
  const busy = othersBusy();
  if (!busy.length) return '';
  return `<div class="wothers">${busy.slice(0, 3).map(([id, s]) => `<button class="wother" data-act="switch" data-id="${esc(id)}" title="Przełącz widget na tę rozmowę"><span data-otherav="${esc(s.members?.[0] || '')}"></span><span class="wother__t">@${esc(s.members?.[0] || '?')} · ${esc(s.title || 'rozmowa')}</span><i data-s="${s.state === 'waiting_user' ? 'waiting' : 'working'}"></i></button>`).join('')}${busy.length > 3 ? `<span class="wother wother--more">+${busy.length - 3}</span>` : ''}</div>`;
}
/** Plakietka kropki: najważniejsza rzecz wygrywa. */
function badge() {
  const t = W.task;
  if (t?.state === 'waiting_user') return 'waiting';
  if (W.error) return 'error';
  if (W.callMe) return 'call';
  if (t?.state === 'paused') return 'paused';
  if (live(t)) return 'working';
  const others = othersBusy();
  if (others.some(([, s]) => s.state === 'waiting_user')) return 'waiting';
  if (others.length) return 'working';
  return '';
}

const VIEWS = {
  compact() {
    const t = live(W.task) ? W.task : null;
    const c = t && botOf(t.bot)?.look?.color;
    const b = badge();
    const tip = { waiting: 'czeka na Ciebie', error: 'błąd — kliknij, żeby zobaczyć', call: 'ktoś Cię woła', paused: 'wstrzymane', working: 'pracuje' }[b] || 'polecenie (⌥Space)';
    return `<button class="wdot${t ? ' wdot--sim' : ''}" data-drag data-act="${t || W.error ? 'expand' : 'command'}" data-badge="${b}" title="simbot — ${tip} · przeciągnij, żeby przesunąć · prawy klik: menu" style="${c ? `--c:${esc(c)}` : ''}">${t ? '<span data-av></span>' : '<span data-logo></span>'}${t?.state === 'running' || t?.state === 'queued' ? '<i class="wdot__ring"></i>' : ''}<i class="wdot__badge"></i></button>`;
  },
  command() {
    const target = W.target || lead();
    const others = W.members.length > 1;
    return `<div class="wcard wcard--cmd"><div class="wcmd" data-drag><span data-logo></span><textarea id="cmd" rows="1" placeholder="Co zrobić? Enter wysyła, Esc zwija" spellcheck="false"></textarea><button class="wsend" data-act="send" title="Wyślij (Enter)" disabled>${icon('arrow-up', 18)}</button></div>
      <div class="wchips">${others ? `<button class="wchip" data-act="target" title="Zmień sima"><span data-chipav></span>@${esc(target)}</button>` : `<span class="wchip"><span data-chipav></span>@${esc(target)}</span>`}${W.session ? '' : '<span class="wchip">nowa rozmowa</span>'}<span class="wchip wchip--off" title="Etap 2: kontekst ekranu (aplikacja, okno, zrzut)">${icon('app-window', 14)}kontekst ekranu · wkrótce</span></div></div>`;
  },
  working() {
    const t = W.task;
    const line = t ? (t.think || t.label || (t.name === 'computer.run' ? (t.mode === 'desktop' ? 'biorę komputer' : 'otwieram przeglądarkę') : 'pracuję')) : 'myślę…';
    const ready = t && !(t.state === 'queued' && !t.label);
    return `<div class="wcard">${headHtml(t, t ? subOf(t) : 'myśli…', t?.state === 'paused' ? 'paused' : 'working')}${t ? progressHtml(t) : ''}
      <div class="wstep"><span class="wstep__n">${t?.step || ''}</span><span class="wstep__t">${esc(line)}${t?.think && t.label ? `<small>${esc(t.label)}</small>` : ''}</span></div>
      ${t?.shotId ? `<div class="wshot"><img src="${shot(t.shotId)}" alt="" /><span>${esc(t.title || t.url || '')}</span></div>` : ''}
      ${ready ? `<div class="wbtns">${t.state === 'paused' ? `<button class="btn btn--primary" data-act="resume">${icon('play', 15)}Wznów</button>` : `<button class="btn" data-act="pause">${icon('pause', 15)}Wstrzymaj</button>`}<button class="btn btn--stop" data-act="cancel" title="Kończy zadanie (nie da się wznowić)">${icon('square', 14)}Anuluj</button></div>` : ''}${othersHtml()}</div>`;
  },
  waiting() {
    const t = W.task, w = t.waiting || {};
    const confirm = w.reason === 'CONFIRM_ACTION';
    const q = confirm ? `${w.title || 'Potwierdzasz?'}${/\?$/.test(w.title || '') ? '' : '?'}` : REASON_Q[w.reason] || REASON_Q.OTHER;
    const rows = Array.isArray(w.details) && w.details.length ? `<dl class="wrows">${w.details.map(d => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd></div>`).join('')}</dl>` : '';
    const msg = confirm ? (rows ? '' : w.action ? `akcja: ${w.action}` : '') : w.message;
    return `<div class="wcard wcard--wide wcard--waiting">${headHtml(t, subOf(t), 'waiting')}<div class="wq">${esc(q)}</div>${msg ? `<div class="wmsg">${esc(msg)}</div>` : ''}${rows}
      ${!rows && t.shotId ? `<div class="wshot"><img src="${shot(t.shotId)}" alt="" /><span>${esc(t.title || t.url || '')}</span></div>` : ''}
      <div class="wbtns"><button class="btn btn--primary" data-act="resume">${confirm ? 'Tak, wykonaj' : 'Zrobione, wznów'} <span class="wkey">↵</span></button><button class="btn" data-act="fix" title="Otwórz to zadanie w simbot">Popraw</button><button class="btn btn--sq" data-act="cancel" title="Anuluj zadanie">${icon('square', 14)}</button></div>
      <div class="wfoot"><span>${confirm ? 'agent kliknie dopiero po Twoim OK' : 'po wznowieniu agent sprawdzi stan strony'}</span><span>⌃⌥Esc stop</span></div>${othersHtml()}</div>`;
  },
  done() {
    const d = W.done || {};
    return `<div class="wcard wcard--done${d.bad ? ' bad' : ''}" data-drag><span data-av></span><div class="wdone"><div class="wdone__t">${esc(d.title || 'Gotowe')}</div>${d.text ? `<div class="wdone__p">${esc(d.text)}</div>` : ''}<div class="wdone__hint" data-hint>${d.sticky ? 'Esc albo ⤡ zwija' : 'zwija się za chwilę · najedź, żeby zatrzymać'}</div></div><div class="wdone__btns"><button class="ib" data-act="open" title="Otwórz w simbot">${icon('external-link', 15)}</button><button class="ib" data-act="collapse" title="Zwiń">${icon('minimize-2', 15)}</button></div></div>`;
  },
};

// ───────── render + rozmiar okna ─────────
let doneT = null;
function render(enter = false) {
  root.dataset.view = W.view;
  root.innerHTML = VIEWS[W.view]();
  root.querySelectorAll('[data-logo]').forEach(el => el.replaceWith(makeLogo({ size: W.view === 'compact' ? 26 : 24, intro: false })));
  const t = W.task;
  const avState = W.view === 'done' ? (W.done?.bad ? 'error' : 'celebrating') : t?.state === 'waiting_user' ? 'confused' : t?.state === 'paused' ? 'sleeping' : 'working';
  root.querySelectorAll('[data-av]').forEach(el => el.replaceWith(avatar(W.view === 'done' ? W.done?.bot : t?.bot || lead(), W.view === 'compact' ? 34 : 36, avState)));
  root.querySelectorAll('[data-chipav]').forEach(el => el.replaceWith(avatar(W.target || lead(), 16)));
  root.querySelectorAll('[data-otherav]').forEach(el => el.replaceWith(avatar(el.getAttribute('data-otherav'), 18, 'working')));
  if (enter) { root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter'); }
  if (W.view === 'command') wireCommand();
  fit();
}
function fit() {
  if (!shell) return;
  requestAnimationFrame(() => { const r = root.getBoundingClientRect(); shell.resize(Math.ceil(r.width) + 24, Math.ceil(r.height) + 24); });
}
new ResizeObserver(fit).observe(root);

/** Zmiana kształtu: przy zwijaniu najpierw animacja wyjścia, potem mniejsze okno (inaczej treść „ucina się” o krawędź). */
function go(view) {
  clearTimeout(doneT);
  if (view === W.view) return render();
  const prev = W.view;
  if (prev === 'command') shell?.release();
  if (view === 'compact' && EXPANDED.includes(prev)) {
    root.classList.remove('enter'); root.classList.add('leave');
    setTimeout(() => { root.classList.remove('leave'); W.view = view; render(true); }, 150);
  } else { W.view = view; render(true); }
  if (view === 'done' && !W.done?.sticky) armDone();
}
const collapse = () => go('compact');
function armDone(ms = 5000) {
  clearTimeout(doneT);
  doneT = setTimeout(() => { if (W.hover) return armDone(1500); W.done = null; collapse(); }, ms);
}
root.addEventListener('mouseenter', () => { W.hover = true; const h = root.querySelector('[data-hint]'); if (h && !W.done?.sticky) h.textContent = 'zatrzymane · zwinie się, gdy zjedziesz'; });
root.addEventListener('mouseleave', () => { W.hover = false; });

/** Po każdym evencie zadania: czy kształt ma się zmienić? */
function sync() {
  const t = W.task;
  // czeka na Ciebie: czy rozwinąć, decyduje main (ustawienie) przez qwe:attention; jeśli karta już jest otwarta albo
  // widget działa w przeglądarce (bez shella) — od razu
  if (t?.state === 'waiting_user' && W.view !== 'waiting' && (EXPANDED.includes(W.view) || !shell)) { go('waiting'); return; }
  if (W.view === 'waiting' && t?.state !== 'waiting_user') { go(live(t) ? 'working' : 'compact'); return; }
  if (t && ['succeeded', 'failed', 'cancelled'].includes(t.state) && !W.doneFor?.includes(t.id)) {
    (W.doneFor ||= []).push(t.id);
    const bad = t.state === 'failed' || t.ok === false;
    const info = bad ? { bot: t.bot, title: 'Nie wyszło', text: t.result, bad: true, sticky: true, taskId: t.id } : { bot: t.bot, title: t.state === 'cancelled' ? 'Anulowane' : 'Gotowe', text: t.result, taskId: t.id };
    // rozwinięta karta → krótka informacja o wyniku; zwinięta kropka → sukces cicho, błąd zostaje na plakietce
    if (W.view === 'working') { W.done = info; go('done'); return; }
    if (bad) W.error = info;
  }
  if (['working', 'compact'].includes(W.view)) render();
}
// licznik czasu w nagłówku — bez przebudowy całej karty
setInterval(() => { if (!['working', 'waiting'].includes(W.view) || !W.task) return; const s = root.querySelector('[data-sub]'); if (s) s.innerHTML = subOf(W.task); }, 1000);

// ───────── akcje ─────────
const control = op => W.task && W.net && W.net.control(op, W.task.id);
const openMain = () => { const taskId = W.task?.id || W.done?.taskId; shell ? shell.openMain(W.session, taskId) : window.open(`/#${W.session || ''}`); collapse(); };
root.addEventListener('click', e => {
  if (drag.justDragged) return;
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'command') { W.callMe = false; openCommand(); }
  else if (act === 'expand') {
    W.callMe = false;
    if (W.task?.state === 'waiting_user') go('waiting');
    else if (live(W.task)) go('working');
    else if (W.error) { W.done = W.error; W.error = null; go('done'); }
    else openCommand();
  }
  else if (act === 'collapse') collapse();
  else if (act === 'hide') { collapse(); shell?.hide(); }
  else if (act === 'open' || act === 'fix') openMain();
  else if (act === 'pause' || act === 'resume' || act === 'cancel') control(act);
  else if (act === 'send') send();
  else if (act === 'switch') switchSession(b.dataset.id).then(() => go(W.task?.state === 'waiting_user' ? 'waiting' : 'working'));
  else if (act === 'target') { const i = W.members.indexOf(W.target || lead()); W.target = W.members[(i + 1) % W.members.length]; const v = root.querySelector('#cmd')?.value; render(); const ta = root.querySelector('#cmd'); if (ta && v) { ta.value = v; ta.dispatchEvent(new Event('input')); } ta?.focus(); }
});
root.addEventListener('contextmenu', e => { e.preventDefault(); shell?.menu(); });
document.addEventListener('keydown', e => {
  if (W.view === 'waiting' && e.key === 'Enter') { e.preventDefault(); control('resume'); }
  if (e.key === 'Escape' && EXPANDED.includes(W.view)) collapse();
});

// ───────── przeciąganie: kropka albo nagłówek, nie przyciski. Ruch < 4 px = klik. ─────────
const drag = { from: null, moved: false, justDragged: false };
root.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !shell) return;
  const zone = e.target.closest('[data-drag]');
  if (!zone) return;
  const ctl = e.target.closest('button, textarea, input');
  if (ctl && ctl !== zone) return; // przyciski w nagłówku klikają, nie ciągną
  drag.from = { x: e.screenX, y: e.screenY }; drag.moved = false;
  zone.setPointerCapture(e.pointerId);
});
root.addEventListener('pointermove', e => {
  if (!drag.from) return;
  const dx = e.screenX - drag.from.x, dy = e.screenY - drag.from.y;
  if (!drag.moved) { if (Math.hypot(dx, dy) < 4) return; drag.moved = true; shell.dragStart(); root.classList.add('dragging'); }
  shell.drag(dx, dy);
});
const endDrag = () => {
  if (!drag.from) return;
  if (drag.moved) { shell.dragEnd(); drag.justDragged = true; setTimeout(() => (drag.justDragged = false), 0); }
  drag.from = null; drag.moved = false; root.classList.remove('dragging');
};
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);

// ───────── polecenie ─────────
function openCommand() {
  go('command');
  shell?.focus();
  setTimeout(() => root.querySelector('#cmd')?.focus(), 30);
}
function wireCommand() {
  const ta = root.querySelector('#cmd'), btn = root.querySelector('[data-act="send"]');
  const size = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; btn.disabled = !ta.value.trim(); fit(); };
  ta.addEventListener('input', size);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
}
async function send() {
  const ta = root.querySelector('#cmd');
  let text = ta?.value.trim();
  if (!text) return;
  const target = W.target || lead();
  if (target !== lead() && !new RegExp(`@${target}\\b`).test(text)) text = `@${target} ${text}`;
  if (!W.session) {
    try { const s = await api.post('/api/sessions', {}); await switchSession(s.id); }
    catch (e) { W.done = { title: 'Nie wysłałem', text: e.message, bad: true }; return go('done'); }
  }
  for (let i = 0; i < 30 && !W.net?.isOpen(); i++) await new Promise(r => setTimeout(r, 100)); // świeże połączenie
  if (!W.net?.isOpen()) { W.done = { title: 'Nie wysłałem', text: 'brak połączenia z serwerem', bad: true }; return go('done'); }
  W.net.text(text);
  W.awaitReply = true;
  W.task = null;
  go('working'); // sam zleciłeś → widzisz, co się dzieje
}

// ───────── połączenia ─────────
function onEvent(t, m) {
  switch (t) {
    case 'hello':
      W.members = m.members || W.members; W.chatState = m.state;
      // activeTaskId zostaje po ostatnim zadaniu — odtwarzamy tylko, gdy rozmowa naprawdę pracuje / czeka
      if (m.activeTaskId && ['working', 'waiting_user'].includes(m.state)) replay(m.activeTaskId);
      return;
    case 'session.members': W.members = m.members; if (W.view === 'command') render(); return;
    case 'agent.state':
      W.chatState = m.state;
      if (W.awaitReply && m.state === 'idle' && W.view === 'working' && !live(W.task) && !W.pendingSay) { W.awaitReply = false; collapse(); }
      return;
    case 'say.end': {
      // odpowiedź sima po poleceniu z widgetu albo podsumowanie zadania, które się właśnie skończyło (karta „gotowe” na wierzchu).
      // Mowa PRZED narzędziem („Jasne, biorę komputer.”) też kończy się say.end — jeśli zaraz idzie tool.call, to zapowiedź, nie raport.
      if (!m.text || !(W.awaitReply || W.view === 'done')) return;
      const text = m.text.replace(/\s+/g, ' ').slice(0, 320);
      clearTimeout(W.sayT);
      W.pendingSay = { bot: m.bot, text };
      W.sayT = setTimeout(() => {
        const p = W.pendingSay; W.pendingSay = null;
        if (!p || live(W.task)) return;
        W.awaitReply = false;
        W.done = { ...(W.done || {}), bot: p.bot, title: W.done?.title || `@${p.bot}`, text: p.text };
        go('done');
      }, 700);
      return;
    }
    case 'agent.error': if (W.awaitReply) { W.awaitReply = false; W.done = { bot: m.bot, title: 'Błąd', text: m.message, bad: true, sticky: true }; go('done'); } return;
  }
  const before = W.task?.id;
  reduce(t, m);
  if (W.task && W.task.id !== before) { W.error = null; if (W.view === 'done') return go(W.awaitReply ? 'working' : 'compact'); }
  if (m.taskId || t === 'tool.call') sync();
}
/** Po (re)connect: odbuduj aktywne zadanie z historii eventów rozmowy. */
async function replay(taskId) {
  try {
    const d = await api.get(`/api/sessions/${W.session}`);
    W.task = null; W.call = null;
    for (const e of d.events.filter(e => e.taskId === taskId)) reduce(e.type, e);
    if (W.task?.id !== taskId || !live(W.task)) return;
    if (W.view === 'compact') render();
  } catch {}
}
async function switchSession(id) {
  if (id === W.session && W.net) return;
  if (W.net) { W.net.close(); W.net = null; }
  W.session = id; W.task = null; W.call = null; W.target = null; W.awaitReply = false; W.error = null;
  if (W.view !== 'command') go('compact');
  if (!id) return;
  W.net = connect({ sessionId: id, onEvent, onVoice: () => {}, onStatus: () => {} });
  for (let i = 0; i < 20 && !W.net.isOpen(); i++) await new Promise(r => setTimeout(r, 100));
}

(async () => {
  try { W.config = await api.get('/api/config'); } catch {}
  try { const { sessions } = await api.get('/api/sessions'); for (const s of sessions) W.sessions.set(s.id, { state: s.state, title: s.title, members: s.members }); if (!W.session) W.session = sessions[0]?.id || null; } catch {}
  render();
  W.lobby = connect({
    sessionId: 'lobby', onVoice: () => {}, onStatus: () => {},
    onEvent: (t, m) => {
      if (t === 'notify') { W.callMe = true; if (W.view === 'compact') render(); }
      if (t === 'session.updated') { W.sessions.set(m.session.id, { state: m.state, title: m.session.title, members: m.session.members }); if (W.view === 'compact' || (['working', 'waiting'].includes(W.view) && m.session.id !== W.session)) render(); }
      if (t === 'session.removed') { W.sessions.delete(m.id); if (m.id === W.session) switchSession(null); }
    },
  });
  await switchSession(W.session);
  if (shell) {
    shell.on('qwe:session', id => id && id !== W.session && switchSession(id));
    shell.on('qwe:command', () => (W.view === 'command' ? collapse() : openCommand()));
    shell.on('qwe:collapse', () => { if (W.view === 'command' || W.view === 'done') collapse(); });
    // agent czeka na Ciebie (w tej albo innej rozmowie) — main decyduje według ustawienia, czy rozwinąć
    shell.on('qwe:attention', async ({ sessionId, expand }) => {
      if (W.view === 'command') return;
      if (sessionId && sessionId !== W.session) await switchSession(sessionId);
      if (!expand) return render();
      for (let i = 0; i < 20 && W.task?.state !== 'waiting_user'; i++) await new Promise(r => setTimeout(r, 100));
      if (W.task?.state === 'waiting_user') go('waiting');
    });
    shell.on('qwe:stopped', ({ op, count }) => { W.done = { bot: W.task?.bot || lead(), title: count ? (op === 'pause' ? 'Wstrzymane' : 'Anulowane') : 'Nic nie pracowało', text: count ? `${count} ${count === 1 ? 'rozmowa' : count < 5 ? 'rozmowy' : 'rozmów'}.` : '' }; go('done'); });
  }
})();
