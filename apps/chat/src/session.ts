// SESSION (rozmowa) — maszyna stanów jednej rozmowy z wieloma simami. Żyje w procesie niezależnie od okna przeglądarki:
//   listening → (utterance → STT) → thinking → [working ⇄ waiting_user] → speaking → listening
// Wiadomość usera → parser @ → kolejka simów (każdy ma własny BotRunner) → sim może zawołać innego sima (@nazwa)
// albo usera (@imię → powiadomienie). Łańcuch sim→sim ma limit głębokości, żeby się nie zapętlić.
// Half-duplex: gdy sim mówi, VAD jest wyciszony. Podczas computer taska zwykłe wypowiedzi nie idą do LLM —
// transkrypcja trafia do command routera (zatrzymaj / wznów / anuluj / przejmuję kontrolę).
import { EventBus, matchVoiceCommand, resolveTargets, type AgentEvent, type LlmAdapter, type MentionAction } from "@qwe/core";
import { EnergyVad, VoicePipeline, asVoiceBus, transcribe, type VoiceConfig } from "@qwe/voice";
import type { AgentLink } from "./agent-link.js";
import { conversationPrompt, type BotRegistry, type MemoryView } from "./bots.js";
import { BotRunner } from "./chat.js";
import type { ContextKeeper } from "./context.js";
import { LOCAL_TOOLS, recentConversations, runLocalTool, type RecapWriter } from "./recall.js";
import type { AgentState, ChatBus, ChatEvents } from "./events.js";
import type { Store } from "./store.js";

/** Eventy, których nie zapisujemy do bazy (za częste albo bez wartości przy odtwarzaniu). */
const NO_PERSIST = new Set(["session.title", "session.members", "session.workflow", "say.text", "say.start", "say.end", "assistant.message", "user.text", "agent.state", "user.level", "voice.chunk", "voice.end", "voice.played", "voice.abort", "agent.thinking", "log", "user.utterance", "user.heard", "agent.event", "session.voice", "bot.turn", "mention.user", "mention.absent"]);
/** Z agent servera zapisujemy to, co UI odtwarza jako karty — także plan i etapy computer.run (bez nich panel po przeładowaniu gubił plan). */
const PERSIST_AGENT = /^(task\.|plan\.|step\.|computer\.(started|needs_user|completed|failed|cancelled|action|observation|note|loop|plan|stage|resumed)|web\.(started|completed)|tool\.|hello\.)/;
/** sim → sim → sim: tyle maks. ogniw po wiadomości usera. */
const MAX_CHAIN = 3;
/** Migawka pamięci w prompcie odświeża się po takiej przerwie (cache promptu i tak już wygasł — odświeżenie nic nie kosztuje). */
const MEMORY_REFRESH_IDLE_MS = 5 * 60_000;

export interface SessionDeps {
  store: Store;
  llm: LlmAdapter;
  link: AgentLink;
  voice: VoiceConfig;
  bots: BotRegistry;
  maxTokens: number;
  /** Kroczące streszczenie rozmowy (po turze, w tle). */
  context?: ContextKeeper;
  /** Recap rozmowy (do pamięci poprzednich rozmów) — po ciszy. */
  recaps?: RecapWriter;
  /** Zmiana widoczna na liście rozmów (snippet, nieprzeczytane, tytuł, skład) → lobby. */
  onListChange?: (id: string) => void;
}

export class ChatSession {
  readonly bus: ChatBus = new EventBus<ChatEvents>();
  readonly vad: EnergyVad;
  readonly voice: VoicePipeline;
  private runners = new Map<string, BotRunner>();
  private state: AgentState = "idle";
  private taskId: string | null = null;
  private utterQueue: Promise<void> = Promise.resolve();
  private busy: Promise<void> = Promise.resolve();
  private current: BotRunner | null = null;
  private currentBot: string | null = null;
  /** Pamięć w prompcie simów tej rozmowy — zamrożona, żeby nowy fakt w trakcie nie unieważniał cache promptu.
   *  Odświeża się przy nowym streszczeniu rozmowy albo po przerwie (> MEMORY_REFRESH_IDLE_MS). W samej rozmowie
   *  świeży fakt i tak jest w historii, więc sim go zna. */
  private mem: { seq: number; at: number; user: string[]; sims: Map<string, string[]> } | null = null;
  clients = 0;

