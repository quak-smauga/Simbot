// QWE DESKTOP — skorupa Electrona nad chat serverem. Runtime (chat + agent) pracuje niezależnie od okien:
//   okno główne  /                         centrum dowodzenia: simy, rozmowy, kroki, zrzuty
//   widget       /widget.html?session=…    kokpit na pulpicie: kropka (compact) ↔ karta (expanded); schowany ≠ zatrzymany
//   tray         zawsze dostępny punkt wejścia: pokaż/schowaj widget, okno, wstrzymaj/zatrzymaj wszystko, ustawienia
// Widget nie walczy o uwagę: start zadania = tylko zmiana statusu. Sam pokazuje się (i rozwija) dopiero, gdy agent czeka na
// Ciebie — jak bardzo, decyduje ustawienie „Gdy agent czeka na Ciebie”.
// Skróty globalne: ⌥Space polecenie w widgecie · ⌃⌥Esc zatrzymaj wszystko.
import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, session, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDesktopBridge, helperBinary, PRIVACY_PANES } from './desktop.js';
import { ensureServer } from './server.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ASSETS = resolve(import.meta.dirname, '..', 'assets');
const PRELOAD = resolve(import.meta.dirname, 'preload.cjs');
const MOCK = process.argv.includes('--mock') || process.env.QWE_MOCK === '1';

app.setName('simbot');

// Dom usera (dane, simy, .env) — poza paczką, żeby aktualizacja nie wymazała pamięci. Spakowany Simbot.app:
// ~/Library/Application Support/simbot (tam już leży desktop.json). `qwe desktop` z repo: repo, jak dawniej.
// QWE_HOME z env wygrywa (np. test domu aplikacji z repo). Chat i agent dziedziczą je przez env.
const HOME = resolve(process.env.QWE_HOME || (app.isPackaged ? app.getPath('userData') : ROOT));
process.env.QWE_HOME = HOME;

