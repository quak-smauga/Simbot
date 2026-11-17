// STORE — SQLite (node:sqlite, wbudowane w Node ≥ 22.13). Jeden plik w QWE_DATA_DIR.
//   sessions   rozmowa: tytuł, członkowie (simy, JSON), workflow, ostatni snippet, nieprzeczytane
//   messages   historia dla LLM — role user|assistant|tool, author = kto (user → nazwa usera, bot → nazwa sima)
//   events     to, co UI odtwarza przy otwarciu rozmowy (karty narzędzi, pamięć, skille)
//   workflows  instrukcje „jak simy mają się zachowywać w tej rozmowie” (markdown)
//   settings   klucz → JSON (profil usera)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId } from "@qwe/core";

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  voice: number;
  /** Simy w rozmowie (nazwy botów), w kolejności dołączenia. Pierwszy = prowadzący (odpowiada, gdy nie ma @). */
  members: string[];
  workflow_id: string | null;
  /** Ostatnia linijka (kto: co) do listy po lewej. */
  snip: string;
  /** Wiadomości od simów, których user jeszcze nie widział (0, gdy rozmowa otwarta). */
  unread: number;
}
interface SessionRaw extends Omit<SessionRow, "members"> {
  members: string;
}
export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool";
  /** user → nazwa usera; assistant/tool → nazwa sima. */
  author: string;
  content: string;
  meta: string | null;
  created_at: string;
}
export interface SeqMessageRow extends MessageRow {
  /** rowid — rosnący numer wiadomości (kolejność zapisu). */
  seq: number;
}
export interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  at: string;
  task_id: string | null;
  data: string;
}
export interface WorkflowRow {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

export class Store {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "chat.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, voice INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // migracje: kolumny dochodzą, stare bazy zostają czytelne
    this.addColumn("sessions", "agent", "TEXT");
    this.addColumn("sessions", "members", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("sessions", "workflow_id", "TEXT");
    this.addColumn("sessions", "snip", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("sessions", "unread", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("messages", "author", "TEXT NOT NULL DEFAULT ''");
    // streszczenie starszej części rozmowy (dla simów) + do której wiadomości (rowid) sięga
    this.addColumn("sessions", "summary", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("sessions", "summary_seq", "INTEGER NOT NULL DEFAULT 0");
    // krótkie podsumowanie całej rozmowy (do szukania w poprzednich rozmowach) + do której wiadomości sięga
    this.addColumn("sessions", "recap", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("sessions", "recap_seq", "INTEGER NOT NULL DEFAULT 0");
    // 1 = tytuł nadany ręcznie przez usera (recap go nie podmienia)
    this.addColumn("sessions", "title_manual", "INTEGER NOT NULL DEFAULT 0");
    // stara sesja z jednym botem (kolumna agent) → members
    this.db.exec("UPDATE sessions SET members = '[\"' || agent || '\"]' WHERE agent IS NOT NULL AND members = '[]'");
  }
  private addColumn(table: string, col: string, def: string) {
    const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  private row(r: SessionRaw | undefined): SessionRow | undefined {
    if (!r) return undefined;
    let members: string[] = [];
    try {
      members = JSON.parse(r.members || "[]");
    } catch {
      /* [] */
    }
    // streszczenie jest dla simów, nie dla listy rozmów (lobby) — nie wozimy go w wierszu
    const { summary: _s, summary_seq: _q, recap: _r, recap_seq: _rq, title_manual: _tm, ...rest } = r as SessionRaw & { summary?: string; summary_seq?: number; recap?: string; recap_seq?: number; title_manual?: number };
    return { ...rest, members };
  }

  // ── sesje ──
  createSession(title = "Nowa rozmowa", members: string[] = [], workflowId: string | null = null): SessionRow {
    const t = now();
    const id = newId("ses");
    this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at, voice, members, workflow_id, snip, unread) VALUES (?, ?, ?, ?, 0, ?, ?, '', 0)").run(id, title, t, t, JSON.stringify(members), workflowId);
    return this.getSession(id)!;
  }
  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as unknown as SessionRaw[]).map((r) => this.row(r)!);
  }
  getSession(id: string): SessionRow | undefined {
    return this.row(this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRaw | undefined);
  }
  /** `manual` = user zmienił tytuł sam → automaty (recap) już go nie ruszają. */
  renameSession(id: string, title: string, manual = false) {
    this.db.prepare(`UPDATE sessions SET title = ?, updated_at = ?${manual ? ", title_manual = 1" : ""} WHERE id = ?`).run(title, now(), id);
  }
  /** Zmiana tytułu przez automat (recap) — bez ruszania updated_at (kolejność listy rozmów zostaje). */
  retitleAuto(id: string, title: string): boolean {
    return Number(this.db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title_manual = 0").run(title, id).changes) > 0;
  }
  isTitleManual(id: string): boolean {
    return !!(this.db.prepare("SELECT title_manual FROM sessions WHERE id = ?").get(id) as { title_manual?: number } | undefined)?.title_manual;
  }
  /** Rozmowy, w których od ostatniego recapu coś przybyło i które ucichły przed `idleBefore` (ISO). */
  sessionsNeedingRecap(idleBefore: string, limit = 10): string[] {
    return (
      this.db
        .prepare(
          "SELECT s.id FROM sessions s WHERE s.updated_at < ? AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.rowid > s.recap_seq) ORDER BY s.updated_at DESC LIMIT ?",
        )
        .all(idleBefore, limit) as { id: string }[]
    ).map((r) => r.id);
  }
  setMembers(id: string, members: string[]) {
    this.db.prepare("UPDATE sessions SET members = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...new Set(members)]), now(), id);
  }
  setWorkflow(id: string, workflowId: string | null) {
    this.db.prepare("UPDATE sessions SET workflow_id = ?, updated_at = ? WHERE id = ?").run(workflowId, now(), id);
  }
  setVoice(id: string, on: boolean) {
    this.db.prepare("UPDATE sessions SET voice = ? WHERE id = ?").run(on ? 1 : 0, id);
  }
  setSnip(id: string, snip: string, bumpUnread: boolean) {
    this.db.prepare(`UPDATE sessions SET snip = ?, updated_at = ?${bumpUnread ? ", unread = unread + 1" : ""} WHERE id = ?`).run(snip.slice(0, 140), now(), id);
  }
  markRead(id: string) {
    this.db.prepare("UPDATE sessions SET unread = 0 WHERE id = ?").run(id);
  }
  touch(id: string) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── wiadomości ──
  addMessage(sessionId: string, role: MessageRow["role"], author: string, content: string, meta?: Record<string, unknown>): MessageRow {
    const row: MessageRow = { id: newId("msg"), session_id: sessionId, role, author, content, meta: meta ? JSON.stringify(meta) : null, created_at: now() };
    this.db.prepare("INSERT INTO messages (id, session_id, role, author, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, sessionId, role, author, content, row.meta, row.created_at);
    this.touch(sessionId);
    return row;
  }
  /** Cała rozmowa (do UI), w kolejności zapisu. */
  messages(sessionId: string): MessageRow[] {
    return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as unknown as MessageRow[];
  }
  /** Wiadomości po danym miejscu (rowid), w kolejności zapisu — do budowania historii dla LLM. `seq` = rowid. */
  messagesSince(sessionId: string, afterSeq = 0): SeqMessageRow[] {
    return this.db.prepare("SELECT rowid AS seq, * FROM messages WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC").all(sessionId, afterSeq) as unknown as SeqMessageRow[];
  }
  lastSeq(sessionId: string): number {
    return ((this.db.prepare("SELECT MAX(rowid) AS s FROM messages WHERE session_id = ?").get(sessionId) as { s: number | null } | undefined)?.s ?? 0) as number;
  }
  getSummary(sessionId: string): { summary: string; seq: number } {
    const r = this.db.prepare("SELECT summary, summary_seq FROM sessions WHERE id = ?").get(sessionId) as { summary: string; summary_seq: number } | undefined;
    return { summary: r?.summary ?? "", seq: r?.summary_seq ?? 0 };
  }
  setSummary(sessionId: string, summary: string, seq: number) {
    this.db.prepare("UPDATE sessions SET summary = ?, summary_seq = ? WHERE id = ?").run(summary, seq, sessionId);
  }
  getRecap(sessionId: string): { recap: string; seq: number } {
    const r = this.db.prepare("SELECT recap, recap_seq FROM sessions WHERE id = ?").get(sessionId) as { recap: string; recap_seq: number } | undefined;
    return { recap: r?.recap ?? "", seq: r?.recap_seq ?? 0 };
  }
  setRecap(sessionId: string, recap: string, seq: number) {
    this.db.prepare("UPDATE sessions SET recap = ?, recap_seq = ? WHERE id = ?").run(recap, seq, sessionId);
  }
  /** Do szukania w poprzednich rozmowach: wiersze rozmów z podsumowaniami (bez wiadomości). */
  recallSessions(): { id: string; title: string; updated_at: string; members: string; recap: string; summary: string }[] {
    return this.db.prepare("SELECT id, title, updated_at, members, recap, summary FROM sessions ORDER BY updated_at DESC").all() as never;
  }
  /** Do szukania: wiadomości usera i simów (bez wyników narzędzi) ze wszystkich rozmów. */
  recallMessages(): { session_id: string; role: string; author: string; content: string; meta: string | null; created_at: string }[] {
    return this.db.prepare("SELECT session_id, role, author, content, meta, created_at FROM messages WHERE role != 'tool' ORDER BY rowid ASC").all() as never;
  }
  clearMessages(sessionId: string) {
    this.db.prepare("UPDATE sessions SET summary = '', summary_seq = 0, recap = '', recap_seq = 0 WHERE id = ?").run(sessionId);
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
    this.db.prepare("UPDATE sessions SET snip = '', unread = 0 WHERE id = ?").run(sessionId);
  }

  // ── eventy ──
  addEvent(sessionId: string, type: string, data: unknown, taskId?: string, at = now()): number {
    const r = this.db.prepare("INSERT INTO events (session_id, type, at, task_id, data) VALUES (?, ?, ?, ?, ?)").run(sessionId, type, at, taskId ?? null, JSON.stringify(data ?? {}));
    return Number(r.lastInsertRowid);
  }
  events(sessionId: string, limit = 2000): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT ?").all(sessionId, limit) as unknown as EventRow[];
  }

  // ── workflowy ──
  listWorkflows(): WorkflowRow[] {
    return this.db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all() as unknown as WorkflowRow[];
  }
  getWorkflow(id: string): WorkflowRow | undefined {
    return this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as unknown as WorkflowRow | undefined;
  }
  createWorkflow(name: string, body: string): WorkflowRow {
    const t = now();
    const row: WorkflowRow = { id: newId("wf"), name, body, created_at: t, updated_at: t };
    this.db.prepare("INSERT INTO workflows (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(row.id, name, body, t, t);
    return row;
  }
  updateWorkflow(id: string, patch: { name?: string; body?: string }): WorkflowRow | undefined {
    const w = this.getWorkflow(id);
    if (!w) return undefined;
    this.db.prepare("UPDATE workflows SET name = ?, body = ?, updated_at = ? WHERE id = ?").run(patch.name ?? w.name, patch.body ?? w.body, now(), id);
    return this.getWorkflow(id);
  }
  deleteWorkflow(id: string) {
    this.db.prepare("UPDATE sessions SET workflow_id = NULL WHERE workflow_id = ?").run(id);
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  // ── ustawienia (JSON pod kluczem) ──
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}
