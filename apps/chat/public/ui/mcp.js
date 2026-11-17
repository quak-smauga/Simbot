// MCP — strona „Serwery MCP”: lista z żywym stanem, co każdy serwer wystawia (narzędzia, zasoby, prompty),
// które simy mają dostęp, edytor (polecenie stdio albo adres URL). Łączy się agent; UI tylko zapisuje i pokazuje stan.
import { $, api, confirmBox, esc, modal, toast } from './dom.js';
import { icon } from './icons.js';

const STATE_PL = { connected: 'połączony', connecting: 'łączę…', error: 'błąd', disabled: 'wyłączony', idle: 'rozłączony', sleeping: 'połączy się przy pierwszym użyciu' };
const MASK = '••••••';
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;

/** "node kwak-mcp.mjs --flag 'dwa słowa'" → ["node", "kwak-mcp.mjs", "--flag", "dwa słowa"] */
function splitCommand(line) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of line.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
const joinCommand = c => [c.command, ...(c.args || [])].filter(Boolean).map(a => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
/** "KLUCZ=wartość" albo "Nagłówek: wartość" w liniach → obiekt. */
function parsePairs(text, sep) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep); if (i < 1) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}
const pairsText = (m, sep) => Object.entries(m || {}).map(([k, v]) => `${k}${sep}${sep === ':' ? ' ' : ''}${v}`).join('\n');

/** Edytor serwera (nowy albo istniejący). `preset` wypełnia pola nowego. Zwraca zapisany serwer. */
export function mcpEditor(app, server, preset) {
  const c = server ? server.config : (preset?.config || {});
  const isNew = !server;
  const sims = app.allBots();
  const access = new Set(server ? server.sims : sims.filter(b => b.name === 'sima').map(b => b.name));
  return modal((box, close) => {
    box.innerHTML = `<h3>${isNew ? 'Nowy serwer MCP' : `Serwer MCP: ${esc(server.name)}`}</h3>
      <p>Serwer MCP daje simom dodatkowe narzędzia. Lokalny serwer to <b>polecenie uruchamiane na Twoim komputerze</b> — dodawaj tylko takie, którym ufasz.</p>
      <div class="form">
        <div class="row"><label class="field"><span>nazwa (w tagach: mcp.NAZWA.narzędzie)</span><input id="mcName" value="${esc(server?.name || preset?.name || '')}" placeholder="np. kwak" ${isNew ? '' : 'disabled'} autocapitalize="off" spellcheck="false" /></label>
          <label class="field"><span>połączenie</span><select id="mcKind"><option value="stdio">polecenie (lokalny proces)</option><option value="http"${c.url ? ' selected' : ''}>adres URL (HTTP)</option></select></label></div>
        <div data-kind="stdio"><label class="field"><span>polecenie</span><input id="mcCmd" class="mono" value="${esc(joinCommand(c))}" placeholder="node kwak-mcp.mjs" spellcheck="false" autocapitalize="off" /></label>
          <label class="field" style="margin-top:14px"><span>zmienne środowiskowe (KLUCZ=wartość, po jednej w linii; opcjonalnie)</span><textarea id="mcEnv" class="mono" style="min-height:64px" placeholder="API_KEY=…" spellcheck="false">${esc(pairsText(c.env, '='))}</textarea></label></div>
        <div data-kind="http"><label class="field"><span>adres endpointu MCP</span><input id="mcUrl" class="mono" value="${esc(c.url || '')}" placeholder="http://localhost:3333/mcp" spellcheck="false" autocapitalize="off" /></label>
          <label class="field" style="margin-top:14px"><span>nagłówki (Nazwa: wartość, po jednym w linii; opcjonalnie)</span><textarea id="mcHdr" class="mono" style="min-height:64px" placeholder="Authorization: Bearer …" spellcheck="false">${esc(pairsText(c.headers, ':'))}</textarea></label></div>
        <div class="row"><label class="field"><span>pytaj mnie przed wywołaniem narzędzia</span><select id="mcConfirm"><option value="destructive">gdy narzędzie zmienia lub usuwa dane</option><option value="always"${c.confirm === 'always' ? ' selected' : ''}>zawsze</option><option value="never"${c.confirm === 'never' ? ' selected' : ''}>nigdy</option></select></label>
          <label class="field"><span>stan</span><select id="mcOn"><option value="1">włączony</option><option value="0"${c.enabled === false ? ' selected' : ''}>wyłączony</option></select></label></div>
        <div class="field"><span>simy z dostępem</span><div class="mcp-sims">${sims.map(b => `<label><input type="checkbox" value="${esc(b.name)}" ${access.has(b.name) ? 'checked' : ''}/> @${esc(b.name)}</label>`).join('')}</div></div>
      </div>
      <div class="modal__foot"><span class="muted" id="mcErr"></span>${isNew ? '' : '<button class="btn btn--danger" data-del>Usuń</button>'}<button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>Zapisz i połącz</button></div>`;
    const kind = box.querySelector('#mcKind');
    const sync = () => box.querySelectorAll('[data-kind]').forEach(el => (el.hidden = el.dataset.kind !== kind.value));
    kind.onchange = sync; sync();
    const err = t => (box.querySelector('#mcErr').textContent = t);
    box.querySelector('[data-c]').onclick = () => close(undefined);
    const ok = box.querySelector('[data-ok]');
    ok.onclick = async () => {
      const name = box.querySelector('#mcName').value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) return err('nazwa: małe litery, cyfry, - i _');
      const config = { confirm: box.querySelector('#mcConfirm').value, enabled: box.querySelector('#mcOn').value === '1' };
      if (kind.value === 'stdio') {
        const [command, ...args] = splitCommand(box.querySelector('#mcCmd').value);
        if (!command) return err('podaj polecenie');
        Object.assign(config, { command, args, env: parsePairs(box.querySelector('#mcEnv').value, '=') });
      } else {
        if (!box.querySelector('#mcUrl').value.trim()) return err('podaj adres URL');
        Object.assign(config, { url: box.querySelector('#mcUrl').value.trim(), headers: parsePairs(box.querySelector('#mcHdr').value, ':') });
      }
      ok.disabled = true; err('zapisuję i łączę…');
      try {
        const r = await api.put(`/api/mcp/${encodeURIComponent(name)}`, { config, sims: [...box.querySelectorAll('.mcp-sims input:checked')].map(i => i.value) });
        await app.loadBots();
        close(r.server);
      } catch (e) { err(e.message); ok.disabled = false; }
    };
    const del = box.querySelector('[data-del]');
    if (del) del.onclick = async () => {
      if (!(await confirmBox(`Usunąć serwer „${server.name}”?`, 'Zniknie z ustawień i z simów, które miały do niego dostęp.'))) return;
      await api.del(`/api/mcp/${encodeURIComponent(server.name)}`); await app.loadBots(); close(null);
    };
  }, { wide: true });
}

