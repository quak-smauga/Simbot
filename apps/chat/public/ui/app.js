// APP — user → simy → rozmowy (jeden sim albo grupa) → @ → powiadomienia. Sidebar (simy + rozmowy), wątek, composer z @,
// panel work (desktop), głos (kropka), strony: sim / workflowy / puste stany. Lobby WS trzyma listę rozmów na żywo.
import { $, api, confirmBox, esc, isDesktop, mentions, setMentionColor, splitTitle, timeAgo, toast } from './dom.js';
import { md } from './markdown.js';
import { connect } from './net.js';
import { makePlayer, openMic } from './audio.js';
import { createKropka } from './kropka.js';
import { createCards, skeleton, shimmer } from './cards.js';
import { makeAvatar, mountGroup, setState as setAvatarState, startBlinking } from './avatar.js';
import { makeLogo, blinkLogos } from './logo.js';
import { cfgOf } from './builder.js';
import { attachMentions } from './mentions.js';
import { newSimDialog, renderSimPage } from './sims.js';
import { profileDialog, renderEmpty, renderWorkflowsPage, workflowEditor } from './pages.js';
import { renderMcpPage } from './mcp.js';
import { icon } from './icons.js';
import { initModels, modelCaps } from './models.js';
import { filesHtml, initAttach } from './attach.js';
import { initFiles } from './files.js';

// ikony z data-icon (Lucide) — raz na start, potem w szablonach przez icon()
const hydrateIcons = root => root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon, el.dataset.size ? Number(el.dataset.size) : undefined); el.removeAttribute('data-icon'); });
hydrateIcons(document);
initModels();

const STATE_PL = { idle: 'gotowy', listening: 'słucham', thinking: 'myśli', speaking: 'mówi', working: 'pracuje', waiting_user: 'czeka na Ciebie' };
const AV_STATE = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking', working: 'working', waiting_user: 'confused' };
const timeline = $('timeline'), tl = $('tl'), input = $('input');
let attach = null; // załączniki (attach.js) — ustawiane przy composerze niżej
let files = null; // panel plików rozmowy (files.js)

// ───────── motyw ─────────
const theme = {
  get: () => localStorage.getItem('qwe.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  apply(t) { document.documentElement.dataset.theme = t; localStorage.setItem('qwe.theme', t); window.qwe && window.qwe.setTheme(t); }, // Electron: vibrancy sidebaru idzie za motywem
};
theme.apply(theme.get());
// Electron (apps/desktop): preload daje window.qwe — pasek okna, widget, skróty z menu. W przeglądarce nic się nie zmienia.
const shell = window.qwe || null;
if (shell) document.documentElement.dataset.shell = 'electron';
const syncTheme = () => { $('themeBtn').innerHTML = icon(theme.get() === 'dark' ? 'sun' : 'moon'); $('themeBtn').title = theme.get() === 'dark' ? 'Jasny motyw' : 'Ciemny motyw'; };
syncTheme();
$('themeBtn').onclick = () => { theme.apply(theme.get() === 'dark' ? 'light' : 'dark'); syncTheme(); };

// ───────── logo: intro raz, potem mono z oczami ─────────
$('brandLogo').append(makeLogo({ size: 22, intro: !sessionStorage.getItem('qwe.intro') }));
sessionStorage.setItem('qwe.intro', '1');
blinkLogos(); startBlinking();

// ───────── sidebar / drawer ─────────
const nav = {
  set(open) { document.body.dataset.nav = open ? 'open' : 'closed'; if (isDesktop()) localStorage.setItem('qwe.nav', open ? 'open' : 'closed'); },
  get open() { return document.body.dataset.nav === 'open'; },
  init() { this.set(isDesktop() ? localStorage.getItem('qwe.nav') !== 'closed' : false); },
};
// 960–1240px z otwartym komputerem: na sidebar nie ma miejsca (CSS zwija go do 0) → przycisk menu wysuwa go jako nakładkę („peek”),
// komputer zostaje otwarty. Peek znika po wyborze rozmowy, kliknięciu w tło, Esc albo zamknięciu komputera.
const squeezeMq = matchMedia('(min-width: 960px) and (max-width: 1240px)');
const navSqueezed = () => squeezeMq.matches && (document.body.dataset.work === 'open' || document.body.dataset.files === 'open');
const peek = { set(on) { document.body.toggleAttribute('data-peek', !!on); }, get on() { return document.body.hasAttribute('data-peek'); } };
const toggleNav = () => (navSqueezed() ? peek.set(!peek.on) : nav.set(!nav.open));
const closeNav = () => (peek.on ? peek.set(false) : nav.set(false));
squeezeMq.addEventListener('change', () => peek.set(false));
$('menuBtn').onclick = toggleNav;
$('pageMenu').onclick = toggleNav;
$('pageBack').onclick = () => app.current && openSession(app.current);
$('navClose').onclick = closeNav;
$('backdrop').onclick = closeNav;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && peek.on) { peek.set(false); e.stopImmediatePropagation(); } }, true);
let swipe = null;
document.addEventListener('touchstart', e => { const t = e.touches[0]; swipe = (t.clientX < 24 || nav.open) ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!swipe || isDesktop()) return;
  const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = Math.abs(t.clientY - swipe.y);
  if (dy < 60 && dx > 60 && !nav.open) nav.set(true);
  if (dy < 60 && dx < -60 && nav.open) nav.set(false);
  swipe = null;
}, { passive: true });
matchMedia('(min-width: 960px)').addEventListener('change', () => nav.init());

// ───────── stan ─────────
const app = {
  config: null, bots: [], sima: null, builtinAvailable: [], sessions: [], current: null, members: [], workflow: null, page: 'chat',
  net: null, lobby: null, state: 'idle', player: null, mic: null, micLevel: 0, kropka: null, voiceOn: false, streaming: null, cards: null, hello: null, lastAuthor: null, filter: '',
};
/** Simy widoczne (app.bots) + Sima — domyślna, poza listą simów. */
app.allBots = () => (app.sima ? [app.sima, ...app.bots] : app.bots);
const botOf = name => app.allBots().find(b => b.name === name);
const avatarOf = (name, size = 34, state) => { const b = botOf(name); return b ? makeAvatar({ ...cfgOf(b.look), id: b.name, state }, size) : null; };
const meCfg = () => cfgOf(app.config.me.look);
const meAvatar = (size = 34) => makeAvatar({ ...meCfg(), id: '@me' }, size);
const known = () => app.allBots().map(b => b.name);
setMentionColor(n => { const b = botOf(n); return b ? cfgOf(b.look).color || '' : ''; });
const work = { open(on) { document.body.dataset.work = on ? 'open' : 'closed'; if (!on && !(files && files.isOpen)) peek.set(false); }, get isOpen() { return document.body.dataset.work === 'open'; } };
$('workClose').onclick = () => work.open(false);

app.cards = createCards({
  container: tl,
  shotUrl: id => `/api/screenshots/${id}`,
  avatarFor: (name, size, state) => avatarOf(name, size, state),
  onControl: (op, taskId) => app.net && app.net.control(op, taskId),
  onFocus(card, user) {
    $('workTitle').textContent = app.cards.kindOf(card);
    $('workBody').innerHTML = app.cards.panelHtml(card);
    const av = $('workBody').querySelector('.flow__av'); if (av && card.bot) { const a = avatarOf(card.bot, 36, ['running', 'queued', 'pending'].includes(card.state) ? 'working' : card.state === 'waiting_user' ? 'confused' : card.state === 'failed' ? 'error' : 'idle'); if (a) av.append(a); }
    if (isDesktop() && user) work.open(true);
  },
});