  constructor(readonly id: string, private d: SessionDeps) {
    this.vad = new EnergyVad(d.voice.micSampleRate, d.voice.vad, d.voice.frameMs);
    this.voice = new VoicePipeline(asVoiceBus(this.bus), d.voice);
    this.voice.enabled = !!d.store.getSession(id)?.voice;

    this.vad.onLevel((rms, speaking) => this.bus.emit("user.level", { rms, speaking }));
    this.vad.onUtterance((u) => {
      this.bus.emit("user.heard", { durationMs: u.durationMs });
      this.bus.emit("user.utterance", u);
    });
    this.bus.on("user.utterance", (u) => (this.utterQueue = this.utterQueue.then(() => this.onUtterance(u.pcm, u.sampleRate, u.durationMs)).catch(() => {})));

    this.bus.on("say.start", () => this.setState("speaking"));
    this.bus.on("agent.state", ({ state, taskId }) => {
      if (taskId) this.taskId = taskId;
      if (state === "working" || state === "thinking") this.state = state;
    });
    this.bus.on("user.interrupt", () => this.interrupt());
    this.bus.on("session.voice", ({ on }) => {
      this.voice.enabled = on;
      d.store.setVoice(id, on);
      if (!on) this.bus.emit("voice.abort", {});
    });
    this.bus.on("session.reset", () => {
      this.cancelAll();
      d.store.clearMessages(id);
      d.onListChange?.(id);
    });
    this.bus.on("agent.event", (e) => {
      if (e.type === "task.waiting") this.setState("waiting_user", e.taskId);
      else if (e.type === "task.resumed") this.setState("working", e.taskId);
    });
    // snippet + nieprzeczytane: sim powiedział, a nikt nie patrzy (albo zawołał usera)
    this.bus.on("assistant.message", ({ text, bot }) => {
      d.store.setSnip(id, `${bot}: ${text}`, this.clients === 0);
      d.onListChange?.(id);
    });
    this.bus.on("mention.user", () => {
      if (this.clients) return;
      d.onListChange?.(id);
    });

    // persystencja: wszystko poza szumem
    this.bus.onAny((name, payload) => {
      const n = String(name);
      if (n === "agent.event") {
        const e = payload as AgentEvent;
        if (PERSIST_AGENT.test(e.type)) d.store.addEvent(id, e.type, { ...e.data, stepId: e.stepId, planId: e.planId, seq: e.seq }, e.taskId, e.at);
        return;
      }
      if (NO_PERSIST.has(n)) return;
      if (n === "tool.result") {
        const p = payload as ChatEvents["tool.result"];
        d.store.addEvent(id, n, { callId: p.callId, ok: p.ok, ms: p.ms, bot: p.bot, found: p.found }, p.taskId);
        return;
      }
      d.store.addEvent(id, n, payload, this.taskId ?? undefined);
    });
  }

  // ── skład rozmowy ──
  get members(): string[] {
    return (this.d.store.getSession(this.id)?.members ?? []).filter((m) => this.d.bots.get(m));
  }
  /** Prowadzący = pierwszy sim (odpowiada bez @). */
  get lead(): string | undefined {
    return this.members[0];
  }
  /** `by` = slug usera albo nazwa sima, który zawołał (@). */
  addMember(name: string, by = this.d.bots.getUser().slug) {
    if (!this.d.bots.get(name)) throw new Error(`nieznany sim: ${name}`);
    const m = this.members;
    if (m.includes(name)) return;
    this.d.store.setMembers(this.id, [...m, name]);
    this.bus.emit("session.members", { members: this.members, joined: name, by });
    this.bus.emit("log", { level: "info", message: `[rozmowa] @${name} dołącza (@${by})` });
    this.d.onListChange?.(this.id);
  }
  removeMember(name: string) {
    const m = this.members.filter((x) => x !== name);
    this.d.store.setMembers(this.id, m);
    this.runners.delete(name);
    this.bus.emit("session.members", { members: m, left: name });
    this.d.onListChange?.(this.id);
  }
  setWorkflow(workflowId: string | null) {
    const w = workflowId ? this.d.store.getWorkflow(workflowId) : undefined;
    if (workflowId && !w) throw new Error("nieznany workflow");
    this.d.store.setWorkflow(this.id, w ? w.id : null);
    this.bus.emit("session.workflow", { workflowId: w ? w.id : null, name: w?.name });
    this.d.onListChange?.(this.id);
  }
  get workflow() {
    const id = this.d.store.getSession(this.id)?.workflow_id;
    return id ? (this.d.store.getWorkflow(id) ?? null) : null;
  }

