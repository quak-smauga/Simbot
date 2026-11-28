// SECRETS — klucze API usera poza .env: zaszyfrowane przez Electron safeStorage (klucz szyfrujący trzyma pęk kluczy macOS)
// w <userData>/secrets.json (także w trybie dev — nigdy w repo). Do UI nigdy nie idzie wartość — tylko „ustawiony, kończy się na …ab12” i skąd jest.
// Chat i agent dostają klucze przez env przy starcie (wygrywają z .env, bo loadDotenv nie nadpisuje ustawionych zmiennych).
import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Klucze, które user wpisuje w aplikacji. `required` = bez niego (i bez Ollamy) simy nie rozmawiają. */
export const SECRET_KEYS = {
  ANTHROPIC_API_KEY: { label: 'Anthropic (Claude)', required: true, hint: 'console.anthropic.com → API Keys', prefix: 'sk-ant-' },
  ELEVENLABS_API_KEY: { label: 'ElevenLabs (głos)', hint: 'bez niego rozmowa tylko tekstem' },
  TAVILY_API_KEY: { label: 'Tavily (wyszukiwarka)', hint: 'bez niego wyszukiwanie przez DuckDuckGo' },
  BRAVE_API_KEY: { label: 'Brave Search', hint: 'zapasowa wyszukiwarka' },
};

export function createSecrets({ home, log }) {
  const file = join(home, 'secrets.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  // async API safeStorage (synchroniczne są wycofywane); stare Electrony bez nich → wersje synchroniczne
  const available = async () => (safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable());
  const enc = async v => (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(v) : safeStorage.encryptString(v));
  const dec = async b => { const r = safeStorage.decryptStringAsync ? await safeStorage.decryptStringAsync(b) : safeStorage.decryptString(b); return typeof r === 'string' ? r : r?.result ?? ''; };

  /** Odszyfrowane klucze z pęku kluczy (tylko dla procesów chatu i agenta, nigdy do UI). */
  async function load() {
    if (!existsSync(file) || !(await available())) return {};
    const out = {};
    for (const [name, b64] of Object.entries(read())) {
      if (!(name in SECRET_KEYS)) continue;
      try { out[name] = await dec(Buffer.from(b64, 'base64')); } catch (e) { log(`[secrets] nie odszyfruję ${name}: ${e.message}`); }
    }
    return out;
  }

  /** Stan dla UI: czy ustawiony i skąd (aplikacja albo .env / środowisko), bez wartości. */
  async function status(envFallback = {}) {
    const mine = await load();
    return Object.fromEntries(Object.entries(SECRET_KEYS).map(([name, meta]) => {
      const v = mine[name] || envFallback[name] || '';
      return [name, { ...meta, set: !!v, source: mine[name] ? 'app' : v ? 'env' : null, tail: v ? v.slice(-4) : '' }];
    }));
  }

  async function set(name, value) {
    if (!(name in SECRET_KEYS)) throw new Error(`nieznany klucz: ${name}`);
    if (!(await available())) throw new Error('szyfrowanie niedostępne (pęk kluczy macOS)');
    const all = read();
    const v = String(value ?? '').trim();
    if (v) all[name] = Buffer.from(await enc(v)).toString('base64');
    else delete all[name];
    writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    log(`[secrets] ${name} ${v ? 'zapisany' : 'usunięty'}`);
  }

  return { load, status, set, available };
}

/**
 * Szybki test klucza u dostawcy (bez kosztów): Anthropic GET /v1/models. Inne — bez testu (np. klucz ElevenLabs
 * z ograniczonymi uprawnieniami nie czyta /v1/user, a głos działa — fałszywy alarm gorszy niż brak testu).
 */
export async function testSecret(name, value) {
  const v = String(value ?? '').trim();
  if (!v) return { ok: false, error: 'pusty klucz' };
  const req = name === 'ANTHROPIC_API_KEY' ? ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': v, 'anthropic-version': '2023-06-01' }] : null;
  if (!req) return { ok: true, skipped: true };
  try {
    const r = await fetch(req[0], { headers: req[1], signal: AbortSignal.timeout(8000) });
    if (r.ok) return { ok: true };
    return { ok: false, error: r.status === 401 || r.status === 403 ? 'klucz odrzucony' : `odpowiedź ${r.status}` };
  } catch (e) {
    return { ok: false, error: `brak połączenia: ${e.message}` };
  }
}