// ───────── konfiguracja, simy, rozmowy ─────────
app.loadConfig = async () => { app.config = await api.get('/api/config'); app.bots = app.config.bots; app.sima = app.config.sima; app.builtinAvailable = app.config.builtinAvailable; renderMe(); renderSims(); };
app.loadBots = async () => { const d = await api.get('/api/bots'); app.bots = d.bots; app.sima = d.sima; app.builtinAvailable = d.builtinAvailable; app.config.bots = d.bots; renderSims(); renderMe(); return d; };
async function loadSessions(withSkeleton = false) {
  if (withSkeleton) $('convs').innerHTML = Array.from({ length: 4 }, () => `<div class="sk-row"><span class="sk sk--dot"></span><div class="sk-stack"><span class="sk sk--line sk--w60"></span><span class="sk sk--line sk--w80"></span></div></div>`).join('');
  app.sessions = (await api.get('/api/sessions')).sessions;
  renderSessions();
}

function renderMe() {
  const me = app.config.me;
  $('meAv').innerHTML = ''; $('meAv').append(meAvatar(36));
  $('meName').textContent = me.name || 'bez imienia';
  $('meSubText').textContent = `${app.bots.length} ${plural(app.bots.length, 'sim', 'simy', 'simów')} · ${$('meSub').dataset.agent === 'up' ? 'agent online' : $('meSub').dataset.agent === 'starting' ? 'agent wstaje…' : 'agent śpi'}`;
}
const plural = (n, a, b, c) => (n === 1 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

function renderSims() {
  const el = $('sims');
  el.innerHTML = '';
  for (const b of app.bots) {
    const btn = document.createElement('button'); btn.className = 'sim-av' + (app.page === 'sim' && app.pageArg === b.name ? ' active' : ''); btn.title = `@${b.name}${b.description ? ' — ' + b.description : ''}`;
    btn.append(makeAvatar({ ...cfgOf(b.look), id: b.name }, 34));
    btn.onclick = () => { showSim(b.name); if (!isDesktop()) nav.set(false); };
    el.append(btn);
  }
  const add = document.createElement('button'); add.className = 'sim-av sim-av--add'; add.title = 'Dodaj sima'; add.innerHTML = icon('plus', 16); add.onclick = () => app.addSim(); el.append(add);
}

function renderSessions() {
  const q = app.filter.trim().toLowerCase();
  const list = app.sessions.filter(s => !q || s.title.toLowerCase().includes(q) || (s.snip || '').toLowerCase().includes(q) || s.members.some(m => m.includes(q)));
  $('searchWrap').hidden = app.sessions.length < 6;
  $('convs').innerHTML = list.map((s, i) => {
    const { emoji, text } = splitTitle(s.title);
    const snip = s.snip ? (s.snip.includes(': ') ? `<b>${esc(s.snip.split(': ')[0])}:</b> ${esc(s.snip.slice(s.snip.indexOf(': ') + 2))}` : esc(s.snip)) : `<span style="color:var(--ink-3)">${s.members.map(m => '@' + esc(m)).join(', ') || 'bez simów'}</span>`;
    const dot = s.state === 'working' ? '<span class="conv__dot" title="pracuje"></span>' : s.state === 'waiting_user' ? '<span class="conv__dot conv__dot--ask" title="czeka na Ciebie"></span>' : `<span class="conv__time">${timeAgo(s.updated_at)}</span>`;
    return `<a class="conv${s.id === app.current && app.page === 'chat' ? ' on' : ''}" style="--i:${Math.min(i, 14)}" data-id="${s.id}" href="#${s.id}">
      <div class="conv__av" id="cav-${s.id}"></div>
      <div><div class="conv__name">${emoji ? `<span class="emoji">${emoji}</span>` : ''}<span>${esc(text || 'Nowa rozmowa')}</span></div><div class="conv__snip">${snip}</div></div>
      <div class="conv__meta">${dot}${s.unread && s.id !== app.current ? `<span class="conv__badge">${s.unread}</span>` : ''}</div>
      <button class="conv__del" title="Usuń rozmowę" data-del="${s.id}">${icon('x', 14)}</button></a>`;
  }).join('');
  $('navEmpty').hidden = !!app.sessions.length;
  $('navEmpty').textContent = 'Jeszcze żadnej rozmowy. Kliknij „Nowa rozmowa” — zaczniesz z Simą, a innego sima dodasz w rozmowie.';
  for (const s of list) { const h = mountGroup($(`cav-${s.id}`), s.members.map(m => botOf(m)).filter(Boolean).map(b => ({ ...cfgOf(b.look), id: b.name })), 44); h.setState(s.state === 'working' ? 'working' : s.state === 'waiting_user' ? 'confused' : s.state === 'thinking' ? 'thinking' : 'idle'); }
  if (renderSessions.settled) $('convs').classList.add('settled'); else setTimeout(() => { renderSessions.settled = true; $('convs').classList.add('settled'); }, 900);
  $('convs').querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    if (!(await confirmBox('Usunąć rozmowę?', 'Historia i karty zadań znikną. Simy i ich pamięć zostają.'))) return;
    await api.del(`/api/sessions/${b.dataset.del}`);
    if (app.current === b.dataset.del) { app.current = null; location.hash = ''; }
    await loadSessions();
    if (!app.current) pickFirstOrEmpty();
  });
  $('convs').querySelectorAll('.conv').forEach(a => a.onclick = e => { e.preventDefault(); if (a.dataset.id === app.current && app.page === 'chat') return; openSession(a.dataset.id); peek.set(false); if (!isDesktop()) nav.set(false); });
}
$('search').oninput = () => { app.filter = $('search').value; renderSessions(); };

app.newSession = async (bots, workflowId = null) => {
  try {
    const s = await api.post('/api/sessions', { bots, workflowId });
    await loadSessions();
    openSession(s.id);
    if (!isDesktop()) nav.set(false);
    setTimeout(() => input.focus(), 300);
  } catch (e) { toast(e.message); }
};
/** Nowa rozmowa = od razu z Simą (bez wyboru). Innego sima dodaje się / podmienia już w rozmowie. */
app.quickSession = () => app.newSession([]);
app.addSim = async (opts = {}) => {
  const b = await newSimDialog(app, opts);
  if (!b) return undefined;
  await app.loadBots();
  renderSessions();
  if (!opts.quiet) showSim(b.name);
  return b;
};
app.afterSimRemoved = () => { app.current ? openSession(app.current) : pickFirstOrEmpty(); };
function pickFirstOrEmpty() { if (app.sessions.length) openSession(app.sessions[0].id); else showPage('empty', 'nochat'); }
$('newBtn').onclick = () => app.quickSession();

