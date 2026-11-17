// BUILDER — konstruktor awatara (sim i user tak samo): podgląd ze stanami, presety, kolor, kształt/oczy/usta/wzór/idle, akcesoria, losuj.
// avatarBuilder(cfg) → Promise<cfg|undefined>. cfg = { color, shape, eyes, mouth, acc:[], pattern, idle }
import { esc, modal } from './dom.js';
import { COLOR_HEX, OPTIONS, PRESETS, STATES, STATE_PL, makeAvatar, randomConfig } from './avatar.js';
import { icon } from './icons.js';

const LABEL = { shape: 'kształt', eyes: 'oczy', mouth: 'usta', pattern: 'wzór', idle: 'temperament' };

export function cfgOf(look) { return { color: look?.color || '#3A7BD5', shape: 'circle', eyes: 'round', mouth: 'smile', acc: [], pattern: 'none', idle: 'bob', ...(look?.avatar || {}) }; }

/** Wbudowany w inny formularz: renderBuilder(host, cfg, onChange, { compact }) — bez modala.
 *  compact = presety + kolor na wierzchu, reszta (kształt/oczy/usta/wzór/temperament, akcesoria, stany) pod „Dopasuj”. */
export function renderBuilder(host, cfg, onChange, { compact = false } = {}) {
  let state = 'idle', open = !compact;
  host.className = 'builder';
  let presetsX = 0;
  const draw = () => {
    const prevRow = host.querySelector('#bPresets'); if (prevRow) presetsX = prevRow.scrollLeft;
    host.innerHTML = `<div class="builder__prev"><div id="bPrev"></div>${open ? '<div class="states" id="bStates"></div>' : ''}</div>
      <div class="builder__ctl">
        <div><div class="hintl" style="margin-bottom:6px">presety — kliknij, potem dopasuj</div><div class="presets-wrap"><button class="presets__arr presets__arr--l" id="bPrevArr" type="button" title="W lewo" hidden>${icon('chevron-left', 18)}</button><div class="presets" id="bPresets"></div><button class="presets__arr presets__arr--r" id="bNextArr" type="button" title="W prawo" hidden>${icon('chevron-right', 18)}</button></div></div>
        <div><div class="hintl" style="margin-bottom:6px">kolor</div><div class="swatches" id="bColors"></div></div>
        ${compact ? `<button class="builder__more${open ? ' open' : ''}" id="bMore" type="button">${icon('chevron-right')}${open ? 'Mniej' : 'Dopasuj szczegóły'}</button>` : ''}
        <div class="builder__adv" id="bAdv" ${open ? '' : 'hidden'}>
          <div class="selgrid" id="bSel"></div>
          <div><div class="hintl" style="margin-bottom:6px">akcesoria</div><div class="accs" id="bAcc"></div></div>
          <div class="btns"><button class="btn btn--sm" id="bRnd" type="button">${icon('dices', 15)}losuj</button></div>
        </div>
      </div>`;
    const q = s => host.querySelector(s);
    q('#bPrev').append(makeAvatar({ ...cfg, id: 'builder', state }, compact ? 96 : 128));
    if (q('#bStates')) STATES.forEach(s => { const b = document.createElement('button'); b.className = 'pill' + (s === state ? ' on' : ''); b.type = 'button'; b.textContent = STATE_PL[s]; b.onclick = () => { state = s; draw(); }; q('#bStates').append(b); });
    if (q('#bMore')) q('#bMore').onclick = () => { open = !open; draw(); };
    PRESETS.forEach(p => { const b = document.createElement('button'); b.type = 'button'; b.className = 'preset' + (sameShape(p, cfg) ? ' on' : ''); b.title = p.name; b.append(makeAvatar({ ...p, id: '' }, 40)); b.onclick = () => { Object.assign(cfg, { shape: p.shape, eyes: p.eyes, mouth: p.mouth, acc: [...p.acc], pattern: p.pattern, idle: p.idle, color: p.color }); onChange(cfg); draw(); }; q('#bPresets').append(b); });
    bindPresetArrows(q('#bPresets'), q('#bPrevArr'), q('#bNextArr'), presetsX);
    Object.entries(COLOR_HEX).forEach(([n, hex]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sw' + (cfg.color.toLowerCase() === hex.toLowerCase() ? ' on' : ''); b.style.background = hex; b.title = n; b.onclick = () => { cfg.color = hex; onChange(cfg); draw(); }; q('#bColors').append(b); });
    for (const key of ['shape', 'eyes', 'mouth', 'pattern', 'idle']) {
      const l = document.createElement('label'); l.className = 'field'; l.innerHTML = `<span>${LABEL[key]}</span><select>${OPTIONS[key].map(o => `<option value="${o}"${cfg[key] === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
      l.querySelector('select').onchange = e => { cfg[key] = e.target.value; onChange(cfg); draw(); };
      q('#bSel').append(l);
    }
    OPTIONS.acc.forEach(k => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill' + (cfg.acc.includes(k) ? ' on' : ''); b.textContent = k; b.onclick = () => { cfg.acc = cfg.acc.includes(k) ? cfg.acc.filter(x => x !== k) : [...cfg.acc, k]; onChange(cfg); draw(); }; q('#bAcc').append(b); });
    q('#bRnd').onclick = () => { Object.assign(cfg, randomConfig()); onChange(cfg); draw(); };
  };
  draw();
  return cfg;
}
/** Strzałki po bokach rzędu presetów: prawa widoczna od startu, lewa dopiero po przewinięciu; klik = płynny scroll o ~ szerokość rzędu. */
function bindPresetArrows(row, left, right, startX = 0) {
  const sync = () => {
    const max = row.scrollWidth - row.clientWidth;
    left.hidden = row.scrollLeft <= 2;
    right.hidden = max <= 2 || row.scrollLeft >= max - 2;
  };
  const step = dir => row.scrollBy({ left: dir * Math.max(120, row.clientWidth * 0.75), behavior: 'smooth' });
  left.onclick = () => step(-1);
  right.onclick = () => step(1);
  row.addEventListener('scroll', sync, { passive: true });
  row.scrollLeft = startX;
  sync();
  requestAnimationFrame(sync); // po layoucie modala (szerokość znana dopiero po wstawieniu)
  new ResizeObserver(sync).observe(row);
}
const sameShape = (p, c) => p.shape === c.shape && p.eyes === c.eyes && p.mouth === c.mouth && p.pattern === c.pattern && JSON.stringify(p.acc) === JSON.stringify(c.acc);

export function avatarBuilder(initial, { title = 'Wygląd' } = {}) {
  const cfg = { ...initial, acc: [...(initial.acc || [])] };
  return modal((box, close) => {
    box.innerHTML = `<h3>${esc(title)}</h3><p>Ten sam awatar żyje w rozmowie — mruga, myśli, pracuje.</p><div id="bHost"></div><div class="modal__foot"><button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>Zapisz</button></div>`;
    renderBuilder(box.querySelector('#bHost'), cfg, () => {});
    box.querySelector('[data-c]').onclick = () => close(undefined);
    box.querySelector('[data-ok]').onclick = () => close(cfg);
  }, { wide: true });
}
