// HUB — rejestr żywych rozmów (ChatSession per id) + jeden AgentLink na proces + lobby (zmiany na liście rozmów).
import { EventBus, type AgentEvent, type LlmAdapter } from "@qwe/core";
import type { VoiceConfig } from "@qwe/voice";
import { AgentLink, type AgentLinkOptions } from "./agent-link.js";
import type { BotRegistry } from "./bots.js";
import { ContextKeeper } from "./context.js";
import { RecapWriter } from "./recall.js";
import { ChatSession } from "./session.js";
import type { SessionRow, Store } from "./store.js";

export interface LobbyEvents {
  /** Wiersz na liście rozmów się zmienił (snippet, nieprzeczytane, tytuł, skład, stan). */
  "session.updated": { session: SessionRow; state: string };
  "session.removed": { id: string };
  /** Sim zawołał usera w rozmowie, na którą nikt nie patrzy. */
  "notify": { sessionId: string; bot: string; text: string; title: string };
  /** Agent server: online / wstaje / śpi. */
  "agent.status": { status: "down" | "starting" | "up" };
  /** Serwer MCP zmienił stan (connecting / connected / error) albo listę narzędzi. */
  "mcp.status": { name: string; state: string };
}

export class SessionHub {
  readonly link: AgentLink;
  readonly lobby = new EventBus<LobbyEvents>();
  private sessions = new Map<string, ChatSession>();
  readonly context: ContextKeeper;
  readonly recaps: RecapWriter;

  constructor(
    readonly store: Store,
    private llm: LlmAdapter,
    readonly voiceCfg: VoiceConfig,
    readonly bots: BotRegistry,
    private maxTokens: number,
    readonly mock: boolean,
    linkOpts: Omit<AgentLinkOptions, "onEvent">,
  ) {
    this.context = new ContextKeeper(store, llm, () => bots.getUser().name, (level, message) => console[level === "warn" ? "warn" : "log"](message));
    this.recaps = new RecapWriter(
      store,
      llm,
      () => bots.getUser().name,
      (level, message) => console[level === "warn" ? "warn" : "log"](message),
      (id, title) => {
        this.sessions.get(id)?.bus.emit("session.title", { title });
        this.announce(id);
      },
    );
    this.recaps.startSweep();
    this.link = new AgentLink({
      ...linkOpts,
      onEvent: (e) => this.route(e),
      log: (level, message) => {
        linkOpts.log(level, message);
        if (/^\[agent\]/.test(message)) this.lobby.emit("agent.status", { status: this.link.status });
      },
    });
  }

  private route(e: AgentEvent) {
    // skill zapisany przez agenta → prompt sima od nowa (następna tura już go widzi)
    if (e.type === "skill.saved" && typeof e.data.agent === "string") this.bots.reload(e.data.agent);
    // serwer MCP połączył się / zmienił listę narzędzi → prompty od nowa + UI (strona serwerów) odświeża stan
    if (e.type === "mcp.catalog") {
      this.bots.invalidatePrompts();
      this.lobby.emit("mcp.status", { name: String(e.data.name ?? ""), state: String(e.data.state ?? "") });
    }
    if (!e.sessionId) return;
    const s = this.sessions.get(e.sessionId);
    if (s) s.onAgentEvent(e);
  }

  /** Lista rozmów: wiersz z bazy + stan żywej sesji (jeśli jest). */
  listView() {
    return this.store.listSessions().map((s) => ({ ...s, state: this.sessions.get(s.id)?.getState() ?? "idle" }));
  }
  announce(id: string) {
    const row = this.store.getSession(id);
    if (!row) return this.lobby.emit("session.removed", { id });
    this.lobby.emit("session.updated", { session: row, state: this.sessions.get(id)?.getState() ?? "idle" });
  }

  open(id: string): ChatSession | null {
    const live = this.sessions.get(id);
    if (live) return live;
    if (!this.store.getSession(id)) return null;
    const s = new ChatSession(id, { store: this.store, llm: this.llm, link: this.link, voice: this.voiceCfg, bots: this.bots, maxTokens: this.maxTokens, context: this.context, recaps: this.recaps, onListChange: (sid) => this.announce(sid) });
    const tag = id.slice(-5);
    s.bus.on("log", ({ level, message }) => console[level === "error" ? "error" : "log"](`[${tag}] ${message}`));
    s.bus.on("say.end", ({ text, bot }) => text && console.log(`[${tag}] 🗨 @${bot}: ${text}`));
    s.bus.on("user.text", ({ text, source }) => console.log(`[${tag}] 👤 (${source}) ${text}`));
    s.bus.on("agent.state", () => this.announce(id));
    s.bus.on("mention.user", ({ bot, text }) => {
      if (s.clients) return;
      this.lobby.emit("notify", { sessionId: id, bot, text, title: this.store.getSession(id)?.title ?? "" });
    });
    this.sessions.set(id, s);
    return s;
  }

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cancelAll();
    this.sessions.delete(id);
  }

  live(id: string) {
    return this.sessions.get(id);
  }
}