// ───────── strony ─────────
function showPage(p, arg) {
  app.page = p; app.pageArg = arg; document.body.dataset.page = p;
  const chat = p === 'chat';
  $('timeline').hidden = !chat; $('page').hidden = chat; $('composer').hidden = !chat; $('head').hidden = !chat; $('pagebar').hidden = chat;
  $('pageBack').hidden = !app.current || !app.sessions.some(s => s.id === app.current);
  $('voicePanel').hidden = !(chat && app.voiceOn);
  $('jumpBtn').hidden = true;
  if (!chat) { work.open(false); if (app.net) { app.net.close(); app.net = null; } if (p !== 'sim' || arg !== app.current) { /* rozmowa zostaje w hashu tylko na czacie */ } }
  if (p === 'sim') { location.hash = `sim/${arg}`; renderSimPage(app, arg); }
  if (p === 'workflows') { location.hash = 'workflows'; renderWorkflowsPage(app); }
  if (p === 'mcp') { location.hash = 'mcp'; renderMcpPage(app); }
  if (p === 'empty') { location.hash = ''; renderEmpty(app, arg); }
  renderSims(); renderSessions();
}
async function showSim(name) { await app.loadBots(); if (!app.bots.some(b => b.name === name)) return pickFirstOrEmpty(); showPage('sim', name); }