  private runner(bot: string): BotRunner {
    let r = this.runners.get(bot);
    if (!r) {
      r = new BotRunner({
        sessionId: this.id,
        bot,
        bus: this.bus,
        llm: this.d.llm,
        link: this.d.link,
        store: this.d.store,
        system: () => this.d.bots.systemPrompt(bot, this.memoryFor(bot)),
        context: () =>
          conversationPrompt({
            bot,
            members: this.members.map((n) => ({ name: n, description: this.d.bots.get(n)?.manifest.description ?? "" })),
            user: this.d.bots.getUser(),
            workflow: this.workflow,
            recent: this.recent(),
          }),
        local: (call) => (LOCAL_TOOLS.has(call.name) ? runLocalTool(this.d.store, call, this.id, this.d.bots.getUser().name) : null),
        voice: () => this.d.bots.get(bot)?.manifest.look?.voice ?? "",
        maxTokens: this.d.maxTokens,
        onTurnDone: (exchange) => void this.remember(bot, exchange),
      });
      this.runners.set(bot, r);
    }
    return r;
  }
  get activeTaskId(): string | null {
    return this.current?.activeTaskId ?? this.taskId;
  }

  /** Lista ostatnich rozmów w kontekście — liczona raz na rozmowę (stabilny prefiks dla cache). */
  private recentCache: { title: string; day: string }[] | null = null;
  private recent() {
    return (this.recentCache ??= recentConversations(this.d.store, this.id));
  }

  private memoryFor(bot: string): MemoryView {
    const seq = this.d.store.getSummary(this.id).seq;
    const now = Date.now();
    if (!this.mem || this.mem.seq !== seq || now - this.mem.at > MEMORY_REFRESH_IDLE_MS) this.mem = { seq, at: now, user: this.d.bots.userMemory(), sims: new Map() };
    this.mem.at = now;
    if (!this.mem.sims.has(bot)) this.mem.sims.set(bot, this.d.bots.memoryView(bot).sim);
    return { user: this.mem.user, sim: this.mem.sims.get(bot)! };
  }

  /** Pamięć po turze — async, bez blokowania rozmowy; UI dostaje chip „zapamiętałem” (osobno: o userze / notatki sima). */
  private async remember(bot: string, exchange: Parameters<BotRegistry["remember"]>[1]) {
    try {
      const r = await this.d.bots.remember(bot, exchange, this.d.store.getSummary(this.id).summary);
      if (r.user.added.length || r.user.removed.length) this.bus.emit("memory.saved", { agent: bot, scope: "user", added: r.user.added, removed: r.user.removed });
      if (r.sim.added.length || r.sim.removed.length) this.bus.emit("memory.saved", { agent: bot, scope: "sim", added: r.sim.added, removed: r.sim.removed });
    } catch (e) {
      this.bus.emit("log", { level: "warn", message: `[memory] ${(e as Error).message}` });
    }
  }

  /** Event z agent servera (po sessionId) → bus sesji. */
  onAgentEvent(e: AgentEvent) {
    this.bus.emit("agent.event", e);
  }

  /** PCM s16le 16k z przeglądarki. */
  pushAudio(chunk: Buffer) {
    this.vad.push(chunk);
  }

  sendText(text: string) {
    this.handleText(text, "typed");
  }