function serverHtml(s) {
  const where = s.transport === 'http' ? s.config.url : joinCommand(s.config);
  const counts = s.tools.length || s.resources.length || s.prompts.length
    ? [plural(s.tools.length, 'narzędzie', 'narzędzia', 'narzędzi'), s.resources.length ? plural(s.resources.length, 'zasób', 'zasoby', 'zasobów') : '', s.prompts.length ? plural(s.prompts.length, 'prompt', 'prompty', 'promptów') : ''].filter(Boolean).join(' · ')
    : 'jeszcze nie połączony';
  const title = s.serverInfo && (s.serverInfo.title || s.serverInfo.name);
  return `<div class="mcp" data-name="${esc(s.name)}" data-state="${esc(s.state)}">
    <div class="mcp__row"><i class="mcp__dot"></i><span style="min-width:0;flex:1"><b>${esc(s.name)}</b>${title && title !== s.name ? ` <span class="mcp__title">${esc(title)}${s.serverInfo.version ? ` ${esc(s.serverInfo.version)}` : ''}</span>` : ''}<small>${esc(s.transport === 'http' ? 'HTTP' : 'lokalny proces')} · ${esc(where)}</small></span>
      <span class="mcp__meta"><span class="mcp__state">${esc(STATE_PL[s.state] || s.state)}</span><small>${esc(counts)}</small></span><span class="trow__chev">${icon('chevron-right', 16)}</span></div>
    <div class="mcp__body">
      ${s.error ? `<div class="result bad">${esc(s.error)}</div>` : ''}
      ${s.instructions ? `<div class="muted">Opis od serwera: ${esc(s.instructions)}</div>` : ''}
      ${s.tools.length ? `<div class="mcp__h">Narzędzia</div><ul class="mcp__list">${s.tools.map(t => `<li><code>${esc(t.name)}</code>${t.destructive ? '<span class="mcp__tag">zmienia dane</span>' : ''}<span>${esc(t.description || t.title)}</span>${t.params.length ? `<small>${t.params.map(p => esc(p) + (t.required.includes(p) ? '*' : '')).join(', ')}</small>` : ''}</li>`).join('')}</ul>` : ''}
      ${s.resources.length ? `<div class="mcp__h">Zasoby</div><ul class="mcp__list">${s.resources.map(r => `<li><code>${esc(r.uri)}</code><span>${esc(r.description)}</span></li>`).join('')}</ul>` : ''}
      ${s.prompts.length ? `<div class="mcp__h">Prompty</div><ul class="mcp__list">${s.prompts.map(p => `<li><code>${esc(p.name)}</code><span>${esc(p.description)}</span></li>`).join('')}</ul>` : ''}
      <div class="mcp__h">Dostęp</div><div class="muted">${s.sims.length ? s.sims.map(n => '@' + esc(n)).join(', ') : 'żaden sim — włącz w edycji serwera albo na stronie sima'}</div>
      <div class="skill__foot"><button class="btn btn--sm btn--primary" data-edit>Edytuj</button>${s.state !== 'disabled' ? '<button class="btn btn--sm" data-re>Połącz ponownie</button>' : ''}</div>
    </div></div>`;
}