// ───────── otwarcie rozmowy ─────────
async function openSession(id) {
  if (app.net) { app.net.close(); app.net = null; }
  app.current = id; location.hash = id;
  shell && shell.setSession(id);
  app.page = 'chat';
  thinking.el = null; app.streaming = null; app.lastAuthor = null; app.authors = new Set(); app.cards.clear(); work.open(false);
  attach && attach.clear();
  files && files.setSession(id);
  tl.innerHTML = '';
  const sk = document.createElement('div'); sk.className = 'tl-sk'; sk.innerHTML = skeleton({ lines: 3 }) + '<div style="height:18px"></div>' + skeleton({ lines: 2 }); tl.appendChild(sk);
  showPage('chat');
  let data;
  try { data = await api.get(`/api/sessions/${id}`); } catch { sk.remove(); app.current = null; return pickFirstOrEmpty(); }
  sk.remove();
  app.members = data.session.members; app.workflow = data.workflow; syncSolo();
  const s = app.sessions.find(x => x.id === id); if (s) s.unread = 0;
  renderHead(); setTitle(data.session.title, false);
  const items = [
    ...data.messages.filter(m => m.role !== 'tool').map(m => ({ at: m.at, msg: m })),
    ...data.events.map(e => ({ at: e.at, ev: e })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const it of items) {
    if (it.msg) {
      if (it.msg.role === 'user') addUser(it.msg.content, it.msg.meta && it.msg.meta.source, it.msg.at, it.msg.meta && it.msg.meta.files);
      else { const t = (it.msg.meta && it.msg.meta.spoken) || stripBlock(it.msg.content); if (t) addBot(it.msg.author, t, it.msg.at); }
    } else if (it.ev.type === 'memory.saved') memoryMemo(it.ev);
    else if (it.ev.type === 'skill.saved') { skillMemo(it.ev); app.cards.handle(it.ev.type, it.ev); }
    else app.cards.handle(it.ev.type, it.ev);
  }
  if (!items.length) renderThreadEmpty();
  work.open(false);
  setVoiceUi(!!data.session.voice);
  setState(data.state || 'idle');
  scrollDown(true);
  app.net = connect({ sessionId: id, onEvent, onVoice: p => app.player && app.player.chunk(p), onStatus: st => { $('metaRight').textContent = st === 'online' ? '' : st; } });
  renderSessions();
}
const stripBlock = s => s.replace(/<nativeapi>[\s\S]*$/, '').trim();
app.openSession = openSession;

/** Jeden sim w rozmowie (w tym sama Sima) i nikt inny nie pisał → bez awatara i @nazwy przy wiadomościach. */
function syncSolo() { tl.classList.toggle('solo', new Set([...app.members, ...(app.authors || [])]).size <= 1); }
function noteAuthor(name) { if (!app.authors) app.authors = new Set(); if (!app.authors.has(name)) { app.authors.add(name); syncSolo(); } }

function renderThreadEmpty() {
  const m = app.members.map(n => botOf(n)).filter(Boolean);
  const el = document.createElement('div'); el.className = 'empty'; el.id = 'empty';
  el.innerHTML = `<div class="avs" id="emAvs"></div><h2>${m.length > 1 ? `${m.map(b => '@' + esc(b.name)).join(', ')}` : m[0] ? `@${esc(m[0].name)}` : 'Rozmowa'}</h2><p>${m.length > 1 ? 'Grupa. Bez @ odpowiada pierwszy sim; <code class="kbd">@nazwa</code> zwraca się do konkretnego, <code class="kbd">@nazwa.task</code> zleca zadanie. Simy mogą wołać siebie nawzajem i Ciebie.' : m[0] && m[0].name === app.sima?.name ? 'Napisz albo mów — Sima poszuka w sieci albo weźmie komputer. Potrzebujesz specjalisty? Napisz <code class="kbd">@nazwa</code> — przejmie rozmowę.' : m[0] ? esc(m[0].description || 'Napisz albo mów. Sim poszuka w sieci albo weźmie komputer — każdy krok zobaczysz tutaj.') : 'Napisz <code class="kbd">@nazwa</code>, żeby zawołać sima.'}</p>${app.workflow ? `<span class="hint">workflow: <b>${esc(app.workflow.name)}</b></span>` : ''}`;
  tl.append(el);
  m.forEach(b => $('emAvs').append(makeAvatar({ ...cfgOf(b.look), id: b.name }, 56)));
}

// ───────── nagłówek ─────────
let headAv = null;
function renderHead() {
  $('headAv').innerHTML = '';
  headAv = mountGroup($('headAv'), app.members.map(n => botOf(n)).filter(Boolean).map(b => ({ ...cfgOf(b.look), id: b.name })), 40);
  const mem = app.members.map(n => `@${esc(n)}`).join(' · ');
  renderLead();
  $('headSub').innerHTML = `<span class="st" data-state="${app.state}"><i></i><span id="stateText">${STATE_PL[app.state] || app.state}</span></span>${mem ? `<span>·</span><span style="overflow:hidden;text-overflow:ellipsis">${mem}</span>` : ''}${app.workflow ? `<span>·</span><span class="wf" title="workflow">${icon('workflow', 13)} ${esc(app.workflow.name)}</span>` : ''}`;
}
function setTitle(title, pending) {
  $('titleWrap').classList.toggle('loading', !!pending);
  $('titleSk').hidden = !pending;
  if (!pending) $('titleInput').value = title || 'Nowa rozmowa';
  const s = app.sessions.find(s => s.id === app.current);
  if (s && !pending && title) { s.title = title; renderSessions(); }
}
$('titleInput').onchange = async () => { if (!app.current) return; await api.patch(`/api/sessions/${app.current}`, { title: $('titleInput').value }); loadSessions(); };
$('ddBtn').onclick = () => { if ($('dd').hidden) renderDd(); $('dd').hidden = !$('dd').hidden; };
$('meBtn').onclick = () => { if ($('meMenu').hidden) renderMeMenu(); $('meMenu').hidden = !$('meMenu').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#dd,#ddBtn')) $('dd').hidden = true; if (!e.target.closest('#meMenu,#meBtn')) $('meMenu').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('dd').hidden = true; $('meMenu').hidden = true; } }, true);
function renderDd() {
  const others = app.allBots().filter(b => !app.members.includes(b.name));
  $('dd').innerHTML = `<div class="k">w tej rozmowie</div>${app.members.map(n => { const b = botOf(n); return `<div class="mem" data-m="${esc(n)}"><span class="av"></span>@${esc(n)}<small>${esc(b?.description || '')}</small>${app.members.length > 1 ? `<button class="x" data-rm="${esc(n)}" title="Usuń z rozmowy">${icon('x', 14)}</button>` : ''}</div>`; }).join('')}<div class="mem"><span class="av" id="ddMe"></span>${esc(app.config.me.name)}<small>Ty · @${esc(app.config.me.slug)}</small></div>
    ${others.length ? `<hr/><div class="k">dodaj sima</div>${others.map(b => `<button data-add="${esc(b.name)}"><span class="av"></span>@${esc(b.name)}<small style="color:var(--ink-3);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${esc(b.description)}</small></button>`).join('')}` : ''}
    <hr/><div class="k">workflow</div><div class="row"><select class="input" id="ddWf" style="padding:8px 10px;font-size:13px"><option value="">bez workflow</option>${app.config.workflows.map(w => `<option value="${esc(w.id)}"${app.workflow && w.id === app.workflow.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}<option value="__new">+ nowy…</option></select>${app.workflow ? `<button class="ib" id="ddWfEdit" title="Edytuj workflow">${icon('pencil', 16)}</button>` : ''}</div>
    <hr/><button id="ddFiles">${icon('folder-open')}Otwórz folder plików</button><button id="ddClear">${icon('brush')}Wyczyść historię</button><button id="ddDel" style="color:var(--bad)">${icon('trash-2')}Usuń rozmowę</button>`;
  $('dd').querySelectorAll('.mem[data-m]').forEach(el => { const a = avatarOf(el.dataset.m, 22); if (a) el.querySelector('.av').append(a); });
  $('ddMe').append(meAvatar(22));
  $('dd').querySelectorAll('[data-add]').forEach(b => { const a = avatarOf(b.dataset.add, 22); if (a) b.querySelector('.av').append(a); b.onclick = () => { app.net && app.net.send({ t: 'member.add', bot: b.dataset.add }); $('dd').hidden = true; }; });
  $('dd').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { app.net && app.net.send({ t: 'member.remove', bot: b.dataset.rm }); $('dd').hidden = true; });
  $('ddWf').onchange = async e => { if (e.target.value === '__new') { $('dd').hidden = true; const w = await workflowEditor(app); if (w) app.net && app.net.send({ t: 'workflow', workflowId: w.id }); } else app.net && app.net.send({ t: 'workflow', workflowId: e.target.value || null }); };
  const ed = $('ddWfEdit'); if (ed) ed.onclick = async () => { $('dd').hidden = true; const w = app.config.workflows.find(x => x.id === app.workflow.id); const full = (await api.get('/api/workflows')).workflows.find(x => x.id === w.id); const r = await workflowEditor(app, full); if (r === null) app.workflow = null; else if (r) app.workflow = { id: r.id, name: r.name }; renderHead(); };
  $('ddFiles').onclick = async () => { $('dd').hidden = true; try { await api.post(`/api/sessions/${app.current}/files/open`); } catch (e) { toast(e.message); } };
  $('ddClear').onclick = async () => { $('dd').hidden = true; if (!(await confirmBox('Wyczyścić historię?', 'Wiadomości i karty tej rozmowy znikną.', 'Wyczyść'))) return; app.net && app.net.reset(); openSession(app.current); };
  $('ddDel').onclick = async () => { $('dd').hidden = true; if (!(await confirmBox('Usunąć rozmowę?', 'Historia i karty zadań znikną. Simy i ich pamięć zostają.'))) return; await api.del(`/api/sessions/${app.current}`); app.current = null; await loadSessions(); pickFirstOrEmpty(); };
}
function renderMeMenu() {
  $('meMenu').innerHTML = `<button id="mmProfile">${icon('user')}Profil: imię i awatar</button><button id="mmWf">${icon('workflow')}Workflowy</button><button id="mmMcp">${icon('plug')}Serwery MCP</button><button id="mmSim">${icon('user-plus')}Dodaj sima</button><hr/><a href="${esc(app.config.agent.url)}/dashboard/" target="_blank" rel="noopener">${icon('activity')}Dashboard agenta<span class="sp"></span>${icon('external-link', 14)}</a><button id="mmTheme">${icon(theme.get() === 'dark' ? 'sun' : 'moon')}Motyw: ${theme.get() === 'dark' ? 'ciemny' : 'jasny'}</button>`;
  $('mmProfile').onclick = async () => { $('meMenu').hidden = true; if (await profileDialog(app)) { renderMe(); if (app.page === 'chat' && app.current) openSession(app.current); } };
  $('mmWf').onclick = () => { $('meMenu').hidden = true; showPage('workflows'); if (!isDesktop()) nav.set(false); };
  $('mmMcp').onclick = () => { $('meMenu').hidden = true; showPage('mcp'); if (!isDesktop()) nav.set(false); };
  $('mmSim').onclick = () => { $('meMenu').hidden = true; app.addSim(); };
  $('mmTheme').onclick = () => { theme.apply(theme.get() === 'dark' ? 'light' : 'dark'); syncTheme(); renderMeMenu(); };
}

// ───────── wątek ─────────
let stick = true;
timeline.addEventListener('scroll', () => { stick = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 200; $('jumpBtn').hidden = stick; }, { passive: true });
new ResizeObserver(() => stick && (timeline.scrollTop = timeline.scrollHeight)).observe(tl);
function scrollDown(force) { if (force) stick = true; if (stick) timeline.scrollTop = timeline.scrollHeight; }
$('jumpBtn').onclick = () => { timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' }); stick = true; };
const clearEmpty = () => $('empty')?.remove();

function addUser(text, source, at, files) {
  clearEmpty(); app.lastAuthor = '@me';
  const el = document.createElement('div'); el.className = 'msg msg--me';
  el.innerHTML = `${filesHtml(app.current, files)}${text ? `<div class="msg__body">${mentions(esc(text), { user: app.config.me.slug, known: known() })}</div>` : ''}${metaHtml(at, source === 'stt' ? '🎙 głosem' : '')}`;
  bindTools(el, () => text);
  tl.appendChild(el); scrollDown(true);
  return el;
}
/** Sim „myśli” (LLM call): wiadomość-zaślepka z shimmerem. Pierwsza delta odpowiedzi przejmuje ją jako swoją; gdy zamiast mówić
 *  sim odpala narzędzie albo wraca do idle — znika i nie zostawia po sobie „ciągłości” autora. */
const thinking = { el: null, prev: null };
function showThinking(bot) {
  if (thinking.el && thinking.el.dataset.author === bot && thinking.el.isConnected) return;
  hideThinking();
  thinking.prev = app.lastAuthor;
  const body = addBot(bot, '', null, { by: app.turnBy, state: 'thinking' });
  body.innerHTML = `<span class="shim-dot"></span>${shimmer('myśli…')}`;
  thinking.el = body.closest('.msg'); thinking.el.classList.add('msg--thinking');
}
function hideThinking() {
  if (!thinking.el) return;
  if (thinking.el.isConnected) { thinking.el.remove(); app.lastAuthor = thinking.prev; }
  thinking.el = null;
}
/** Odpowiedź sima zaczyna się pisać: weź jego zaślepkę „myśli…”, jeśli jest (bez skoku w wątku). */
function takeThinking(bot) {
  const el = thinking.el; thinking.el = null;
  if (!el || !el.isConnected || el.dataset.author !== bot) { el && el.isConnected && (el.remove(), app.lastAuthor = thinking.prev); return null; }
  el.classList.remove('msg--thinking');
  const body = el.querySelector('.msg__body'); body.innerHTML = '';
  const av = el.querySelector('.avatar'); av && setAvatarState(av, 'speaking');
  return body;
}
function addBot(name, text, at, opts = {}) {
  clearEmpty();
  const cont = app.lastAuthor === name && !opts.force;
  app.lastAuthor = name;
  noteAuthor(name);
  const el = document.createElement('div'); el.className = `msg${cont ? ' msg--cont' : ''}`; el.dataset.author = name;
  el.innerHTML = `<div class="msg__av"></div><div class="msg__main"><div class="msg__who"><b>@${esc(name)}</b>${opts.by && opts.by !== app.config.me.slug ? `<span class="by">← @${esc(opts.by)}</span>` : ''}</div><div class="msg__body">${md(text, { user: app.config.me.slug, known: known() })}</div>${metaHtml(at)}</div>`;
  bindTools(el, () => el.querySelector('.msg__body').innerText);
  tl.appendChild(el);
  const a = avatarOf(name, 34, opts.state || 'idle'); if (a) el.querySelector('.msg__av').append(a);
  scrollDown();
  return el.querySelector('.msg__body');
}
/** Pod wiadomością: godzina (+ dzień, jeśli nie dziś) · dopisek · kopiuj. Widać na hover / po tapnięciu (dotyk). */
function metaHtml(at, extra = '') {
  const d = at ? new Date(at) : new Date();
  const hm = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const t = d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })}, ${hm}`;
  return `<div class="msg__meta"><time datetime="${d.toISOString()}" title="${esc(d.toLocaleString('pl-PL'))}">${t}</time>${extra ? `<span>· ${extra}</span>` : ''}<button class="ib" title="Kopiuj" data-copy>${icon('copy')}</button></div>`;
}
tl.addEventListener('click', e => {
  if (!matchMedia('(hover: none)').matches || e.target.closest('a,button,input,textarea')) return;
  const m = e.target.closest('.msg'); if (!m) return;
  tl.querySelectorAll('.msg.meta-on').forEach(x => x !== m && x.classList.remove('meta-on'));
  m.classList.toggle('meta-on');
});
function bindTools(el, getText) {
  const b = el.querySelector('[data-copy]');
  b.onclick = async () => { try { await navigator.clipboard.writeText(getText().trim()); b.innerHTML = icon('check'); setTimeout(() => (b.innerHTML = icon('copy')), 1200); } catch { toast('nie udało się skopiować'); } };
}
function addSys(html, bot) {
  clearEmpty();
  const el = document.createElement('div'); el.className = 'sys'; el.innerHTML = html;
  if (bot) { const a = avatarOf(bot, 16); if (a) el.prepend(a); }
  tl.appendChild(el); scrollDown();
  return el;
}
/** „@a → @b · prowadzi”. Kilka zmian z rzędu (klikanie w chip) zwija się w jedną linię; powrót do punktu wyjścia ją usuwa. */
function leadLine(prev, lead) {
  const last = tl.lastElementChild;
  if (last && last.dataset.leadFrom != null) { prev = last.dataset.leadFrom; last.remove(); }
  if (prev === lead) return;
  addSys(`@${esc(prev || '')} → @${esc(lead)} · prowadzi`, lead).dataset.leadFrom = prev || '';
}
/** Etykieta chipa pamięci: wspólna o userze vs notatki sima (stare eventy bez scope → jak dawniej). */
const memoryMemo = ev => addMemo('🧠', ev.scope === 'user' ? 'Zapamiętane o Tobie' : ev.scope === 'sim' ? 'Notatka do pracy' : 'Zapamiętane', ev.added, ev.removed, {
  agent: ev.agent,
  hint: ev.scope === 'user' ? 'Wspólna pamięć — wiedzą wszystkie simy. Podgląd i usuwanie: profil.' : ev.scope === 'sim' ? `Tylko dla @${ev.agent} — przyda się w jego pracy. Podgląd: strona sima.` : `Pamięć @${ev.agent}.`,
});
const skillMemo = ev => addMemo('📘', 'Nowy skill', [`${ev.name}${ev.description ? ' — ' + ev.description : ''}`], [], { agent: ev.agent, hint: `@${ev.agent} zapisał sposób działania — od następnej rozmowy ma go w prompcie.` });
/** Wspomniany sim spoza rozmowy nie odpowiada — podpowiedź z przyciskiem „dodaj do rozmowy”. */
function absentHint(names) {
  for (const n of names) {
    if (!botOf(n) || app.members.includes(n)) continue;
    addSys(`@${esc(n)} nie ma w tej rozmowie, więc nie odpowie · <button class="sys__btn" data-join="${esc(n)}">dodaj do rozmowy</button>`, n);
    const b = tl.querySelector(`.sys:last-child [data-join="${n}"]`);
    if (b) b.onclick = () => { b.disabled = true; app.net && app.net.send({ t: 'member.add', bot: n }); b.closest('.sys').remove(); };
  }
}
/** Notka pamięci/skilla: jeden wiersz („🧠 Zapamiętane o Tobie · pierwszy fakt ›”), klik rozwija listę i wyjaśnienie.
 *  Ląduje w odpowiedzi sima, który ją zapisał — za tekstem, przed wierszem z godziną. Bez takiej odpowiedzi → na końcu wątku. */
function addMemo(emoji, title, added = [], removed = [], { agent, hint } = {}) {
  const items = [...added.map(a => ({ t: a })), ...removed.map(a => ({ t: a, gone: true }))];
  if (!items.length) return;
  const first = items[0];
  const el = document.createElement('div'); el.className = 'memo';
  el.innerHTML = `<button class="memo__row" type="button"><span class="memo__ic">${emoji}</span><b>${esc(title)}</b><span class="memo__first${first.gone ? ' gone' : ''}">${esc(first.t)}</span>${items.length > 1 ? `<span class="memo__more">+${items.length - 1}</span>` : ''}<span class="memo__chev">${icon('chevron-right', 14)}</span></button>
    <div class="memo__det"><div><ul>${items.map(i => `<li${i.gone ? ' class="gone"' : ''}>${esc(i.t)}</li>`).join('')}</ul>${hint ? `<p>${esc(hint)}</p>` : ''}</div></div>`;
  el.querySelector('.memo__row').onclick = () => el.classList.toggle('open');
  const msgs = agent ? [...tl.querySelectorAll('.msg:not(.msg--me)')].filter(m => m.dataset.author === agent) : [];
  const host = msgs.at(-1)?.querySelector('.msg__main');
  if (host) host.insertBefore(el, host.querySelector('.msg__meta'));
  else tl.appendChild(el);
  scrollDown();
}

// ───────── eventy rozmowy ─────────
function onEvent(t, m) {
  switch (t) {
    case 'hello':
      app.hello = m; $('metaLeft').textContent = m.mock ? 'mock' : '';
      if (m.members) { app.members = m.members; app.workflow = m.workflow; renderHead(); syncSolo(); }
      setState(m.state); setVoiceUi(!!m.voice);
      break;
    case 'agent.state': setState(m.state, m.bot); break;
    case 'bot.turn': app.turnBy = m.by; break; // „dołącza” pokazuje session.members
    case 'mention.absent': absentHint(m.names); break;
    case 'chain.limit': {
      // łańcuch sim→sim stanął na limicie z workflow — „Kontynuuj” puszcza simy dalej
      const el = addSys(`simy wymieniły ${m.hops} ${m.hops === 1 ? 'wiadomość' : 'wiadomości'} bez Ciebie · czeka @${esc(m.next[0])} <button class="sys__go" type="button">Kontynuuj</button>`, m.next[0]);
      el.querySelector('.sys__go').onclick = e => { e.target.remove(); app.net && app.net.send({ t: 'chain.continue' }); };
      break;
    }
    case 'user.heard': app.kropka && app.kropka.blink(); break;
    case 'session.title': setTitle(m.title, !!m.pending); break;
    case 'session.members': {
      app.members = m.members; renderHead(); syncSolo();
      if ($('empty')) { $('empty').remove(); renderThreadEmpty(); } // pusta rozmowa: odśwież powitanie z nowym składem
      else {
        if (m.left && m.joined) addSys(`@${esc(m.joined)} przejmuje rozmowę od @${esc(m.left)} · teraz on prowadzi`, m.joined);
        else if (m.left) addSys(`@${esc(m.left)} opuszcza rozmowę`);
        else if (m.joined && m.lead) addSys(`Dodano @${esc(m.joined)} · teraz prowadzi — bez @ odpowiada on`, m.joined);
        else if (m.lead && !m.joined) leadLine(m.prev, m.lead);
        if (m.joined && !m.left && !m.lead) addSys(`@${esc(m.joined)} dołącza do rozmowy${m.by && m.by !== app.config.me.slug ? ` (zawołany przez @${esc(m.by)})` : ''}`, m.joined);
      }
      if (!$('dd').hidden) renderDd();
      loadSessions();
      break;
    }
    case 'session.workflow': app.workflow = m.workflowId ? { id: m.workflowId, name: m.name } : null; renderHead(); if (!$('dd').hidden) renderDd(); if (!$('empty')) addSys(m.workflowId ? `workflow: ${esc(m.name)}` : 'workflow odpięty'); else { $('empty').remove(); renderThreadEmpty(); } break;
    case 'memory.saved': memoryMemo(m); if (app.page === 'sim') app.loadBots().then(() => renderSimPage(app, app.pageArg)); break;
    case 'skill.saved': skillMemo(m); app.cards.handle(t, m); app.loadBots(); break;
    case 'user.text': addUser(m.text, m.source, undefined, m.files); files && files.refresh(); break;
    case 'mention.user': { const b = botOf(m.bot); toast({ title: `@${m.bot} woła Cię`, text: m.text, avatar: avatarOf(m.bot, 36, 'confused') }); if (b) {/* w tej rozmowie — widać w wątku */} break; }
    case 'say.start': app.streaming = { sayId: m.sayId, bot: m.bot, text: '', el: null }; break;
    case 'say.text':
      if (!app.streaming || app.streaming.sayId !== m.sayId) app.streaming = { sayId: m.sayId, bot: m.bot, text: '', el: null };
      app.streaming.text += m.delta;
      if (!app.streaming.el) { app.streaming.el = takeThinking(m.bot) || addBot(m.bot, '', null, { by: app.turnBy, state: 'speaking' }); app.streaming.el.classList.add('streaming'); }
      paintStream();
      break;
    case 'say.end':
      if (app.streaming && app.streaming.el) { cancelAnimationFrame(app.streaming.raf); app.streaming.el.classList.remove('streaming'); app.streaming.el.innerHTML = md(m.text || app.streaming.text, { user: app.config.me.slug, known: known() }); const av = app.streaming.el.closest('.msg')?.querySelector('.avatar'); av && setAvatarState(av, 'idle'); }
      else if (m.text) { const b = takeThinking(m.bot); if (b) b.innerHTML = md(m.text, { user: app.config.me.slug, known: known() }); else addBot(m.bot, m.text, null, { by: app.turnBy }); }
      else hideThinking();
      app.streaming = null;
      break;
    case 'voice.end': app.player && app.player.end(m.sayId); break;
    case 'agent.error': hideThinking(); toast(`błąd${m.bot ? ' @' + m.bot : ''}: ${m.message}`); break;
    case 'user.command': toast(`komenda: ${m.command}`); break;
    case 'control.result': toast(m.error ? `nie da się: ${m.error}` : `${m.op}: ${m.state}`); break;
    case 'error': toast(m.message); break;
    case 'log': if (m.level !== 'info') toast(m.message); if (/^\[agent\]/.test(m.message)) agentLamp(m.message); break;
    case 'session.voice': setVoiceUi(m.on); break;
    case 'user.level': break;
    case 'tool.call': case 'tool.result': if (t === 'tool.call') hideThinking(); app.cards.handle(t, m); scrollDown(); if (m.agent) agentLamp('[agent] online'); break;
    default:
      if (m.agent) { app.cards.handle(t, m); scrollDown(); agentLamp('[agent] online'); if (t === 'computer.action' && m.status === 'started') app.kropka && app.kropka.pulse(); }
  }
}
/** Streaming: delty przychodzą częściej niż klatki — renderujemy markdown najwyżej raz na klatkę (całość, w trybie streaming:
 *  niedokończone tabele/linki/pogrubienia czekają, zamiast mignąć surowymi znaczkami). */
function paintStream() {
  const st = app.streaming;
  if (!st || st.raf) return;
  st.raf = requestAnimationFrame(() => {
    st.raf = 0;
    if (app.streaming !== st || !st.el) return;
    st.el.innerHTML = md(st.text, { streaming: true, user: app.config.me.slug, known: known() });
    scrollDown();
  });
}
// karta „przypominam sobie”: klik w znalezioną rozmowę → otwórz ją
tl.addEventListener('click', e => {
  const a = e.target.closest('[data-open-session]'); if (!a) return;
  e.preventDefault();
  if (app.sessions.some(s => s.id === a.dataset.openSession)) openSession(a.dataset.openSession); else toast('tej rozmowy już nie ma');
});
// kopiowanie bloku kodu z odpowiedzi
tl.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-code]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.closest('.md-code').querySelector('code').innerText); b.classList.add('done'); b.lastElementChild.textContent = 'skopiowano'; setTimeout(() => { b.classList.remove('done'); b.lastElementChild.textContent = 'kopiuj'; }, 1400); }
  catch { toast('nie udało się skopiować'); }
});

