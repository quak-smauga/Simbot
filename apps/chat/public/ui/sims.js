// SIMS — dodawanie sima (nazwa, rola, wygląd, persona) i strona sima (setup: kim jest, co umie, jak pracuje, co pamięta).
import { $, api, confirmBox, esc, modal, promptBox, toast } from './dom.js';
import { PRESETS, makeAvatar, randomConfig } from './avatar.js';
import { avatarBuilder, cfgOf, renderBuilder } from './builder.js';
import { icon } from './icons.js';
import { renderSimMcp } from './mcp.js';

const CAP_DESC = { web: 'szukanie w internecie', computer: 'przeglądarka: klika, czyta, wraca z raportem', skills: 'zapisuje własne workflowy w trakcie rozmowy' };
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Przykładowe simy — gotowa rola, persona i pasujący preset wyglądu. Klik w „Dodaj sima” tworzy je od ręki. */
const P = n => { const { name, ...look } = PRESETS.find(p => p.name === n); return look; };
export const EXAMPLES = [
  { name: 'ksiegowy', look: P('Księgowy'), description: 'faktury, koszty i terminy w firmie',
    persona: '# ksiegowy\n\nJesteś księgowym: pilnujesz faktur, kosztów, VAT i terminów płatności. Mówisz konkretnie, liczysz dokładnie, przed wystawieniem czegokolwiek pokazujesz podsumowanie (kontrahent, kwoty netto/brutto, VAT, termin) i pytasz o potwierdzenie. Nie zgadujesz danych — dopytujesz.' },
  { name: 'badacz', look: P('Badacz'), description: 'przekopuje sieć i podaje konkrety ze źródłami',
    persona: '# badacz\n\nJesteś researcherem. Szukasz w kilku źródłach, porównujesz je i podajesz zwięzłe wnioski z linkami. Odróżniasz fakty od opinii, mówisz wprost, gdy źródła się nie zgadzają albo czegoś nie da się ustalić.' },
  { name: 'pisarz', look: P('Pisarz'), description: 'maile, posty i teksty w Twoim stylu',
    persona: '# pisarz\n\nJesteś copywriterem. Piszesz maile, posty i krótkie teksty: jasno, naturalnie, bez korpomowy. Dopasowujesz ton do odbiorcy, dajesz 1–2 warianty i pytasz, który kierunek bardziej pasuje. Zapamiętujesz styl usera.' },
  { name: 'zakupy', look: P('Kotek'), description: 'porównuje ceny i wyłapuje najlepsze oferty',
    persona: '# zakupy\n\nJesteś łowcą okazji. Porównujesz ceny, warianty, opinie i koszty dostawy w kilku sklepach i podajesz krótką tabelkę z rekomendacją. Nigdy nie kupujesz ani nie płacisz sam — finalny zakup zawsze robi user.' },
  { name: 'podroznik', look: P('Chmurka'), description: 'loty, noclegi i plan wyjazdu w budżecie',
    persona: '# podroznik\n\nPlanujesz podróże: loty, noclegi, dojazdy i plan dnia. Najpierw pytasz o daty, budżet i styl wyjazdu, potem dajesz 2–3 opcje z cenami i linkami. Pilnujesz realnych czasów przesiadek i godzin otwarcia.' },
  { name: 'kucharz', look: P('Roślinka'), description: 'przepisy z tego, co masz, i plan posiłków',
    persona: '# kucharz\n\nJesteś domowym kucharzem. Proponujesz przepisy z tego, co user ma pod ręką, układasz plan posiłków i listę zakupów. Podajesz czasy i proporcje, pamiętasz o alergiach i tym, czego user nie lubi.' },
  { name: 'trener', look: P('DJ'), description: 'plan treningów i pilnowanie nawyków',
    persona: '# trener\n\nJesteś trenerem: układasz realistyczne plany treningowe pod cel, czas i sprzęt usera, pilnujesz progresji i nawyków. Motywujesz krótko i życzliwie. Przy bólu czy kontuzji odsyłasz do specjalisty.' },
  { name: 'audytor', look: P('Profesor'), description: 'sprawdza robotę innych simów, zanim coś pójdzie dalej',
    persona: '# audytor\n\nJesteś audytorem w zespole simów. Sprawdzasz wyniki innych simów (dane, kwoty, odbiorców, literówki, zgodność z prośbą usera), zanim coś zostanie wysłane czy zatwierdzone. Wypisujesz konkretne uwagi albo krótkie „OK, można”. Przy wątpliwościach wołasz usera.' },
  { name: 'tlumacz', look: P('Trójoki'), description: 'tłumaczy i szlifuje teksty w kilku językach',
    persona: '# tlumacz\n\nJesteś tłumaczem: tłumaczysz naturalnie, z zachowaniem tonu i kontekstu, a nie słowo w słowo. Przy niejednoznacznościach podajesz warianty. Umiesz też poprawić gramatykę i styl tekstu w obcym języku.' },
];
/** Przykład → body do POST /api/bots. */
export const exampleBody = ex => { const { color, ...avatar } = ex.look; return { name: ex.name, description: ex.description, persona: ex.persona, look: { color, avatar } }; };
/** Przykłady, których user jeszcze nie ma. */
export const freeExamples = app => EXAMPLES.filter(ex => !app.allBots().some(b => b.name === ex.name));