  private async onUtterance(pcm: Buffer, sampleRate: number, durationMs: number) {
    const t0 = Date.now();
    let text: string;
    try {
      text = await transcribe({ pcm, sampleRate, durationMs }, this.d.voice);
    } catch (e) {
      this.bus.emit("log", { level: "error", message: `[stt] ${(e as Error).message}` });
      return;
    }
    this.bus.emit("log", { level: "info", message: `🗣 (${(durationMs / 1000).toFixed(1)}s, stt ${Date.now() - t0}ms) ${text || "<cisza>"}` });
    if (!text) return;
    this.handleText(text, "stt");
  }

  private handleText(text: string, source: "stt" | "typed") {
    // komputer pracuje → tylko komendy sterujące (głosem albo z pola tekstowego)
    if (this.state === "working" || this.state === "waiting_user") {
      const cmd = matchVoiceCommand(text);
      if (cmd) {
        this.bus.emit("user.command", { command: cmd, text });
        void this.command(cmd);
        return;
      }
      if (source === "stt") {
        this.bus.emit("log", { level: "info", message: `[router] komputer pracuje — ignoruję: "${text}"` });
        return;
      }
      this.bus.emit("log", { level: "warn", message: "komputer pracuje — napisz „zatrzymaj”, „wznów”, „anuluj” albo poczekaj na wynik" });
      return;
    }
    const run = () => this.respondTo(text, source);
    this.busy = this.busy.then(run, run);
  }

  async command(cmd: ReturnType<typeof matchVoiceCommand>) {
    const id = this.activeTaskId;
    if (!id || !cmd) return;
    const op = cmd === "pause" || cmd === "take_control" ? "pause" : cmd === "resume" || cmd === "give_control" ? "resume" : "cancel";
    const r = await this.d.link.control(id, op);
    this.bus.emit("log", { level: "info", message: `[router] ${cmd} → ${op}: ${r.state ?? r.error}` });
  }

  async control(op: "pause" | "resume" | "cancel", taskId?: string) {
    const id = taskId ?? this.activeTaskId;
    if (!id) return { error: "brak aktywnego zadania" };
    return this.d.link.control(id, op);
  }