function setState(s, bot) {
  app.state = s;
  if (s === 'thinking' && bot && app.page === 'chat') showThinking(bot); else if (s !== 'speaking') hideThinking();
  const st = $('headSub').querySelector('.st'); if (st) { st.dataset.state = s; st.querySelector('span').textContent = bot && s !== 'idle' && s !== 'listening' ? `@${bot} ${STATE_PL[s] || s}` : STATE_PL[s] || s; }
  $('voiceState').textContent = STATE_PL[s] || s;
  syncSend();
  app.kropka && app.kropka.setState(s);
  headAv && headAv.setState(AV_STATE[s] || 'idle');
  if (bot) document.querySelectorAll(`.sims .avatar[data-bot="${bot}"]`).forEach(a => setAvatarState(a, AV_STATE[s] || 'idle'));
  if (s === 'idle' || s === 'listening') document.querySelectorAll('.sims .avatar').forEach(a => setAvatarState(a, 'idle'));
  $('voiceHint').textContent = s === 'waiting_user' ? 'zrób, o co prosi, i powiedz „zrobione, leć dalej”' : s === 'working' ? 'możesz powiedzieć „zatrzymaj” albo „przejmuję kontrolę”' : voiceUi.hintsLeft() ? 'mów · Esc przerywa' : '';
}
function agentLamp(msg) {
  const st = /online/.test(msg) ? 'up' : /startuję/.test(msg) ? 'starting' : /zakończony|padł/.test(msg) ? 'down' : null;
  if (!st) return;
  $('meSub').dataset.agent = st; renderMe();
}