/** Nowy sim. first = pierwszy w ogóle (inny nagłówek). Zawsze da się zamknąć (Anuluj / Esc / tło). Zwraca widok bota albo undefined. */
export function newSimDialog(app, { first = false } = {}) {
  const cfg = randomConfig(); // każdy nowy sim startuje z losowym wyglądem
  const examples = freeExamples(app);
  return modal((box, close) => {
    box.innerHTML = `<h3>${first ? 'Twój pierwszy sim' : 'Nowy sim'}</h3><p>${first ? 'Sim to agent z własną rolą, narzędziami i pamięcią. Rozmowy prowadzisz z simami — jednym albo kilkoma naraz.' : 'Nazwa to też jego @ w rozmowie.'}</p>
      ${examples.length ? `<div class="hintl" style="margin-bottom:6px">przykłady — kliknij, żeby wypełnić</div><div class="examples">${examples.map(ex => `<button class="pill" type="button" data-ex="${esc(ex.name)}" title="${esc(ex.description)}"><span class="a"></span>@${esc(ex.name)}</button>`).join('')}</div>` : ''}
      <div class="form">
        <div class="row"><label class="field"><span>nazwa (@)</span><input id="nsName" placeholder="np. ksiegowy" autocomplete="off" /></label><label class="field"><span>rola — jednym zdaniem</span><input id="nsDesc" placeholder="np. wystawia faktury w inFakcie" /></label></div>
        <div id="nsBuilder"></div>
        <label class="field"><span>persona (opcjonalnie)</span><textarea id="nsPersona" placeholder="Kim jest, jak mówi, czego nie robi. Puste = spokojny, konkretny, po polsku."></textarea></label>
      </div>
      <div class="modal__foot"><span class="muted" id="nsErr"></span><button class="btn" data-c>Anuluj</button><button class="btn btn--primary" data-ok>Dodaj sima</button></div>`;
    renderBuilder(box.querySelector('#nsBuilder'), cfg, () => {}, { compact: true });
    const name = box.querySelector('#nsName');
    box.querySelectorAll('[data-ex]').forEach(el => {
      const ex = EXAMPLES.find(x => x.name === el.dataset.ex);
      el.querySelector('.a').append(makeAvatar({ ...ex.look, id: '' }, 22));
      el.onclick = () => {
        name.value = ex.name; box.querySelector('#nsDesc').value = ex.description; box.querySelector('#nsPersona').value = ex.persona;
        Object.assign(cfg, { ...ex.look, acc: [...ex.look.acc] });
        renderBuilder(box.querySelector('#nsBuilder'), cfg, () => {}, { compact: true });
        box.querySelectorAll('[data-ex]').forEach(x => x.classList.toggle('on', x === el));
      };
    });
    name.oninput = () => { const v = slug(name.value); if (v !== name.value) name.value = v; };
    box.querySelector('[data-c]').onclick = () => close(undefined);
    box.querySelector('[data-ok]').onclick = async () => {
      const n = slug(name.value);
      if (!n) { box.querySelector('#nsErr').textContent = 'podaj nazwę (małe litery, myślniki)'; name.focus(); return; }
      try {
        const { color, ...avatar } = cfg;
        const b = await api.post('/api/bots', { name: n, description: box.querySelector('#nsDesc').value.trim(), persona: box.querySelector('#nsPersona').value.trim() || undefined, look: { color, avatar } });
        close(b);
      } catch (e) { box.querySelector('#nsErr').textContent = e.message; }
    };
  }, { wide: true });
}