// .env z domu usera: tylko to, czego potrzebuje skorupa (host, port, skróty) — resztę czyta chat sam
function dotenv() {
  const f = join(HOME, '.env');
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = { ...dotenv(), ...process.env };
const SHORTCUT_WIDGET = ENV.QWE_SHORTCUT_WIDGET || 'Alt+Space';
const SHORTCUT_STOP = ENV.QWE_SHORTCUT_STOP || 'Control+Alt+Escape';
const HOST = ENV.QWE_HOST && ENV.QWE_HOST !== '0.0.0.0' ? ENV.QWE_HOST : '127.0.0.1';
const PORT = Number(ENV.QWE_CHAT_PORT || 3100);
const log = msg => console.log(msg);
log(`[desktop] dom: ${HOME}${HOME === ROOT ? ' (repo)' : ''}`);

if (!app.requestSingleInstanceLock()) app.quit();

let server = null;
let mainWin = null;
let widget = null;
let tray = null;
let quitting = false;
let currentSession = null;
let desktop = null; // most do qwe-helper (sterowanie całym komputerem)
let perms = { screen: null, accessibility: null };
let agentState = 'idle'; // idle | working | waiting | error — zbiorczo ze wszystkich rozmów (lobby)

// ───────── ustawienia (lokalnie, userData/desktop.json) ─────────
const prefsFile = () => join(app.getPath('userData'), 'desktop.json');
const prefs = {
  widgetVisible: true,
  attention: 'expand', // gdy agent czeka na Ciebie: tray (tylko ikona) | show (pokaż kropkę) | expand (pokaż i rozwiń)
  startHidden: false, // start bez okna głównego (tray + widget)
  openAtLogin: false,
  desktopDisplay: 'active', // komputer (desktop): 'active' = ekran z oknem na wierzchu, albo id wybranego ekranu
  ...(() => { try { return JSON.parse(readFileSync(prefsFile(), 'utf8')); } catch { return {}; } })(),
};
const savePrefs = () => { try { writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch {} };

const webPreferences = { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };

/** Ten sam origin = nasze. Wszystko inne → przeglądarka systemowa. */
function lockNavigation(win) {
  const ours = url => url.startsWith(server.base);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!ours(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

// ───────── okno główne ─────────
function createMain() {
  const b = prefs.main || {};
  mainWin = new BrowserWindow({
    width: b.width || 1320, height: b.height || 860, x: b.x, y: b.y, minWidth: 760, minHeight: 520,
    title: 'simbot', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 },
    vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000',
    webPreferences,
  });
  lockNavigation(mainWin);
  mainWin.loadURL(`${server.base}/${currentSession ? '#' + currentSession : ''}`);
  mainWin.webContents.on('did-finish-load', () => mainWin.webContents.send('qwe:widget-visible', widgetShown()));
  const remember = () => { if (!mainWin.isMinimized() && !mainWin.isFullScreen()) { prefs.main = mainWin.getBounds(); savePrefs(); } };
  mainWin.on('resized', remember);
  mainWin.on('moved', remember);
  // zamknięcie okna nie kończy aplikacji — runtime pracuje dalej, widget i tray zostają
  mainWin.on('close', e => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
  mainWin.on('closed', () => { mainWin = null; });
}
/** Okno główne: przywróć / odminimalizuj / utwórz — i (opcjonalnie) otwórz dokładnie tę rozmowę i to zadanie. */
function showMain(sessionId, taskId) {
  const fresh = !mainWin;
  if (fresh) { if (sessionId) currentSession = sessionId; createMain(); }
  const send = () => sessionId && mainWin.webContents.send('qwe:open-session', { sessionId, taskId: taskId || null });
  if (fresh) mainWin.webContents.once('did-finish-load', () => setTimeout(send, 400)); else send();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  app.focus({ steal: true });
}

// ───────── widget: pozycja ─────────
const MARGIN = 10; // odstęp od krawędzi po snapie
const SNAP = 28; // bliżej krawędzi niż tyle → przyklej
const DOT = 76; // kropka + margines na cień

const clampTo = (wa, b) => ({
  ...b,
  x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)),
  y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)),
});
/** Pozycja startowa: zapamiętany monitor i miejsce; monitora już nie ma → najbliższy; nic nie ma → prawy górny róg. */
function initialWidgetBounds() {
  const saved = prefs.widget;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) { // stary zapis ({right, top}) z etapu 1 → domyślna pozycja
    const disp = screen.getAllDisplays().find(d => d.id === saved.displayId) || screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    return clampTo(disp.workArea, { x: saved.x, y: saved.y, width: DOT, height: DOT });
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - DOT - MARGIN, y: wa.y + 72, width: DOT, height: DOT };
}
function saveWidgetPos() {
  if (!widget) return;
  const b = widget.getBounds();
  prefs.widget = { x: b.x, y: b.y, displayId: screen.getDisplayMatching(b).id };
  savePrefs();
}
/** Po przeciągnięciu: przyklej do krawędzi w zasięgu SNAP, nigdy poza widoczny obszar. */
function snapWidget() {
  const b = widget.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let { x, y } = b;
  if (x - wa.x < SNAP) x = wa.x + MARGIN;
  if (wa.x + wa.width - (x + b.width) < SNAP) x = wa.x + wa.width - b.width - MARGIN;
  if (y - wa.y < SNAP) y = wa.y + MARGIN;
  if (wa.y + wa.height - (y + b.height) < SNAP) y = wa.y + wa.height - b.height - MARGIN;
  widget.setBounds(clampTo(wa, { ...b, x, y }), true);
  saveWidgetPos();
}
/** Zmiana kształtu: rośnie od strony, przy której stoi (prawa połowa ekranu → w lewo, dolna → w górę). */
function resizeWidget(width, height) {
  if (!widget) return;
  const w = Math.max(40, Math.min(640, Math.round(width)));
  const h = Math.max(40, Math.min(760, Math.round(height)));
  const b = widget.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const bottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  widget.setBounds(clampTo(wa, { x: right ? b.x + b.width - w : b.x, y: bottom ? b.y + b.height - h : b.y, width: w, height: h }));
}
/** Monitor odłączony / zmieniona rozdzielczość → widget wraca na widoczny ekran. */
function rescueWidget() {
  if (!widget) return;
  const b = widget.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  widget.setBounds(clampTo(disp.workArea, b));
  saveWidgetPos();
}

