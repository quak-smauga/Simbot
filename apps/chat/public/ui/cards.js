// CARDS — zadania w chacie. W timeline: kompaktowy wiersz (.trow) + rozwijane szczegóły (mobile).
// Na desktopie szczegóły idą do panelu obok (work) — `onFocus(card)` dostaje tę samą pełną treść (.full).
// Model karty budowany z eventów agent servera: task.* · plan.* · step.* · tool.* · web.* · computer.*
import { icon } from './icons.js';
const esc = s => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** czas: 820ms · 2,4 s · 1:09 · 1:02:05 (powyżej minuty zegar, nie „69431,2 s”) */
const ms = n => { if (n == null) return ''; if (n < 1000) return `${n}ms`; if (n < 60000) return `${(n / 1000).toFixed(1).replace('.', ',')} s`; const s = Math.floor(n / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const STATE_PL = { queued: 'w kolejce', running: 'pracuje', waiting_user: 'czeka na Ciebie', paused: 'pauza', succeeded: 'gotowe', failed: 'błąd', cancelled: 'anulowane', pending: 'budzę agenta' };
const STEP_PL = { pending: '·', running: '…', completed: '✓', failed: '✗', skipped: '–', waiting_user: '⏸' };
const REASON_PL = { LOGIN_REQUIRED: '🔐 Zaloguj się', CONFIRM_ACTION: '⚠️ Potwierdź', CAPTCHA: '🧩 Captcha', USER_CONTROL: '🖱 Masz kontrolę', OTHER: '✋ Potrzebna pomoc' };
const KIND_PL = { 'web.query': 'szukam', 'computer.run': 'przeglądarka', 'memory.search': 'przypominam sobie', plan: 'plan' };
// computer.run to dwa różne środowiska: wbudowana przeglądarka (domyślnie) i cały komputer usera (target="desktop") — w UI nazywamy je osobno
const isDesktop = (args, t) => (t && t.mode ? t.mode === 'desktop' : String((args && args.target) || '').trim().toLowerCase() === 'desktop');
// narzędzia MCP: mcp.<serwer>.<narzędzie> → „serwer · narzędzie”; ogólne (mcp.call/read/prompt/tools) biorą serwer z atrybutu
const MCP_PL = { 'mcp.read': 'zasób', 'mcp.prompt': 'prompt', 'mcp.tools': 'lista narzędzi' };
const mcpKind = (name, args) => { const a = args || {}; if (name === 'mcp.call') return `${a.server || 'mcp'} · ${a.tool || '?'}`; if (MCP_PL[name]) return `${a.server || 'mcp'} · ${MCP_PL[name]}`; const m = /^mcp\.([^.]+)\.(.+)$/.exec(name); return m ? `${m[1]} · ${m[2]}` : name; };
const kindName = (name, args, t) => (name === 'computer.run' ? (isDesktop(args, t) ? 'komputer' : 'przeglądarka') : name.startsWith('mcp.') ? mcpKind(name, args || (t && t.args)) : KIND_PL[name] || name);
/** Narzędzia chat servera (bez agenta): karta minimalna — bez panelu obok, wynik w rozwinięciu pod wierszem. */
const LOCAL = new Set(['memory.search']);

export const skeleton = ({ lines = 3, block = false } = {}) =>
  `<div class="sk-stack">${block ? '<span class="sk sk--block"></span>' : ''}${Array.from({ length: lines }, (_, i) => `<span class="sk sk--line ${['sk--w80', 'sk--w60', 'sk--w40'][i % 3]}"></span>`).join('')}</div>`;

export function createCards({ container, onControl, onFocus, shotUrl, avatarFor }) {
  const cards = new Map();
  /** lokalne karty (memory.search) — nie mają taskId, więc nie siedzą w `cards` */
  const locals = [];
  let pending = null;
  let focused = null;

  // jedna delegacja na wszystkie przyciski (timeline + panel work, także sklonowana treść)
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-op]');
    if (b && b.dataset.task) { e.preventDefault(); onControl(b.dataset.op, b.dataset.task); return; }
    const row = e.target.closest('.trow');
    if (row) {
      const card = [...cards.values(), ...locals].find(c => c.el === row.parentElement) || (pending && pending.el === row.parentElement ? pending : null);
      if (!card) return;
      card.el.classList.toggle('open');
      if (!card.local) focus(card, true);
    }
  });

  function newCard() {
    const el = document.createElement('div');
    el.className = 'task';
    container.appendChild(el);
    return { taskId: null, callId: null, bot: null, kind: 'direct', state: 'pending', calls: [], steps: [], tools: new Map(), order: [], waiting: null, parts: null, error: null, startedAt: Date.now(), ms: null, el };
  }
  function toolFor(card, key, name) {
    let t = card.tools.get(key);
    if (!t) { t = { key, name, status: 'running', log: [], shots: [], results: null, progress: null, result: null, ok: null, goal: null, query: null, url: null, title: null }; card.tools.set(key, t); card.order.push(key); }
    return t;
  }
  const key = e => e.stepId || e.name;
  function focus(card, user = false) {
    focused = card;
    onFocus && onFocus(card, user);
  }

  function handle(type, e) {
    let card = e.taskId ? cards.get(e.taskId) : null;
    if (type === 'tool.call' && e.block) {
      pending = newCard();
      pending.callId = e.callId; pending.kind = e.block.kind; pending.bot = e.bot || null;
      if (e.block.kind === 'direct') pending.calls = e.block.calls;
      else pending.steps = e.block.steps.map(s => ({ ...s, status: 'pending' }));
      pending.local = pending.calls.length > 0 && pending.calls.every(c => LOCAL.has(c.name));
      if (pending.local) { pending.state = 'running'; pending.el.classList.add('local'); locals.push(pending); render(pending); return true; }
      render(pending); focus(pending);
      return true;
    }
    if (type === 'tool.result' && e.callId && !e.name) {
      const c = [...cards.values(), ...locals].find(c => c.callId === e.callId) || (pending && pending.callId === e.callId ? pending : null);
      if (c && !['succeeded', 'failed', 'cancelled'].includes(c.state)) {
        const done = () => { c.state = e.ok ? 'succeeded' : 'failed'; c.ms = e.ms; if (e.found) c.found = e.found; render(c); };
        // lokalne szukanie trwa milisekundy — postać „myśli” chwilę, żeby było widać, że coś się działo
        const left = c.local ? 800 - (Date.now() - c.startedAt) : 0;
        left > 0 ? setTimeout(done, left) : done();
      }
      if (c && c.local && pending === c) pending = null;
      return true;
    }
    if (!e.taskId) return false;
    if (type === 'task.enqueued') {
      card = pending && !pending.taskId ? pending : newCard();
      pending = null;
      card.taskId = e.taskId; card.kind = e.kind || card.kind; card.state = 'queued';
      cards.set(e.taskId, card);
      render(card); focus(card);
      return true;
    }
    if (!card) { card = newCard(); card.taskId = e.taskId; cards.set(e.taskId, card); }
    switch (type) {
      case 'task.started': card.state = 'running'; card.startedAt = e.at ? Date.parse(e.at) : Date.now(); break;
      case 'task.waiting': card.state = 'waiting_user'; card.waiting = { reason: e.reason, message: e.message, screenshotId: e.screenshotId, url: e.url, action: e.action, details: e.details }; focus(card); break;
      case 'task.resumed': card.state = 'running'; card.waiting = null; break;
      case 'task.paused': card.state = 'paused'; break;
      case 'task.succeeded': card.state = e.ok === false ? 'failed' : 'succeeded'; card.parts = e.parts || []; card.waiting = null; card.ms = Date.now() - card.startedAt; break;
      case 'task.failed': card.state = 'failed'; card.error = e.error; card.waiting = null; break;
      case 'task.cancelled': card.state = 'cancelled'; card.waiting = null; break;
      case 'plan.started': card.kind = 'plan'; card.steps = (e.steps || []).map(s => ({ ...s, status: 'pending', args: (card.steps.find(x => x.id === s.id) || {}).args })); break;
      case 'step.started': { const s = card.steps.find(x => x.id === e.stepId) || (card.steps.push({ id: e.stepId, name: e.name, after: [] }), card.steps.at(-1)); s.status = 'running'; s.args = e.args || s.args; break; }
      case 'step.completed': case 'step.failed': case 'step.skipped': { const s = card.steps.find(x => x.id === e.stepId); if (s) { s.status = type.split('.')[1]; s.ms = e.ms; s.error = e.error; } break; }
      case 'tool.call': { const t = toolFor(card, key(e), e.name); t.args = e.args; t.status = 'running'; break; }
      case 'tool.result': { const t = toolFor(card, key(e), e.name); t.status = e.ok ? 'completed' : 'failed'; t.ok = e.ok; t.ms = e.ms; if (e.error) t.log.push({ err: e.error }); break; }
      case 'web.started': { const t = toolFor(card, key({ ...e, name: 'web.query' }), 'web.query'); t.query = e.query; t.progress = 'szukam…'; break; }
      case 'web.progress': { const t = toolFor(card, key({ ...e, name: 'web.query' }), 'web.query'); t.progress = e.message; break; }
      case 'web.completed': { const t = toolFor(card, key({ ...e, name: 'web.query' }), 'web.query'); t.results = e.results || []; t.progress = `${e.provider} · ${ms(e.ms)}`; break; }
      case 'computer.started': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.goal = e.goal; t.mode = e.mode; break; }
      case 'computer.observation': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.url = e.url; t.title = e.title; if (e.screenshotId) { t.shots.push({ id: e.screenshotId, url: e.url, title: e.title }); if (t.shots.length > 12) t.shots.shift(); } break; }
      case 'computer.action': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); const last = t.log.at(-1); if (last && last.step === e.step && last.label === e.label) { last.status = e.status; last.error = e.error; } else t.log.push({ step: e.step, label: e.label, status: e.status, error: e.error, think: e.think }); if (t.log.length > 40) t.log.shift(); break; }
      case 'computer.completed': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.result = e.result; t.ok = true; break; }
      case 'computer.failed': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.result = e.error; t.ok = false; break; }
      case 'computer.cancelled': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.result = 'anulowane przez Ciebie — sim dostał raport z tego, co zdążył zrobić'; t.ok = false; break; }
      case 'computer.note': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.log.push({ label: `📝 ${e.text}`, status: 'completed' }); if (t.log.length > 40) t.log.shift(); break; }
      case 'computer.plan': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.plan = { stages: e.stages || [], budget: e.budget, est: e.estimatedSteps }; t.log.push({ label: e.alreadyDone ? '🧭 cel już spełniony na ekranie — nic do klikania' : `🧭 ${e.replan ? 'nowy plan' : 'plan'}: ${(e.stages || []).length} etap(y) · ~${e.estimatedSteps} kroków (limit ${e.budget})${e.why ? ` — ${e.why}` : ''}`, status: 'completed' }); break; }
      case 'computer.stage': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); const skip = e.status === 'skipped'; const st = t.plan?.stages.find(x => x.id === e.id); if (st) st.status = skip ? 'skipped' : 'done'; const nx = t.plan?.stages.find(x => x.id === e.next); if (nx) nx.status = 'doing'; t.log.push({ label: skip ? `– etap ${e.id} pominięty (niepotrzebny): ${e.title}` : `✓ etap ${e.id}: ${e.title}`, status: 'completed' }); break; }
      case 'computer.loop': { const t = toolFor(card, key({ ...e, name: 'computer.run' }), 'computer.run'); t.log.push({ label: `🔁 ${e.description}${e.strategyChange ? ' — zmieniam strategię' : ''}`, status: 'failed', error: 'pętla' }); break; }
      default:
        if (type.startsWith('plan.')) break;
        { const t = toolFor(card, key({ ...e, name: e.name || type.split('.')[0] + '.*' }), e.name || type); t.log.push({ label: `${type}` }); }
    }
    render(card);
    return true;
  }

  // ── widoki ──
  function mainTool(card) { return [...card.tools.values()].find(t => t.name === 'computer.run') || [...card.tools.values()][0] || null; }
  function kindOf(card) {
    if (card.kind === 'plan') return `plan · ${card.steps.length}`;
    const tools = [...card.tools.values()];
    const names = card.calls.length ? card.calls.map(c => kindName(c.name, c.args, tools.find(t => t.name === c.name))) : tools.map(t => kindName(t.name, t.args, t));
    return names.join(' + ') || 'zadanie';
  }
  function labelOf(card) {
    if (card.local) {
      const q = (card.calls[0] && card.calls[0].args && card.calls[0].args._) || 'ostatnie rozmowy';
      if (!card.found) return q;
      return card.found.length ? `${q} · ${card.found.length} ${card.found.length === 1 ? 'rozmowa' : card.found.length < 5 ? 'rozmowy' : 'rozmów'}` : `${q} · nic`;
    }
    const t = mainTool(card);
    if (card.state === 'waiting_user' && card.waiting) return `${REASON_PL[card.waiting.reason] || 'potrzebna pomoc'} — ${card.waiting.message}`;
    if (t && t.name === 'computer.run') {
      const last = t.log.at(-1);
      if (['running', 'paused'].includes(card.state) && last) return last.label;
      if (t.result) return t.result;
      if (t.title) return t.title;
    }
    if (t && t.name === 'web.query') return t.results ? `${t.results.length} wyn. · ${t.query}` : t.progress || t.query || '';
    const arg = card.calls[0] && card.calls[0].args && card.calls[0].args._;
    return arg || STATE_PL[card.state] || '';
  }

  function render(card) {
    const t = mainTool(card);
    const shot = t && t.shots && t.shots.at(-1);
    const chev = `<span class="trow__chev">${icon('chevron-right', 16)}</span>`;
    card.el.innerHTML = `<button class="trow" data-s="${card.state}"><i></i><span class="trow__bot"></span><span class="trow__kind">${esc(kindOf(card))}</span><span class="trow__label">${esc(labelOf(card))}</span>${shot ? `<img class="trow__thumb" src="${shotUrl(shot.id)}" alt="" />` : ''}<span class="trow__ms">${card.ms != null ? ms(card.ms) : ''}</span>${chev}</button><div class="tdet"><div><div class="full">${fullHtml(card)}</div></div></div>`;
    // lokalna karta: postać „myśli” w wierszu, dopóki szuka
    if (card.bot && avatarFor) { const a = avatarFor(card.bot, 20, card.local ? (['running', 'pending'].includes(card.state) ? 'thinking' : 'idle') : undefined); if (a) card.el.querySelector('.trow__bot').append(a); }
    if (focused === card) onFocus && onFocus(card, false);
  }

  /** Rozwinięcie karty „przypominam sobie”: znalezione rozmowy (data, tytuł, simy, o czym). */
  function recallHtml(card) {
    if (!card.found) return skeleton({ lines: 2 });
    if (!card.found.length) return '<div class="recall__none">Nic pasującego we wcześniejszych rozmowach.</div>';
    return `<ul class="recall">${card.found.map(f => `<li><a href="#${esc(f.id)}" data-open-session="${esc(f.id)}"><span class="recall__t">${esc(f.title)}</span><span class="recall__d">${esc(f.day)}${f.members && f.members.length ? ' · ' + f.members.map(m => '@' + esc(m)).join(' ') : ''}</span></a>${f.about ? `<p>${esc(f.about)}</p>` : ''}</li>`).join('')}</ul>`;
  }

  function fullHtml(card) {
    if (card.local) return recallHtml(card);
    let body = '';
    if (card.state === 'pending') body += skeleton({ lines: 2 });
    else if (card.kind === 'plan') body += card.steps.map(s => renderStep(card, s)).join('');
    else body += (card.calls.length ? card.calls : [...card.tools.values()].map(t => ({ name: t.name, args: t.args }))).map((c, i) => renderStep(card, { id: null, name: c.name, args: c.args, status: toolStatus(card, c.name), idx: i })).join('');
    if (card.waiting) {
      body += needsHtml(card);
    }
    if (card.error && card.state === 'failed') body += `<div class="result bad">${esc(card.error)}</div>`;
    const live = ['queued', 'running', 'paused'].includes(card.state);
    if (live && card.taskId) body += `<div class="btns">${card.state === 'paused' ? `<button class="btn btn--primary" data-op="resume" data-task="${card.taskId}">Wznów</button>` : `<button class="btn" data-op="pause" data-task="${card.taskId}">Pauza</button>`}<button class="btn btn--danger" data-op="cancel" data-task="${card.taskId}">Anuluj</button></div>`;
    return body;
  }
  /** „Czeka na Ciebie”: powód, komunikat, dane z ekranu (przy potwierdzeniu), Tak / Anuluj. */
  function needsHtml(card) {
    const w = card.waiting;
    const rows = Array.isArray(w.details) && w.details.length ? `<dl class="needs__rows">${w.details.map(d => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd></div>`).join('')}</dl>` : '';
    return `<div class="needs"><div class="needs__title">${REASON_PL[w.reason] || REASON_PL.OTHER}</div><div class="needs__msg">${esc(w.message)}</div>${rows}` +
      `<div class="btns"><button class="btn btn--primary" data-op="resume" data-task="${card.taskId}">${w.reason === 'CONFIRM_ACTION' ? 'Tak, wykonaj' : 'Zrobione — wznów'}</button><button class="btn btn--danger" data-op="cancel" data-task="${card.taskId}">Anuluj</button></div></div>`;
  }
  function toolStatus(card, name) {
    const t = [...card.tools.values()].find(t => t.name === name);
    if (t) return t.status;
    return card.state === 'running' ? 'running' : card.state === 'succeeded' ? 'completed' : card.state === 'failed' || card.state === 'cancelled' ? 'failed' : 'pending';
  }
  function renderStep(card, s) {
    const t = s.id ? card.tools.get(s.id) : [...card.tools.values()].find(t => t.name === s.name);
    const status = t && t.status !== 'running' ? t.status : s.status;
    const arg = (s.args && (s.args._ || s.args.query || s.args.task)) || (t && (t.goal || t.query)) || '';
    const part = card.parts && card.parts.find(p => (s.id ? p.stepId === s.id : p.name === s.name));
    let inner = `<div class="step__name"><b>${esc(s.name)}</b>${s.id ? `<span>#${esc(s.id)}</span>` : ''}${s.after && s.after.length ? `<span>← ${s.after.map(esc).join(', ')}</span>` : ''}${s.ms ? `<span>${ms(s.ms)}</span>` : ''}</div>`;
    if (arg) inner += `<div class="step__arg">${esc(arg)}</div>`;
    if (t) inner += renderTool(t, status);
    else if (status === 'running' || status === 'pending') inner += skeleton({ lines: 2 });
    if (status === 'skipped' && s.error) inner += `<div class="step__line">${esc(s.error)}</div>`;
    if (part && part.text && (!t || (t.name !== 'computer.run' && !(t.name === 'web.query' && t.results)))) inner += `<div class="result${part.ok ? '' : ' bad'}">${esc(part.text.slice(0, 500))}${part.text.length > 500 ? '…' : ''}</div>`;
    return `<div class="step" data-s="${status}"><div class="step__icon">${STEP_PL[status] || '·'}</div><div>${inner}</div></div>`;
  }
  function renderTool(t, status) {
    let h = '';
    if (t.name === 'web.query') {
      if (!t.results) h += status === 'running' ? `<div class="step__line"><span class="spinner"></span>${esc(t.progress || 'szukam…')}</div>${skeleton({ lines: 3 })}` : '';
      else h += `<ul class="results">${t.results.map(r => `<li><span class="ok">${r.read ? '✓' : ''}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><small>${esc(hostOf(r.url))}</small></li>`).join('') || '<li><small>brak wyników</small></li>'}</ul>`;
    } else if (t.name === 'computer.run') {
      const shot = t.shots.at(-1);
      h += shot ? `<div class="shot"><img src="${shotUrl(shot.id)}" alt="" loading="lazy" /><div class="shot__url">${esc(shot.title ? `${shot.title} — ` : '')}${esc(shot.url || '')}</div></div>` : status === 'running' ? skeleton({ lines: 1, block: true }) : '';
      if (t.log.length) h += `<div class="actions">${t.log.slice(-5).map(a => a.err ? `<div class="err">✗ ${esc(a.err)}</div>` : `<div class="${a.status === 'started' ? 'cur' : a.status === 'failed' ? 'err' : ''}">${a.step ? `${a.step}. ` : ''}${esc(a.label)}${a.status === 'failed' ? ` — ${esc(a.error || 'błąd')}` : a.status === 'started' ? ' …' : ''}${a.think ? ` <span class="think">· ${esc(a.think)}</span>` : ''}</div>`).join('')}</div>`;
      if (t.result) h += `<div class="result${t.ok ? '' : ' bad'}">${esc(t.result)}</div>`;
    } else if (t.log.length) h += `<div class="actions">${t.log.slice(-5).map(a => `<div>${esc(a.label || a.err)}</div>`).join('')}</div>`;
    return h;
  }
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // ── panel work (desktop): cały przebieg zadania, nie tylko ostatnie 5 akcji ──
  function panelHtml(card) {
    const t = mainTool(card);
    const live = ['queued', 'running', 'paused', 'pending'].includes(card.state);
    const elapsed = card.ms != null ? ms(card.ms) : live ? ms(Date.now() - card.startedAt) : '';
    const steps = card.kind === 'plan' ? card.steps : (card.calls.length ? card.calls : [...card.tools.values()].map(t => ({ name: t.name, args: t.args }))).map((c, i) => ({ id: null, name: c.name, args: c.args, status: toolStatus(card, c.name), idx: i }));
    let h = `<div class="flow"><div class="flow__head"><span class="flow__av"></span><div style="min-width:0;flex:1"><div class="flow__title">${esc(kindOf(card))}${card.bot ? ` <span style="color:var(--ink-3);font-weight:400">· @${esc(card.bot)}</span>` : ''}</div>
      <div class="flow__sub"><span class="chip" data-s="${card.state}"><i></i>${STATE_PL[card.state] || card.state}</span>${elapsed ? `<span>·</span><span class="mono">${elapsed}</span>` : ''}${card.kind === 'plan' ? `<span>·</span><span>${card.steps.length} kroków</span>` : ''}</div></div></div>`;
    if (card.waiting) h += needsHtml(card);
    h += `<div class="flow__steps">${steps.length ? steps.map(st => renderFlowStep(card, st)).join('') : card.state === 'pending' ? `<div class="flow__empty">budzę agenta…</div>` : ''}</div>`;
    if (card.error && card.state === 'failed') h += `<div class="result bad">${esc(card.error)}</div>`;
    if (live && card.taskId) h += `<div class="btns">${card.state === 'paused' ? `<button class="btn btn--primary" data-op="resume" data-task="${card.taskId}">Wznów</button>` : `<button class="btn" data-op="pause" data-task="${card.taskId}">Pauza</button>`}<button class="btn btn--danger" data-op="cancel" data-task="${card.taskId}">Anuluj</button></div>`;
    return h + '</div>';
  }
  function renderFlowStep(card, s) {
    const t = s.id ? card.tools.get(s.id) : [...card.tools.values()].find(t => t.name === s.name);
    const status = t && t.status !== 'running' ? t.status : s.status;
    const arg = (s.args && (s.args._ || s.args.query || s.args.task)) || (t && (t.goal || t.query)) || '';
    const part = card.parts && card.parts.find(p => (s.id ? p.stepId === s.id : p.name === s.name));
    let inner = `<div class="fstep__name"><b>${esc(kindName(s.name, s.args, t))}</b><small>${esc(s.name)}${s.id ? ` #${esc(s.id)}` : ''}${s.after && s.after.length ? ` ← ${s.after.map(esc).join(', ')}` : ''}${s.ms ? ` · ${ms(s.ms)}` : ''}</small></div>`;
    if (arg) inner += `<div class="fstep__arg">${esc(arg)}</div>`;
    if (t) inner += renderToolFull(t, status);
    else if (status === 'running' || status === 'pending') inner += skeleton({ lines: 2 });
    if (status === 'skipped' && s.error) inner += `<div class="step__line">${esc(s.error)}</div>`;
    if (part && part.text && (!t || (t.name !== 'computer.run' && !(t.name === 'web.query' && t.results)))) inner += `<div class="result${part.ok ? '' : ' bad'}">${esc(part.text.slice(0, 1200))}${part.text.length > 1200 ? '…' : ''}</div>`;
    return `<div class="fstep" data-s="${status}"><div class="fstep__dot">${STEP_PL[status] || '·'}</div><div>${inner}</div></div>`;
  }
  function renderToolFull(t, status) {
    let h = '';
    if (t.name === 'web.query') {
      if (!t.results) h += status === 'running' ? `<div class="step__line"><span class="spinner"></span>${esc(t.progress || 'szukam…')}</div>${skeleton({ lines: 3 })}` : '';
      else h += `<ul class="results">${t.results.map(r => `<li><span class="ok">${r.read ? '✓' : ''}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><small>${esc(hostOf(r.url))}</small></li>`).join('') || '<li><small>brak wyników</small></li>'}</ul>`;
    } else if (t.name === 'computer.run') {
      const shot = t.shots.at(-1);
      h += shot ? `<div class="shot" data-shot><img src="${shotUrl(shot.id)}" alt="" /><div class="shot__url">${esc(shot.title ? `${shot.title} — ` : '')}${esc(shot.url || '')}</div></div>` : status === 'running' ? skeleton({ lines: 1, block: true }) : '';
      if (t.plan?.stages.length) h += `<div class="flog">${t.plan.stages.map(st => `<div class="${st.status === 'doing' ? 'cur' : ''}"><span>${st.status === 'done' ? '✓' : st.status === 'skipped' ? '–' : st.status === 'doing' ? '→' : '·'}</span><span>${esc(st.title)}${st.doneWhen ? `<div class="think">zrobione, gdy: ${esc(st.doneWhen)}</div>` : ''}</span></div>`).join('')}</div>`;
      if (t.shots.length > 1) h += `<div class="shots">${t.shots.map((sh, i) => `<img src="${shotUrl(sh.id)}" alt="" class="${i === t.shots.length - 1 ? 'on' : ''}" data-url="${esc(sh.url || '')}" data-title="${esc(sh.title || '')}" loading="lazy" />`).join('')}</div>`;
      if (t.log.length) h += `<div class="flog">${t.log.map(a => a.err ? `<div class="err"><span>✗</span><span>${esc(a.err)}</span></div>` : `<div class="${a.status === 'started' ? 'cur' : a.status === 'failed' ? 'err' : ''}"><span>${a.step || ''}</span><span>${esc(a.label)}${a.status === 'failed' ? ` — ${esc(a.error || 'błąd')}` : a.status === 'started' ? ' …' : ''}${a.think ? `<div class="think">${esc(a.think)}</div>` : ''}</span></div>`).join('')}</div>`;
      if (t.result) h += `<div class="result${t.ok ? '' : ' bad'}">${esc(t.result)}</div>`;
    } else if (t.log.length) h += `<div class="flog">${t.log.map(a => `<div><span></span><span>${esc(a.label || a.err)}</span></div>`).join('')}</div>`;
    return h;
  }
  // miniatury w panelu: klik = podmiana dużego zrzutu
  document.addEventListener('click', e => {
    const img = e.target.closest('.shots img'); if (!img) return;
    const box = img.closest('.fstep')?.querySelector('[data-shot]'); if (!box) return;
    box.querySelector('img').src = img.src; box.querySelector('.shot__url').textContent = `${img.dataset.title ? img.dataset.title + ' — ' : ''}${img.dataset.url}`;
    img.parentElement.querySelectorAll('img').forEach(x => x.classList.toggle('on', x === img));
  });

  return {
    handle,
    fullHtml,
    panelHtml,
    kindOf,
    clear() { cards.clear(); locals.length = 0; pending = null; focused = null; },
    /** pokaż zadanie w panelu obok (handoff z widgetu) */
    focusTask(taskId) { const c = cards.get(taskId); if (!c) return false; focus(c, true); c.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; },
    get focused() { return focused; },
    get activeTask() { return [...cards.values()].find(c => ['running', 'waiting_user', 'paused', 'queued'].includes(c.state)) || null; },
  };
}