// ───────── lobby: lista rozmów na żywo + powiadomienia ─────────
function openLobby() {
  app.lobby = connect({
    sessionId: 'lobby',
    onVoice: () => {},
    onStatus: () => {},
    onEvent: (t, m) => {
      if (t === 'session.updated') { const i = app.sessions.findIndex(s => s.id === m.session.id); const row = { ...m.session, state: m.state }; if (i === -1) app.sessions.unshift(row); else app.sessions[i] = row; app.sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)); renderSessions(); }
      else if (t === 'session.removed') { app.sessions = app.sessions.filter(s => s.id !== m.id); renderSessions(); }
      else if (t === 'notify') toast({ title: `@${m.bot} woła Cię`, text: `${m.title ? m.title + ' — ' : ''}${m.text}`, avatar: avatarOf(m.bot, 36, 'confused'), onClick: () => openSession(m.sessionId) });
      else if (t === 'mcp.status') { if (app.page === 'mcp') { clearTimeout(app.mcpT); app.mcpT = setTimeout(() => app.page === 'mcp' && !document.querySelector('.modal') && renderMcpPage(app), 400); } }
      else if (t === 'agent.status' || t === 'hello') agentLamp(m.status === 'up' || m.agent === 'up' ? '[agent] online' : m.status === 'starting' ? '[agent] startuję' : '[agent] zakończony');
    },
  });
}

