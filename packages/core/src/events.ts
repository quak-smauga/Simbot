// EVENTS — kręgosłup qwe. Każdy moduł tylko emituje i słucha. Dodanie nowego toola / nowej
// animacji = nowy event + subskrybent, bez grzebania w reszcie.
//
// Dwa poziomy:
//   EventBus<M>   — typowany bus in-process (chat: sesja; agent: proces)
//   AgentEvent    — uniwersalna koperta, która przechodzi między procesami (SSE agent → chat → WS → UI)
//                   i ląduje w event store. Niesie sessionId/taskId/planId/stepId, żeby dashboard
//                   nie mieszał rozmów i zadań.

export interface AgentEvent<T = Record<string, unknown>> {
  seq: number;
  type: string;
  at: string; // ISO
  sessionId?: string;
  taskId?: string;
  planId?: string;
  stepId?: string;
  data: T;
}

export type EventInput = Omit<AgentEvent, "seq" | "at"> & { at?: string };

export interface EventStore {
  append(e: EventInput): AgentEvent;
  list(opts?: { since?: number; limit?: number; sessionId?: string; taskId?: string }): AgentEvent[];
  subscribe(fn: (e: AgentEvent) => void): () => void;
}

/** Pamięciowy log zdarzeń: append-only, monotoniczny seq, fan-out do subskrybentów (SSE to jeden z nich). */
export class MemoryEventStore implements EventStore {
  private events: AgentEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: AgentEvent) => void>();
  constructor(private max = 5000, private sink?: (e: AgentEvent) => void) {}

  append(e: EventInput): AgentEvent {
    const full: AgentEvent = { ...e, seq: ++this.seq, at: e.at ?? new Date().toISOString() };
    this.events.push(full);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    this.sink?.(full);
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        /* zepsuty subskrybent nie może zepsuć zapisu */
      }
    }
    return full;
  }
  list(opts: { since?: number; limit?: number; sessionId?: string; taskId?: string } = {}): AgentEvent[] {
    const { since = 0, limit = 200, sessionId, taskId } = opts;
    return this.events
      .filter((e) => e.seq > since && (!sessionId || e.sessionId === sessionId) && (!taskId || e.taskId === taskId))
      .slice(-limit);
  }
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  get size() {
    return this.events.length;
  }
}

type Handler<P> = (payload: P) => void;

/** Typowany bus in-process. `M` to mapa nazwa → payload (patrz apps/chat/src/events.ts). */
export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<any>>>();
  private anyHandlers = new Set<(name: keyof M, payload: unknown) => void>();

  on<K extends keyof M>(name: K, fn: Handler<M[K]>): () => void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(fn);
    return () => void this.handlers.get(name)?.delete(fn);
  }
  once<K extends keyof M>(name: K, fn: Handler<M[K]>): () => void {
    const off = this.on(name, (p) => {
      off();
      fn(p);
    });
    return off;
  }
  /** Podsłuch wszystkiego — ws gateway mirroruje eventy do przeglądarki, store je zapisuje. */
  onAny(fn: (name: keyof M, payload: unknown) => void): () => void {
    this.anyHandlers.add(fn);
    return () => void this.anyHandlers.delete(fn);
  }
  emit<K extends keyof M>(name: K, payload: M[K]) {
    for (const fn of this.handlers.get(name) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] handler ${String(name)}:`, (e as Error).message);
      }
    }
    for (const fn of this.anyHandlers) {
      try {
        fn(name, payload);
      } catch (e) {
        console.error(`[bus] any-handler ${String(name)}:`, (e as Error).message);
      }
    }
  }
  /** Czekaj na event spełniający warunek (albo timeout → null). */
  wait<K extends keyof M>(name: K, pred: (p: M[K]) => boolean, timeoutMs: number): Promise<M[K] | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.on(name, (p) => {
        if (!pred(p)) return;
        clearTimeout(timer);
        off();
        resolve(p);
      });
    });
  }
}

let seq = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;