  /** Pierwsza wiadomość → emoji + krótki tytuł (osobne, małe wywołanie, równolegle z odpowiedzią). W mocku: z tekstu. */
  private async autoTitle(userText: string) {
    const row = this.d.store.getSession(this.id);
    if (!row || row.title !== "Nowa rozmowa") return;
    this.bus.emit("session.title", { title: row.title, pending: true });
    let title = "";
    let emoji = "";
    const clean = userText.replace(/@[a-z0-9-]+(\.[a-z]+)?/gi, "").replace(/\s+/g, " ").trim();
    try {
      if (this.d.llm.mock) {
        const words = clean.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).slice(0, 4).join(" ");
        emoji = /faktur|przelew|zł/i.test(clean) ? "🧾" : /gr[aę]|zagraj/i.test(clean) ? "🎮" : /szukaj|sprawd|ile|co to/i.test(clean) ? "🔎" : /wejd|otw[óo]rz|stron/i.test(clean) ? "🌐" : "💬";
        title = words.charAt(0).toUpperCase() + words.slice(1);
      } else {
        const { value } = await this.d.llm.json<{ emoji?: string; title?: string }>(
          'Nadajesz tytuł rozmowie na podstawie pierwszej wiadomości użytkownika. Zwróć TYLKO JSON: {"emoji":"jedno emoji pasujące do tematu","title":"2–5 słów po polsku, bez kropki, bez cudzysłowów"}.',
          [{ role: "user", content: clean.slice(0, 600) }],
          { maxTokens: 80 },
        );
        emoji = (value.emoji ?? "").trim().slice(0, 4);
        title = (value.title ?? "").trim().replace(/^["„]|["”]$/g, "").slice(0, 60);
      }
    } catch (e) {
      this.bus.emit("log", { level: "warn", message: `[title] ${(e as Error).message}` });
    }
    if (!title) title = clean.split(/\s+/).slice(0, 5).join(" ").slice(0, 60) || "Rozmowa";
    const full = emoji ? `${emoji} ${title}` : title;
    this.d.store.renameSession(this.id, full);
    this.bus.emit("session.title", { title: full, emoji });
    this.d.onListChange?.(this.id);
  }

  /** Wiadomość usera → zapis → parser @ → simy po kolei (+ łańcuch sim→sim). */
  private async respondTo(userText: string, source: "stt" | "typed") {
    const { store, bots } = this.d;
    const user = bots.getUser();
    const msg = store.addMessage(this.id, "user", user.slug, userText, { source });
    this.bus.emit("user.text", { text: userText, source, messageId: msg.id, author: user.slug });
    store.setSnip(this.id, `${user.name || "ty"}: ${userText}`, false);
    this.d.onListChange?.(this.id);
    void this.autoTitle(userText);

    const targets = resolveTargets(userText, { members: this.members, known: bots.names(), user: user.slug });
    if (targets.unknown.length) this.bus.emit("log", { level: "warn", message: `nie znam sima: ${targets.unknown.map((u) => "@" + u).join(", ")}` });
    if (targets.absent.length) this.bus.emit("mention.absent", { names: targets.absent });
    if (!targets.bots.length) {
      this.bus.emit("log", { level: "warn", message: "w tej rozmowie nie ma żadnego sima — dodaj kogoś albo napisz @nazwa" });
      return;
    }
    this.vad.setMuted(true);
    this.setState("thinking");
    try {
      const queue: { name: string; action: MentionAction; by: string; joined: boolean }[] = targets.bots.map((b) => ({ ...b, by: user.slug }));
      let chain = 0;
      while (queue.length) {
        const t = queue.shift()!;
        if (t.joined) this.addMember(t.name, t.by);
        this.bus.emit("bot.turn", { bot: t.name, action: t.action, by: t.by, joined: t.joined });
        const r = this.runner(t.name);
        this.current = r;
        this.currentBot = t.name;
        const said = await r.respond(source, t.action);
        this.current = null;
        this.currentBot = null;
        await this.voice.waitPlayed();
        // sim zawołał kogoś? user → powiadomienie; inny sim → dołącza do kolejki (z limitem łańcucha)
        const next = resolveTargets(said, { members: this.members, known: bots.names(), user: user.slug, from: t.name });
        if (next.userMentioned) {
          const last = store.messagesSince(this.id, store.lastSeq(this.id) - 1).at(-1);
          this.bus.emit("mention.user", { bot: t.name, text: said, messageId: last?.id ?? "" });
        }
        if (chain < MAX_CHAIN)
          for (const b of next.bots) {
            if (queue.some((q) => q.name === b.name)) continue;
            queue.push({ ...b, by: t.name });
            chain++;
          }
      }
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      this.vad.setMuted(false);
      this.setState(this.voice.enabled ? "listening" : "idle");
      // rozmowa urosła? streść najstarszy kawałek — w tle, następna tura już go użyje
      void this.d.context?.maybeSummarize(this.id);
      this.d.recaps?.schedule(this.id);
    }
  }

  /** Esc / barge-in: cisza i koniec myślenia; zadanie komputera w toku zostaje (anuluje się tylko wprost). */
  private interrupt() {
    const waiting = [...this.runners.values()].map((r) => r.interrupt()).some(Boolean);
    this.bus.emit("voice.abort", {});
    if (waiting) this.bus.emit("log", { level: "warn", message: "przerwane mówienie — zadanie komputera trwa dalej (Anuluj albo „anuluj zadanie”, żeby je zatrzymać)" });
  }
  cancelAll() {
    for (const r of this.runners.values()) r.cancel();
  }

  private setState(s: AgentState, taskId?: string) {
    if (taskId) this.taskId = taskId;
    if (this.state === s) return;
    this.state = s;
    this.bus.emit("agent.state", { state: s, taskId: this.taskId ?? undefined, bot: this.currentBot ?? undefined });
  }
  getState() {
    return this.state;
  }
}