// ───────── „Odpowiada: @sim” nad polem ─────────
// Kto usłyszy następną wiadomość: prowadzący (members[0]); gdy w polu jest @sim — podgląd, kto odpowie po wysłaniu
// (sim spoza rozmowy: „przejmie rozmowę”). Klik = wybór prowadzącego z listy, × = z powrotem Sima.
// jak maskQuoted w @qwe/core: kod, cytat „>”, tekst w cudzysłowie — to omawianie, nie wołanie
const maskQuoted = t => t.replace(/```[\s\S]*?(```|$)/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length)).replace(/^[ \t]*>.*$/gm, m => ' '.repeat(m.length)).replace(/[„“"«][^„“”"«»\n]{0,160}[”“"»]/g, m => ' '.repeat(m.length));
function calledIn(text) {
  for (const m of maskQuoted(text).matchAll(/(^|[^\p{L}\p{N}_@])@([a-z0-9][a-z0-9-]*)(?:\.[a-z]+)?(:?)/giu)) {
    if (m[3]) continue;
    const n = m[2].toLowerCase();
    if (n !== app.config.me.slug && botOf(n)) return n;
  }
  return null;
}
function renderLead() {
  const el = $('lead');
  const lead = app.members[0];
  const called = app.config && calledIn(input.value);
  const show = !!lead && app.page === 'chat' && (app.members.length > 1 || (called && called !== lead));
  el.hidden = !show;
  if (!show) return;
  const who = called || lead;
  const soon = called && called !== lead;
  const absent = called && !app.members.includes(called);
  const sima = app.sima?.name;
  const canReset = !soon && sima && app.members.includes(sima) && lead !== sima;
  el.className = `lead${soon ? ' soon' : ''}`;
  el.innerHTML = `<button class="lead__b" id="leadPick" type="button" title="${soon ? 'po wysłaniu' : 'Kto odpowie na wiadomość bez @ — kliknij, żeby zmienić'}"><span class="lead__av"></span><span>${absent ? `<b>@${esc(who)}</b> przejmie rozmowę` : `${soon ? 'Odpowie' : 'Odpowiada'}: <b>@${esc(who)}</b>`}</span>${!soon && app.members.length > 1 ? icon('chevron-down', 13) : ''}</button>${canReset ? `<button class="lead__x" id="leadReset" type="button" title="Z powrotem @${esc(sima)}">${icon('x', 12)}</button>` : ''}`;
  const a = avatarOf(who, 18); if (a) el.querySelector('.lead__av').append(a);
  const b = botOf(who); if (b) el.style.setProperty('--lc', cfgOf(b.look).color || 'var(--ink-3)');
  const r = $('leadReset'); if (r) r.onclick = () => app.net && app.net.send({ t: 'lead', bot: sima });
  $('leadPick').onclick = () => { if (soon || app.members.length < 2) return; leadMenu(); };
}
function leadMenu() {
  const el = $('lead');
  let menu = el.querySelector('.lead__menu');
  if (menu) { menu.remove(); return; }
  menu = document.createElement('div'); menu.className = 'lead__menu';
  menu.innerHTML = `<div class="k">kto odpowiada bez @</div>${app.members.map((n, i) => `<button data-lead="${esc(n)}" class="${i === 0 ? 'on' : ''}"><span class="av"></span>@${esc(n)}<small>${esc(botOf(n)?.description || '')}</small></button>`).join('')}`;
  menu.querySelectorAll('[data-lead]').forEach(btn => { const a = avatarOf(btn.dataset.lead, 20); if (a) btn.querySelector('.av').append(a); btn.onclick = () => { app.net && app.net.send({ t: 'lead', bot: btn.dataset.lead }); menu.remove(); input.focus(); }; });
  el.append(menu);
}
document.addEventListener('mousedown', e => { const m = document.querySelector('.lead__menu'); if (m && !e.target.closest('#lead')) m.remove(); });

// ───────── wysyłanie + @ ─────────
const mention = attachMentions(input, {
  anchor: $('cbox'),
  items: () => [...app.allBots().map(b => ({ name: b.name, label: `@${b.name}`, desc: app.members.includes(b.name) ? (b.description || 'w rozmowie') : `przejmie rozmowę${b.description ? ' · ' + b.description : ''}`, cfg: cfgOf(b.look), kind: 'sim' })), { name: app.config.me.slug, label: `@${app.config.me.slug}`, desc: 'Ty', cfg: meCfg(), kind: 'user' }],
  files: () => (files ? files.all() : []),
});
files = initFiles({
  root: $('fpanelIn'),
  toggleBtn: $('filesBtn'),
  session: () => app.current,
  onMention: paths => insertAtCaret(paths.map(p => `@[${p}]`).join(' ') + ' '),
  onOpenChange: on => { if (on && work.isOpen) work.open(false); if (!on) peek.set(false); },
});
/** Wstawia tekst w miejscu kursora (ze spacją przed, jeśli trzeba) i oddaje fokus polu. */
function insertAtCaret(text) {
  const v = input.value, a = input.selectionStart ?? v.length, b = input.selectionEnd ?? v.length;
  const pre = a > 0 && !/\s$/.test(v.slice(0, a)) ? ' ' : '';
  input.value = v.slice(0, a) + pre + text + v.slice(b);
  const pos = a + pre.length + text.length;
  input.focus(); input.setSelectionRange(pos, pos); autosize();
}
// @[ścieżka] w wątku → pokaż w panelu plików
tl.addEventListener('click', e => { const f = e.target.closest('[data-fpath]'); if (f) { e.preventDefault(); files.reveal(f.dataset.fpath); } });
attach = initAttach({
  cbox: $('cbox'),
  session: () => app.current,
  canDrop: () => app.page === 'chat' && !!app.current && !document.querySelector('.modal'),
  onChange: () => autosize(),
  warnVision: () => { const c = modelCaps(); if (c && !c.vision) toast(`${c.model} nie widzi obrazów — plik trafi do folderu, ale sim go nie zobaczy`); },
  onUploaded: () => files && files.refresh(),
});
input.addEventListener('paste', e => attach.paste(e));
function send() {
  const text = input.value.trim();
  if ((!text && !attach.count) || !app.net) return;
  if (attach.busy) { toast('Chwila — pliki jeszcze się wysyłają'); return; }
  const files = attach.ready();
  if (!text && !files.length) return;
  input.value = ''; autosize(); renderLead();
  app.net.send({ t: 'text', text, files });
  attach.clear();
}
/** Simy myślą/mówią, a pole puste → strzałka staje się Stopem (kończy też łańcuch sim→sim). Z tekstem — wyślij (i tak przerywa łańcuch). */
const isBusy = () => app.state === 'thinking' || app.state === 'speaking';
function syncSend() {
  const b = $('sendBtn'); if (!b) return;
  const has = !!input.value.trim() || !!(attach && attach.count);
  const stop = isBusy() && !has;
  if (b.classList.contains('send--stop') !== stop || !b.firstElementChild) { b.classList.toggle('send--stop', stop); b.innerHTML = icon(stop ? 'square' : 'arrow-up', stop ? 14 : undefined); }
  b.disabled = !stop && !has;
  b.title = stop ? 'Zatrzymaj simy (Esc)' : 'Wyślij (Enter)';
}
$('sendBtn').onclick = () => { if ($('sendBtn').classList.contains('send--stop')) { app.net && app.net.interrupt(); return; } send(); };
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mention.open) { e.preventDefault(); send(); } });
input.addEventListener('input', () => { autosize(); renderLead(); });
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; syncSend(); }

