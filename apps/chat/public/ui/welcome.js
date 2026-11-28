// WELCOME — pierwsze uruchomienie Simbot.app i „Klucze API”. Tylko w Electronie (window.qwe.secrets): klucze idą do pęku
// kluczy macOS przez preload, a do strony wraca wyłącznie stan („ustawiony · …ab12”). Zapis = restart chatu → strona się
// przeładowuje sama (main.js). W przeglądarce tego okna nie ma — tam klucze są w .env domu.
import { esc, modal } from './dom.js';

const SKIP = 'qwe.welcome.skipKey';
const OPTIONAL = ['ELEVENLABS_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY'];

/** Pokazać powitanie? Aplikacja desktopowa, bez --mock, a simy nie mają żadnego modelu (brak klucza i nie wybrano Ollamy). */
export const needsWelcome = app => !!window.qwe?.secrets && !app.config.mock && app.config.llm === 'mock' && !localStorage.getItem(SKIP);

/** mode: 'welcome' (kroki: klucz → uprawnienia, nie da się zamknąć) | 'keys' (sam formularz kluczy, z menu). */
export async function keysDialog(app, { mode = 'keys' } = {}) {
  const st = await window.qwe.secrets.status();
  if (!st) return;
  const welcome = mode === 'welcome';
  const keys = st.keys;
  const row = name => {
    const k = keys[name];
    const now = k.set ? `ustawiony · …${esc(k.tail)}${k.source === 'env' ? ' (z .env)' : ''}` : '';
    return `<label class="field"><span>${esc(k.label)}${k.required ? '' : ' <i class="muted">opcjonalnie</i>'}</span>
      <input type="password" data-k="${name}" autocomplete="off" spellcheck="false" placeholder="${now ? esc(now) + ' — wpisz, żeby zmienić' : esc(k.prefix ? k.prefix + '…' : 'wklej klucz')}" />
      <small class="muted">${esc(k.hint || '')}${k.source === 'app' ? ` · <button type="button" class="linkbtn" data-rm="${name}">usuń</button>` : ''}</small></label>`;
  };

  return modal((box, close) => {
    const values = {};
    const keyStep = () => {
      box.innerHTML = `<h3>${welcome ? 'Cześć! Tu Simbot.' : 'Klucze API'}</h3>
        <p>${welcome ? 'Żeby simy mogły myśleć, potrzebują modelu. Wklej klucz Anthropic — resztę można dodać później.' : 'Klucze trzyma pęk kluczy macOS (zaszyfrowane), nie plik w repo. Po zapisie Simbot uruchomi się ponownie w tle.'}</p>
        <div class="form">${row('ANTHROPIC_API_KEY')}
          <details class="keys__more"${OPTIONAL.some(n => keys[n].set) ? ' open' : ''}><summary>Głos i wyszukiwarka (opcjonalnie)</summary><div class="form">${OPTIONAL.map(row).join('')}</div></details></div>
        ${welcome ? '<p class="muted keys__alt">Masz modele lokalne w Ollamie? <button type="button" class="linkbtn" data-skip>Pomiń klucz</button> i wybierz model pod polem wiadomości.</p>' : ''}
        <div class="modal__foot"><span class="muted" id="kErr"></span>${welcome ? '' : '<button class="btn" data-c>Anuluj</button>'}<button class="btn btn--primary" data-ok>${welcome ? 'Dalej' : 'Zapisz'}</button></div>`;
      const err = box.querySelector('#kErr');
      const okBtn = box.querySelector('[data-ok]');
      box.querySelector('[data-c]')?.addEventListener('click', () => close(undefined));
      box.querySelector('[data-skip]')?.addEventListener('click', () => { localStorage.setItem(SKIP, '1'); permStep(); });
      box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { values[b.dataset.rm] = ''; b.closest('small').textContent = 'zostanie usunięty po zapisie'; });
      box.querySelectorAll('input[data-k]').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') okBtn.click(); });
      okBtn.onclick = async () => {
        box.querySelectorAll('input[data-k]').forEach(i => { if (i.value.trim()) values[i.dataset.k] = i.value.trim(); });
        if (welcome && !values.ANTHROPIC_API_KEY && !keys.ANTHROPIC_API_KEY.set) { err.textContent = 'wklej klucz Anthropic albo pomiń (Ollama)'; return; }
        // nowy klucz Anthropic sprawdzamy od razu — lepiej usłyszeć „odrzucony” tutaj niż od milczącego sima
        if (values.ANTHROPIC_API_KEY) {
          okBtn.disabled = true; err.textContent = 'sprawdzam klucz…';
          const t = await window.qwe.secrets.test('ANTHROPIC_API_KEY', values.ANTHROPIC_API_KEY);
          okBtn.disabled = false;
          if (!t?.ok) { err.textContent = `Anthropic: ${t?.error || 'nie działa'}`; return; }
          err.textContent = 'klucz działa ✓';
        }
        if (welcome) permStep(); else save();
      };
    };

    // zgody macOS — potrzebne tylko do sterowania całym komputerem; stan odświeżany, bo user nadaje je w Ustawieniach systemowych
    let poll = null;
    const permStep = async () => {
      const draw = p => {
        const r = (kind, label, why) => `<div class="perm"><div><b>${label}</b><small class="muted">${why}</small></div>${p?.[kind] ? '<span class="perm__ok">✓ nadane</span>' : `<button type="button" class="btn btn--sm" data-perm="${kind}">Nadaj…</button>`}</div>`;
        box.innerHTML = `<h3>Sterowanie komputerem</h3>
          <p>Simy mogą klikać i patrzeć na ekran, ale tylko za zgodą macOS. Potrzebne dopiero, gdy poprosisz o pracę na komputerze — możesz to zrobić później (menu simbot → Ustawienia → Komputer: uprawnienia). Bez zgód kliknij po prostu „Zaczynamy”.</p>
          ${p?.helper === false ? '<p class="muted">Pomocnik systemowy nie działa — pominę ten krok.</p>' : `<div class="perms">${r('screen', 'Nagrywanie ekranu', 'żeby sim widział, co jest na ekranie')}${r('accessibility', 'Dostępność', 'żeby sim mógł klikać i pisać')}</div>
          <p class="muted">macOS czasem wymaga ponownego uruchomienia Simbota po nadaniu zgody.</p>`}
          <div class="modal__foot"><span class="muted" id="kErr"></span>${welcome ? '<button class="btn" data-back>Wstecz</button>' : ''}<button class="btn btn--primary" data-go>Zaczynamy</button></div>`;
        box.querySelectorAll('[data-perm]').forEach(b => b.onclick = () => window.qwe.perms.request(b.dataset.perm));
        box.querySelector('[data-back]')?.addEventListener('click', () => { clearInterval(poll); keyStep(); });
        box.querySelector('[data-go]').onclick = save;
      };
      draw(await window.qwe.perms.status());
      clearInterval(poll);
      poll = setInterval(async () => { if (!box.isConnected) return clearInterval(poll); draw(await window.qwe.perms.status()); }, 2500);
    };

    const save = async () => {
      clearInterval(poll);
      if (!Object.keys(values).length) return close(false); // nic nowego (np. pominięty klucz) — bez restartu
      box.querySelectorAll('button').forEach(b => (b.disabled = true));
      const err = box.querySelector('#kErr');
      if (err) err.textContent = 'zapisuję i uruchamiam simy ponownie…';
      if (values.ANTHROPIC_API_KEY) localStorage.removeItem(SKIP);
      const r = await window.qwe.secrets.set(values);
      // restart chatu przeładuje stronę sama; jeśli chat działa osobno (qwe dev) — mówimy, co zrobić
      if (r && !r.restarted) { if (err) err.textContent = r.reason || 'zapisane'; setTimeout(() => close(true), 2500); }
    };

    keyStep();
  }, { locked: welcome, wide: true });
}