let open = new Set();
export async function renderMcpPage(app) {
  const page = $('page');
  let data;
  try { data = await api.get('/api/mcp'); } catch (e) { page.innerHTML = `<div class="pg"><div class="result bad">${esc(e.message)}</div></div>`; return; }
  if (app.page !== 'mcp') return; // user zdążył wyjść
  const servers = data.servers;
  page.innerHTML = `<div class="pg"><div class="pg__head"><div style="flex:1"><div class="pg__name">Serwery MCP</div><div class="muted" style="margin-top:4px">Zewnętrzne narzędzia dla simów w standardzie Model Context Protocol. Serwer dodajesz raz, a potem wybierasz, które simy mogą z niego korzystać.</div><div class="pg__actions"><button class="btn btn--primary" id="mcNew">+ Dodaj serwer</button>${servers.some(s => s.name === 'kwak') ? '' : '<button class="btn" id="mcKwak">🦆 Dodaj testową kaczkę</button>'}</div></div></div>
    <section>${servers.length ? servers.map(serverHtml).join('') : '<div class="muted">Jeszcze żadnego. Na próbę możesz dodać testową kaczkę (<code class="kbd">node kwak-mcp.mjs</code>), a potem poprosić Simę: „nakarm kaczki 25 okruszkami i powiedz, kto jest na stawie”.</div>'}
      ${servers.length && data.agent !== 'up' ? '<div class="muted" style="margin-top:10px">Agent śpi — serwery połączą się przy pierwszym użyciu albo po kliknięciu „Połącz ponownie”.</div>' : ''}</section></div>`;
  const re = () => renderMcpPage(app);
  const after = s => { if (s === undefined) return; if (s) { open.add(s.name); toast(s.state === 'connected' ? `${s.name}: połączony, ${plural(s.tools.length, 'narzędzie', 'narzędzia', 'narzędzi')}` : `${s.name}: ${s.error || STATE_PL[s.state] || s.state}`); } re(); };
  $('mcNew').onclick = async () => after(await mcpEditor(app));
  const kwak = $('mcKwak'); if (kwak) kwak.onclick = async () => after(await mcpEditor(app, null, { name: 'kwak', config: { command: 'node', args: ['kwak-mcp.mjs'] } }));
  page.querySelectorAll('.mcp').forEach(el => {
    const s = servers.find(x => x.name === el.dataset.name);
    if (open.has(s.name)) el.classList.add('open');
    el.querySelector('.mcp__row').onclick = () => { el.classList.toggle('open') ? open.add(s.name) : open.delete(s.name); };
    el.querySelector('[data-edit]').onclick = async () => after(await mcpEditor(app, s));
    const rc = el.querySelector('[data-re]');
    if (rc) rc.onclick = async () => { rc.disabled = true; rc.textContent = 'łączę…'; try { after((await api.post(`/api/mcp/${encodeURIComponent(s.name)}/reconnect`)).server || null); } catch (e) { toast(e.message); re(); } };
  });
}

/** Sekcja na stronie sima: przełączniki dostępu do serwerów. */
export async function renderSimMcp(el, bot, patch) {
  let servers = [];
  try { servers = (await api.get('/api/mcp')).servers; } catch { /* brak dostępu / stary serwer */ }
  if (!el.isConnected) return;
  el.innerHTML = servers.length
    ? `<div class="caps">${servers.map(s => { const on = bot.mcp.includes(s.name); return `<div class="cap ${on ? 'on' : 'off'}" data-mcp="${esc(s.name)}"><div class="cap__sw"></div><div><b>${esc(s.name)}</b><small>${esc((s.serverInfo && (s.serverInfo.title || s.serverInfo.name)) || (s.transport === 'http' ? s.config.url : joinCommand(s.config)))}${s.state === 'disabled' ? ' · wyłączony' : ''}</small>${s.tools.length ? `<div class="tools">${s.tools.slice(0, 8).map(t => esc(t.name)).join(' · ')}${s.tools.length > 8 ? ' …' : ''}</div>` : ''}</div></div>`; }).join('')}</div>`
    : '<div class="muted">Brak serwerów. Dodasz je w menu przy swoim imieniu → Serwery MCP.</div>';
  el.querySelectorAll('[data-mcp]').forEach(x => x.onclick = () => { const set = new Set(bot.mcp); set.has(x.dataset.mcp) ? set.delete(x.dataset.mcp) : set.add(x.dataset.mcp); patch({ mcp: [...set] }); });
}