// ───────── głos ─────────
const voiceUi = {
  hintsLeft() { return Number(localStorage.getItem('qwe.voicehints') || 0) < 3; },
  consumeHint() { localStorage.setItem('qwe.voicehints', String(Number(localStorage.getItem('qwe.voicehints') || 0) + 1)); },
};
const replay = el => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; };
function setVoiceFull(full) { $('voicePanel').classList.toggle('full', full); replay($('voicePanel')); $('voicePanel').querySelector('canvas').style.animation = 'none'; }
async function setVoice(on) {
  if (on) {
    $('voicePanel').classList.add('full'); // głos zaczyna się na pełnym ekranie; „zmniejsz” dokuje kropkę nad wątkiem
    voiceUi.consumeHint();
    if (!app.player) app.player = makePlayer({ onPlayed: sayId => app.net && app.net.played(sayId) });
    app.player.ensure();
    if (!app.mic) {
      try { app.mic = await openMic({ onFrame: buf => app.net && app.net.audio(buf), onLevel: l => (app.micLevel = l), targetRate: (app.hello && app.hello.sampleRate) || 16000 }); }
      catch (e) { toast(`mikrofon: ${e.message}`); }
    }
    app.mic && app.mic.setMuted(false);
  } else { app.mic && app.mic.setMuted(true); app.player && app.player.abort(); }
  app.net && app.net.voice(on);
  setVoiceUi(on);
}
function setVoiceUi(on) {
  app.voiceOn = on;
  $('voiceBtn').classList.toggle('on', on);
  $('voicePanel').hidden = !on || app.page !== 'chat';
  if (on) {
    if (!app.kropka) app.kropka = createKropka($('kropka'), { getLevel: state => (state === 'speaking' && app.player ? Math.max(0, app.player.level()) : state === 'listening' ? Math.min(1, (app.micLevel || 0) * 6) : 0) });
    app.kropka.setState(app.state); app.kropka.start();
  } else { app.kropka && app.kropka.stop(); $('voicePanel').classList.remove('full'); }
  $('voiceBtn').innerHTML = icon(on ? 'mic' : 'mic'); $('voiceBtn').title = on ? 'Zakończ głos (M)' : 'Głos (M)';
}
$('voiceMin').onclick = () => setVoiceFull(false);
$('voiceMax').onclick = () => setVoiceFull(true);
$('voiceStop').onclick = () => setVoice(false);
let vSwipe = null;
$('voicePanel').addEventListener('touchstart', e => { vSwipe = e.touches[0].clientY; }, { passive: true });
$('voicePanel').addEventListener('touchend', e => { if (vSwipe != null && e.changedTouches[0].clientY - vSwipe > 90 && $('voicePanel').classList.contains('full')) setVoiceFull(false); vSwipe = null; }, { passive: true });
$('voiceBtn').onclick = () => setVoice(!app.voiceOn);
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) { if (e.key === 'Escape' && e.target === input) { input.blur(); app.net && app.net.interrupt(); } return; }
  if (document.querySelector('.modal')) return;
  if (e.key === 'm' || e.key === 'M') setVoice(!app.voiceOn);
  if ((e.key === 'f' || e.key === 'F') && app.voiceOn) setVoiceFull(!$('voicePanel').classList.contains('full'));
  if (e.key === 'Escape') {
    if (app.voiceOn && app.state !== 'idle' && app.state !== 'listening') { app.kropka && app.kropka.shrink(); app.net && app.net.interrupt(); return; }
    if (app.voiceOn && $('voicePanel').classList.contains('full')) setVoiceFull(false); else if (work.isOpen) work.open(false); else if (files.isOpen && document.querySelector('#fpanel:focus-within')) files.setOpen(false); else app.net && app.net.interrupt();
  }
});

// ───────── Electron: widget, menu aplikacji, tray ─────────
if (shell) {
  $('widgetBtn').onclick = () => shell.toggleWidget();
  shell.on('qwe:widget-visible', on => $('widgetBtn').setAttribute('aria-checked', on ? 'true' : 'false'));
  shell.on('qwe:new', () => $('newBtn').click());
  shell.on('qwe:find', () => { if (!nav.open) nav.set(true); $('searchWrap').hidden = false; $('search').focus(); });
  // handoff z widgetu: dokładnie ta rozmowa i to zadanie (panel komputera otwarty na nim), nie strona główna
  shell.on('qwe:open-session', async ({ sessionId, taskId } = {}) => {
    if (!sessionId || !app.sessions.some(s => s.id === sessionId)) return;
    if (sessionId !== app.current || app.page !== 'chat') await openSession(sessionId);
    if (taskId) app.cards.focusTask(taskId);
  });
}

// ───────── start ─────────
(async () => {
  nav.init();
  $('convs').innerHTML = '';
  await app.loadConfig();
  agentLamp(app.config.agent.status === 'up' ? '[agent] online' : '[agent] zakończony');
  openLobby();
  if (!app.config.me.name) { await profileDialog(app, { locked: true }); renderMe(); }
  await loadSessions();
  const wanted = location.hash.slice(1);
  if (wanted.startsWith('sim/')) showSim(wanted.slice(4));
  else if (wanted === 'workflows') showPage('workflows');
  else if (wanted === 'mcp') showPage('mcp');
  else if (wanted && app.sessions.some(s => s.id === wanted)) openSession(wanted);
  else pickFirstOrEmpty();
  setInterval(() => app.sessions.length && renderSessions(), 60000);
})();
