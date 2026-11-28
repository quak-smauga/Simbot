// PRELOAD — jedyny most UI ↔ Electron (tylko operacje desktopowe; dane idą przez WS z runtime'u).
// UI działa też w zwykłej przeglądarce: tam `window.qwe` po prostu nie istnieje.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['qwe:session', 'qwe:command', 'qwe:open-session', 'qwe:new', 'qwe:find', 'qwe:stopped', 'qwe:collapse', 'qwe:attention', 'qwe:widget-visible', 'qwe:keys']);

contextBridge.exposeInMainWorld('qwe', {
  desktop: true,
  platform: process.platform,
  /** okno główne → main: która rozmowa jest otwarta (widget idzie za nią) */
  setSession: id => ipcRenderer.send('app:set-session', id || null),
  /** pokaż / schowaj widget (okno główne zostaje) */
  toggleWidget: () => ipcRenderer.send('app:toggle-widget'),
  /** okno główne na tej rozmowie i tym zadaniu (handoff z widgetu) */
  openMain: (sessionId, taskId) => ipcRenderer.send('app:open-main', { sessionId: sessionId || null, taskId: taskId || null }),
  stopAll: () => ipcRenderer.send('app:stop-all'),
  /** klucze API w pęku kluczy macOS — UI dostaje tylko stan (ustawiony, końcówka), nigdy wartość */
  secrets: {
    status: () => ipcRenderer.invoke('secrets:status'),
    test: (name, value) => ipcRenderer.invoke('secrets:test', { name, value }),
    /** zapis (pusta wartość = usuń) + restart chatu, żeby wziął nowe klucze */
    set: (values, restart = true) => ipcRenderer.invoke('secrets:set', { values, restart }),
  },
  /** zgody macOS dla sterowania komputerem: { screen, accessibility } + otwarcie właściwego panelu */
  perms: {
    status: () => ipcRenderer.invoke('perms:status'),
    request: kind => ipcRenderer.invoke('perms:request', kind),
  },
  /** motyw UI → macOS (vibrancy i światła okna w tym samym trybie co aplikacja) */
  setTheme: t => ipcRenderer.send('app:theme', t),
  // ── widget ──
  /** rozmiar treści (px CSS); okno rośnie od strony, przy której stoi */
  resize: (width, height) => ipcRenderer.send('widget:resize', { width, height }),
  focus: () => ipcRenderer.send('widget:focus'),
  release: () => ipcRenderer.send('widget:release'),
  hide: () => ipcRenderer.send('widget:hide'),
  menu: () => ipcRenderer.send('widget:menu'),
  dragStart: () => ipcRenderer.send('widget:drag-start'),
  drag: (dx, dy) => ipcRenderer.send('widget:drag', { dx, dy }),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  on(channel, cb) {
    if (!CHANNELS.has(channel)) return () => {};
    const h = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