/** Strona sima — CRUD/setup. */
export function renderSimPage(app, name) {
  const b = app.bots.find(x => x.name === name); if (!b) return;
  const page = $('page');
  const patch = async body => { try { await api.patch(`/api/bots/${b.name}`, body); } catch (e) { toast(e.message); } await app.loadBots(); };
  const re = () => renderSimPage(app, name);
  page.innerHTML = `<div class="pg">
    <div class="pg__head"><div class="pg__av" id="spAv"></div><div style="flex:1;min-width:220px">
      <div class="pg__name">${esc(b.name)}<small>@${esc(b.name)}</small></div>
      <input class="pg__desc" id="spDesc" value="${esc(b.description)}" placeholder="Jednym zdaniem: do czego jest ten sim" />
      <div class="pg__actions"><button class="btn btn--primary" id="spNew">Nowa rozmowa z ${esc(b.name)}</button>${app.current ? `<button class="btn" id="spUse">Dodaj do bieżącej rozmowy</button>` : ''}<button class="btn" id="spLook">${icon('paintbrush', 16)}Wygląd</button></div>
    </div></div>

    <section><h3>Kim jest</h3>
      <label class="field"><textarea id="spPersona" placeholder="Persona: kim jest, jak mówi, czego nie robi…">${esc(b.persona)}</textarea><span class="hintl">zapis przy wyjściu z pola</span></label>
      <div class="row" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"><label class="field" style="flex:1;min-width:200px"><span>głos (ElevenLabs voiceId, puste = domyślny)</span><input id="spVoice" value="${esc(b.look.voice || '')}" /></label></div></section>

    <section><h3>Co umie</h3><div class="caps">${(app.builtinAvailable || []).map(n => { const c = b.capabilities.find(x => x.name === n); const on = b.builtin.includes(n); return `<div class="cap ${on ? 'on' : 'off'}" data-cap="${n}"><div class="cap__sw"></div><div><b>${esc(n)}</b><small>${esc(c ? c.description : CAP_DESC[n] || '')}</small>${c ? `<div class="tools">${c.tools.map(esc).join(' · ')}</div>` : ''}</div></div>`; }).join('')}
      ${b.capabilities.filter(c => c.kind !== 'builtin').map(c => `<div class="cap on" style="cursor:default"><div class="cap__sw" style="opacity:.35"></div><div><b>${esc(c.name)}</b><small>${esc(c.description)} · lokalny plugin</small><div class="tools">${c.tools.map(esc).join(' · ')}</div></div></div>`).join('')}</div></section>

    <section><h3>Serwery MCP</h3><div id="spMcp"><div class="muted">…</div></div></section>

    <section><h3>Jak pracuje <span class="sp"></span><button class="btn btn--sm" id="spSkillAdd">${icon('plus', 14)}skill</button></h3>
      <div id="spSkills">${b.skills.length ? b.skills.map(sk => `<div class="skill" data-skill="${esc(sk.name)}"><div class="skill__row"><b>${esc(sk.name)}</b><small>${esc(sk.description || sk.body.split('\n')[0])}</small><span class="trow__chev">${icon('chevron-right', 16)}</span></div>
        <div class="skill__body"><label class="field"><textarea class="mono">${esc(sk.body)}</textarea></label><div class="skill__foot"><button class="btn btn--primary btn--sm" data-save>Zapisz</button><button class="btn btn--sm btn--danger" data-del>Usuń</button></div></div></div>`).join('') : '<div class="muted">Jeszcze nic — sim zapisze skill sam po udanym zadaniu albo gdy powiesz „zapamiętaj, jak to robić”.</div>'}</div></section>

    <section><h3>Notatki z pracy <span class="sp"></span><label class="muted" style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-weight:400"><input type="checkbox" id="spMemOn" ${b.memoryEnabled ? 'checked' : ''}/> zbieraj po każdej turze</label></h3>
      ${b.memory.length ? `<ul class="memlist">${b.memory.map((m, i) => { const mm = /^(\d{4}-\d{2}-\d{2}) · (.*)$/.exec(m); return `<li><span>${esc(mm ? mm[2] : m)}</span><small>${mm ? mm[1] : ''}</small><button data-mem="${i}" title="Zapomnij">${icon('x', 14)}</button></li>`; }).join('')}</ul>` : '<div class="muted">Pusto. Po każdej turze sim wyciąga to, co przyda mu się w jego roli, i tu to zobaczysz.</div>'}<div class="muted" style="margin-top:8px">Fakty o Tobie (imię, firma, preferencje) trafiają do wspólnej pamięci — zobaczysz je w profilu (menu przy Twoim imieniu).</div></section>

    <section><h3>Pod maską</h3><div class="muted">${esc(b.dir)} · model: ${esc(b.model.chat || app.config.llm)} · <a href="${esc(app.config.agent.url)}/dashboard/" target="_blank" rel="noopener">dashboard agenta</a> · <button class="danger" id="spDel">usuń sima</button></div></section>
  </div>`;
  $('spAv').append(makeAvatar({ ...cfgOf(b.look), id: b.name, state: 'idle' }, 84));
  $('spNew').onclick = () => app.newSession([b.name]);
  const use = $('spUse'); if (use) use.onclick = async () => { await api.patch(`/api/sessions/${app.current}`, { bots: [...(app.members || []), b.name] }); app.openSession(app.current); };
  $('spLook').onclick = async () => { const cfg = await avatarBuilder(cfgOf(b.look), { title: `Wygląd — ${b.name}` }); if (!cfg) return; const { color, ...avatar } = cfg; await patch({ look: { color, avatar } }); re(); };
  $('spDesc').onchange = () => patch({ description: $('spDesc').value });
  $('spPersona').onblur = () => { if ($('spPersona').value !== b.persona) patch({ persona: $('spPersona').value }); };
  $('spVoice').onchange = () => patch({ look: { voice: $('spVoice').value } });
  page.querySelectorAll('.cap[data-cap]').forEach(x => x.onclick = () => { const set = new Set(b.builtin); set.has(x.dataset.cap) ? set.delete(x.dataset.cap) : set.add(x.dataset.cap); patch({ builtin: [...set] }).then(re); });
  renderSimMcp($('spMcp'), b, body => patch(body).then(re));
  $('spMemOn').onchange = () => patch({ memoryEnabled: $('spMemOn').checked });
  page.querySelectorAll('.skill').forEach(el => {
    el.querySelector('.skill__row').onclick = () => el.classList.toggle('open');
    el.querySelector('[data-save]').onclick = async () => { await api.post(`/api/bots/${b.name}/skills`, { name: el.dataset.skill, body: el.querySelector('textarea').value }); toast('zapisano'); await app.loadBots(); re(); };
    el.querySelector('[data-del]').onclick = async () => { if (!(await confirmBox('Usunąć skill?', `„${el.dataset.skill}” zniknie z promptu sima.`))) return; await api.del(`/api/bots/${b.name}/skills/${el.dataset.skill}`); await app.loadBots(); re(); };
  });
  $('spSkillAdd').onclick = async () => { const n = await promptBox('Nowy skill', { placeholder: 'nazwa (małe litery, myślniki)', ok: 'Dodaj' }); if (!n) return; const nn = slug(n); await api.post(`/api/bots/${b.name}/skills`, { name: nn, body: `# ${nn}\n\n1. …` }); await app.loadBots(); re(); page.querySelector(`.skill[data-skill="${nn}"]`)?.classList.add('open'); };
  page.querySelectorAll('[data-mem]').forEach(x => x.onclick = async () => { const lines = b.memory.filter((_, i) => i !== Number(x.dataset.mem)); await api.put(`/api/bots/${b.name}/memory`, { lines }); await app.loadBots(); re(); });
  $('spDel').onclick = async () => { if (!(await confirmBox(`Usunąć sima „${b.name}”?`, 'Razem z folderem: persona, skille, pamięć. Rozmowy zostają.'))) return; await api.del(`/api/bots/${b.name}`); await app.loadBots(); app.afterSimRemoved(); };
}