// ───────── widget: okno i widoczność ─────────
function createWidget() {
  widget = new BrowserWindow({
    type: 'panel', // NSPanel: nie aktywuje aplikacji — fokus zostaje w aplikacji pod spodem
    ...initialWidgetBounds(),
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
    movable: false, // przeciąganie robimy sami (klik vs drag na kropce, snap, zapamiętanie)
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, title: 'simbot widget',
    webPreferences,
  });
  widget.setAlwaysOnTop(true, 'floating');
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.setContentProtection(true); // niewidoczny na zrzutach agenta → agent nie kliknie we własny stop
  lockNavigation(widget);
  widget.loadURL(`${server.base}/widget.html${currentSession ? '?session=' + encodeURIComponent(currentSession) : ''}`);
  widget.once('ready-to-show', () => { if (prefs.widgetVisible) widget.showInactive(); syncWidgetUi(); });
  // zamknięcie = schowanie; agent pracuje dalej
  widget.on('close', e => { if (!quitting) { e.preventDefault(); hideWidget(); } });
}
const widgetShown = () => !!widget && widget.isVisible();
function syncWidgetUi() {
  mainWin?.webContents.send('qwe:widget-visible', widgetShown());
  buildTrayMenu();
}
function showWidget() {
  if (!widget) createWidget();
  if (!widget.isVisible()) widget.showInactive();
  prefs.widgetVisible = true; savePrefs();
  syncWidgetUi();
}
function hideWidget() {
  if (widget?.isVisible()) { widget.webContents.send('qwe:collapse'); widget.hide(); }
  prefs.widgetVisible = false; savePrefs();
  syncWidgetUi();
}
const toggleWidget = () => (widgetShown() ? hideWidget() : showWidget());
/** ⌥Space: polecenie w widgecie (pokazuje go, jeśli był schowany); drugi raz zwija. */
function widgetCommand() {
  showWidget();
  widget.webContents.send('qwe:command');
  widget.focus();
}

/** CGWindowID widgetu (Electron: „window:<id>:0”) — jedyne okno simbot wycinane ze zrzutów agenta. */
function widgetWindowIds() {
  try { const id = Number(widget?.getMediaSourceId().split(':')[1]); return Number.isFinite(id) && id > 0 ? [id] : []; } catch { return []; }
}

// ───────── wszystko naraz ─────────
async function controlAll(op) {
  try {
    const { sessions } = await (await fetch(`${server.base}/api/sessions`)).json();
    const busy = sessions.filter(s => (op === 'pause' ? s.state === 'working' : s.state === 'working' || s.state === 'waiting_user'));
    await Promise.all(busy.map(s => fetch(`${server.base}/api/sessions/${s.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }) }).catch(() => {})));
    log(`[desktop] ${op} wszystko: ${busy.length}`);
    widget?.webContents.send('qwe:stopped', { op, count: busy.length });
  } catch (e) {
    log(`[desktop] ${op} wszystko: ${e.message}`);
  }
}
const stopAll = () => controlAll('cancel');
const pauseAll = () => controlAll('pause');

// ───────── tray: główny punkt wejścia; logo z oczami = stan agenta ─────────
const trayImg = name => {
  const img = nativeImage.createFromPath(join(ASSETS, `tray-${name}Template.png`));
  img.setTemplateImage(true);
  return img;
};
let blinkT = null;
const STATE_PL = { idle: 'gotowy', working: 'agent pracuje', waiting: 'czeka na Ciebie' };
function setTray(state) {
  agentState = state;
  if (!tray) return;
  tray.setImage(trayImg(state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : 'idle'));
  tray.setToolTip(`simbot — ${STATE_PL[state] || state}`);
  buildTrayMenu();
}
function setPref(key, value) {
  prefs[key] = value; savePrefs();
  if (key === 'desktopDisplay') buildMenu();
  if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: value, args: ['--hidden'] });
  buildTrayMenu();
}
/** Ekran, na którym agent pracuje w trybie desktop: domyślnie aktywny (z oknem na wierzchu), albo wybrany na stałe. */
function displayMenu() {
  const ds = screen.getAllDisplays();
  const chosen = String(prefs.desktopDisplay);
  if (chosen !== 'active' && !ds.some(d => String(d.id) === chosen)) prefs.desktopDisplay = 'active'; // odłączony → aktywny
  return [
    { label: 'aktywny (z oknem na wierzchu)', type: 'radio', checked: prefs.desktopDisplay === 'active', click: () => setPref('desktopDisplay', 'active') },
    ...ds.map(d => ({ label: `${d.label || `Ekran ${d.id}`} · ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (główny)' : ''}`, type: 'radio', checked: String(prefs.desktopDisplay) === String(d.id), click: () => setPref('desktopDisplay', String(d.id)) })),
  ];
}
/** Zgody macOS dla trybu desktop: stan + skrót do właściwego panelu Ustawień. */
function permissionsMenu() {
  const row = (kind, label) => perms[kind]
    ? { label: `${label}: ✓`, enabled: false }
    : { label: `${label}: nadaj…`, click: async () => { await desktop?.call('request', { kind }).catch(() => {}); shell.openExternal(PRIVACY_PANES[kind]); } };
  return [row('screen', 'Nagrywanie ekranu'), row('accessibility', 'Dostępność (klikanie, drzewo okien)'), { type: 'separator' }, { label: 'Po nadaniu zgody: Zakończ i uruchom simbot ponownie', enabled: false }];
}
async function refreshPerms() {
  if (!desktop) return;
  try {
    const p = await desktop.call('permissions');
    if (p.screen !== perms.screen || p.accessibility !== perms.accessibility) { perms = p; buildTrayMenu(); buildMenu(); }
  } catch {}
}
function settingsMenu() {
  return [
    { label: 'Gdy agent czeka na Ciebie', enabled: false },
    { label: 'pokaż i rozwiń widget', type: 'radio', checked: prefs.attention === 'expand', click: () => setPref('attention', 'expand') },
    { label: 'pokaż kropkę widgetu', type: 'radio', checked: prefs.attention === 'show', click: () => setPref('attention', 'show') },
    { label: 'tylko ikona w pasku menu', type: 'radio', checked: prefs.attention === 'tray', click: () => setPref('attention', 'tray') },
    { type: 'separator' },
    { label: 'Uruchamiaj przy logowaniu', type: 'checkbox', checked: prefs.openAtLogin, click: i => setPref('openAtLogin', i.checked) },
    { label: 'Startuj bez okna (tylko widget)', type: 'checkbox', checked: prefs.startHidden, click: i => setPref('startHidden', i.checked) },
    { type: 'separator' },
    { label: 'Komputer: ekran agenta', submenu: displayMenu() },
    { label: `Komputer: uprawnienia${perms.screen && perms.accessibility ? ' ✓' : ' — wymagane'}`, submenu: permissionsMenu() },
  ];
}
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `simbot · ${STATE_PL[agentState] || agentState}`, enabled: false },
    { type: 'separator' },
    { label: widgetShown() ? 'Schowaj widget' : 'Pokaż widget', click: toggleWidget },
    { label: 'Polecenie…', accelerator: SHORTCUT_WIDGET, click: widgetCommand },
    { label: 'Otwórz simbot', click: () => showMain(currentSession) },
    { label: 'Nowa rozmowa', click: () => { showMain(); mainWin.webContents.send('qwe:new'); } },
    { type: 'separator' },
    { label: 'Wstrzymaj wszystko', enabled: agentState === 'working', click: pauseAll },
    { label: 'Zatrzymaj wszystko', accelerator: SHORTCUT_STOP, enabled: agentState !== 'idle', click: stopAll },
    { type: 'separator' },
    { label: 'Ustawienia', submenu: settingsMenu() },
    { type: 'separator' },
    { label: 'Zakończ simbot', role: 'quit' },
  ]));
}
function createTray() {
  tray = new Tray(trayImg('idle'));
  setTray(agentState);
  // mruganie: co kilka sekund oczy na chwilę się zamykają (tylko w spoczynku)
  const blink = () => {
    blinkT = setTimeout(() => {
      if (tray && agentState === 'idle') { tray.setImage(trayImg('blink')); setTimeout(() => agentState === 'idle' && tray?.setImage(trayImg('idle')), 140); }
      blink();
    }, 2500 + Math.random() * 4000);
  };
  blink();
}

/** Agent czeka na Ciebie w rozmowie `id` — reakcja według ustawienia. */
function attention(id) {
  if (prefs.attention === 'tray') return;
  showWidget();
  widget.webContents.send('qwe:attention', { sessionId: id, expand: prefs.attention === 'expand' });
}

/** Lobby WS: zbiorczy stan rozmów → tray, przejścia w „czeka na Ciebie” → widget. */
function watchLobby() {
  const states = new Map();
  const sum = () => { const v = [...states.values()]; setTray(v.includes('waiting_user') ? 'waiting' : v.includes('working') ? 'working' : 'idle'); };
  const update = (id, st) => { const prev = states.get(id); states.set(id, st); if (st === 'waiting_user' && prev !== 'waiting_user' && prev !== undefined) attention(id); };
  let retry = 800;
  const open = () => {
    const ws = new WebSocket(`${server.base.replace(/^http/, 'ws')}/ws?session=lobby`);
    ws.onopen = () => { retry = 800; fetch(`${server.base}/api/sessions`).then(r => r.json()).then(({ sessions }) => { states.clear(); for (const s of sessions) states.set(s.id, s.state); sum(); }).catch(() => {}); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'session.updated') { update(m.session.id, m.state); sum(); }
      else if (m.t === 'session.removed') { states.delete(m.id); sum(); }
    };
    ws.onclose = () => { if (!quitting) setTimeout(open, (retry = Math.min(8000, retry * 1.6))); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  open();
}

// ───────── menu aplikacji ─────────
function buildMenu() {
  const send = ch => () => { showMain(); mainWin.webContents.send(ch); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'simbot', submenu: [{ role: 'about', label: 'O simbot' }, { type: 'separator' }, { label: 'Ustawienia', submenu: settingsMenu() }, { type: 'separator' }, { role: 'hide', label: 'Ukryj simbot' }, { role: 'hideOthers', label: 'Ukryj pozostałe' }, { role: 'unhide', label: 'Pokaż wszystkie' }, { type: 'separator' }, { role: 'quit', label: 'Zakończ simbot' }] },
    { label: 'Plik', submenu: [{ label: 'Nowa rozmowa', accelerator: 'CmdOrCtrl+N', click: send('qwe:new') }, { label: 'Szukaj rozmowy', accelerator: 'CmdOrCtrl+K', click: send('qwe:find') }, { type: 'separator' }, { role: 'close', label: 'Zamknij okno' }] },
    { label: 'Edycja', submenu: [{ role: 'undo', label: 'Cofnij' }, { role: 'redo', label: 'Ponów' }, { type: 'separator' }, { role: 'cut', label: 'Wytnij' }, { role: 'copy', label: 'Kopiuj' }, { role: 'paste', label: 'Wklej' }, { role: 'selectAll', label: 'Zaznacz wszystko' }] },
    { label: 'Widok', submenu: [{ role: 'reload', label: 'Odśwież' }, { role: 'toggleDevTools', label: 'Narzędzia dewelopera' }, { type: 'separator' }, { role: 'resetZoom', label: 'Rozmiar rzeczywisty' }, { role: 'zoomIn', label: 'Powiększ' }, { role: 'zoomOut', label: 'Pomniejsz' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Pełny ekran' }] },
    { label: 'Rozmowa', submenu: [{ label: 'Pokaż / schowaj widget', accelerator: 'CmdOrCtrl+Shift+W', click: toggleWidget }, { label: 'Polecenie w widgecie', accelerator: SHORTCUT_WIDGET, click: widgetCommand }, { type: 'separator' }, { label: 'Wstrzymaj wszystko', click: pauseAll }, { label: 'Zatrzymaj wszystko', accelerator: SHORTCUT_STOP, click: stopAll }, { type: 'separator' }, { label: 'Widget: narzędzia dewelopera', click: () => widget?.webContents.openDevTools({ mode: 'detach' }) }] },
    { label: 'Okno', submenu: [{ role: 'minimize', label: 'Minimalizuj' }, { role: 'zoom', label: 'Powiększ okno' }, { type: 'separator' }, { label: 'simbot', click: () => showMain() }] },
  ]));
}

// ───────── IPC ─────────
const fromWidget = e => e.sender === widget?.webContents;
ipcMain.on('app:set-session', (e, id) => {
  if (e.sender !== mainWin?.webContents || id === currentSession) return;
  currentSession = id;
  widget?.webContents.send('qwe:session', id);
});
ipcMain.on('app:toggle-widget', toggleWidget);
ipcMain.on('app:open-main', (_e, { sessionId, taskId } = {}) => { widget?.webContents.send('qwe:collapse'); showMain(sessionId, taskId); });
ipcMain.on('app:stop-all', stopAll);
ipcMain.on('app:theme', (_e, t) => { if (t === 'dark' || t === 'light') nativeTheme.themeSource = t; });
ipcMain.on('widget:resize', (e, { width, height }) => { if (fromWidget(e)) resizeWidget(width, height); });
ipcMain.on('widget:focus', e => { if (fromWidget(e)) widget.focus(); });
ipcMain.on('widget:release', e => { if (fromWidget(e)) widget.blur(); });
ipcMain.on('widget:hide', e => { if (fromWidget(e)) hideWidget(); });
// przeciąganie: renderer liczy przesunięcie kursora od miejsca chwycenia, main przesuwa okno; puszczenie = snap + zapis
let dragFrom = null;
ipcMain.on('widget:drag-start', e => { if (fromWidget(e)) dragFrom = widget.getBounds(); });
ipcMain.on('widget:drag', (e, { dx, dy }) => { if (fromWidget(e) && dragFrom) widget.setBounds({ ...dragFrom, x: Math.round(dragFrom.x + dx), y: Math.round(dragFrom.y + dy) }); });
ipcMain.on('widget:drag-end', e => { if (fromWidget(e) && dragFrom) { dragFrom = null; snapWidget(); } });
ipcMain.on('widget:menu', e => {
  if (!fromWidget(e)) return;
  Menu.buildFromTemplate([
    { label: 'Otwórz simbot', click: () => showMain(currentSession) },
    { label: 'Polecenie…', accelerator: SHORTCUT_WIDGET, click: widgetCommand },
    { type: 'separator' },
    { label: 'Wstrzymaj wszystko', enabled: agentState === 'working', click: pauseAll },
    { label: 'Zatrzymaj wszystko', accelerator: SHORTCUT_STOP, enabled: agentState !== 'idle', click: stopAll },
    { type: 'separator' },
    { label: 'Ustawienia', submenu: settingsMenu() },
    { type: 'separator' },
    { label: 'Schowaj widget', click: hideWidget },
  ]).popup({ window: widget });
});

// ───────── start ─────────
app.on('second-instance', () => showMain(currentSession));
app.on('activate', () => showMain(currentSession));
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async e => {
  globalShortcut.unregisterAll();
  desktop?.stop();
  clearTimeout(blinkT);
  if (server && !server.attached && !server.stopped) {
    e.preventDefault();
    server.stopped = true;
    await server.stop();
    app.quit();
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && existsSync(join(ASSETS, 'icon.png'))) app.dock.setIcon(join(ASSETS, 'icon.png'));
  buildMenu();
  // most do helpera PRZED chatem: chat → agent dziedziczą QWE_DESKTOP_URL / TOKEN z env
  const dataDir = resolve(HOME, ENV.QWE_DATA_DIR || 'data');
  desktop = createDesktopBridge({ helperPath: helperBinary(ROOT), infoFile: join(dataDir, 'desktop-bridge.json'), getDisplay: () => String(prefs.desktopDisplay), excludeWindowIds: widgetWindowIds, log });
  await desktop.listen();
  refreshPerms();
  setInterval(refreshPerms, 15000);
  try {
    server = await ensureServer({ root: ROOT, host: HOST, port: PORT, mock: MOCK, log });
  } catch (e) {
    dialog.showErrorBox('simbot nie wystartował', e.message);
    app.exit(1);
    return;
  }
  // mikrofon (głos / kropka) i schowek tylko dla naszego originu
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'clipboard-read', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allowed.has(perm) && (details.requestingUrl || '').startsWith(server.base)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && (origin || '').startsWith(server.base));

  // start z logowania (--hidden) albo ustawienie „startuj bez okna” → tylko tray + widget
  const hidden = prefs.startHidden || process.argv.includes('--hidden');
  createTray();
  createWidget();
  if (hidden) { if (!prefs.widgetVisible) showWidget(); } else { createMain(); mainWin.once('ready-to-show', () => mainWin.show()); }
  watchLobby();
  screen.on('display-removed', rescueWidget);
  screen.on('display-metrics-changed', rescueWidget);
  if (!globalShortcut.register(SHORTCUT_WIDGET, () => (widgetShown() && widget.isFocused() ? widget.webContents.send('qwe:command') : widgetCommand()))) log(`[desktop] skrót ${SHORTCUT_WIDGET} zajęty przez inną aplikację`);
  if (!globalShortcut.register(SHORTCUT_STOP, stopAll)) log(`[desktop] skrót ${SHORTCUT_STOP} zajęty przez inną aplikację`);
  log(`[desktop] gotowe · ${SHORTCUT_WIDGET} polecenie · ${SHORTCUT_STOP} stop${MOCK ? ' · MOCK' : ''}${hidden ? ' · bez okna' : ''}`);
}).catch(e => {
  // błąd przy starcie nie może zostawić apki bez okien i bez komunikatu
  console.error(e);
  dialog.showErrorBox('simbot: błąd startu', e?.stack || String(e));
  app.quit();
});
