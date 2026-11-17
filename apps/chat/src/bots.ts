// BOTS (simy) — rejestr simów (agents/<name>) po stronie chatu: spec, prompt systemowy, przeładowanie po zmianie
// (skill.save z agenta, edycja na stronie sima), pamięć (memory.md) z asynchronicznym zbieraniem faktów po turze,
// profil usera (wchodzi do promptu) i kontekst rozmowy (kto jest w rozmowie, workflow).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SAFE_NAME,
  createAgent,
  deleteAgent,
  deleteSkill,
  listAgents,
  loadAgentSpec,
  mcpPrompt,
  readManifest,
  readMcpCatalog,
  readMcpConfig,
  toolsPrompt,
  writeManifest,
  writeMemory,
  writePersona,
  writeSkill,
  type AgentManifest,
  type AgentSpec,
  type AvatarConfig,
  type LlmAdapter,
  type Turn,
} from "@qwe/core";
import { readFileSync } from "node:fs";
import { MEMORY_SEARCH_USAGE } from "./recall.js";
import { resolve } from "node:path";

const MAX_HOPS = 3;
/** Wspólna pamięć o userze — maks. linii (najstarsze wypadają). */
const USER_MEMORY_MAX = 150;

/** Sima — domyślny sim aplikacji: jest zawsze, nie widać jej na liście simów, z nią startuje każda nowa rozmowa. Głos = domyślny (ELEVEN_VOICE_ID). */
export const SIMA = "sima";
const SIMA_SPEC = {
  description: "domyślna — szybka rozmowa o czymkolwiek",
  // wygląd = preset „Sima” z UI (avatar.js)
  look: { color: "#E8453C", voice: "", avatar: { shape: "head", eyes: "lash", mouth: "smile", acc: ["bun"], pattern: "shade", idle: "sway" } },
  persona: "# Sima\n\nJesteś Sima — domyślna towarzyszka w tej aplikacji. Mówisz po polsku, ciepło, krótko i konkretnie. Pomagasz we wszystkim od ręki: odpowiadasz, szukasz w sieci, bierzesz komputer. Gdy sprawa wymaga specjalisty, możesz zasugerować dodanie innego sima do rozmowy.",
};

/** Profil usera (jedna osoba na instancję): imię + awatar jak u simów. */
export interface UserProfile {
  name: string;
  slug: string;
  look: { color: string; avatar: AvatarConfig };
}
export const DEFAULT_USER: UserProfile = { name: "", slug: "ty", look: { color: "#E8453C", avatar: { shape: "head", eyes: "round", mouth: "smile", acc: [], pattern: "shade", idle: "sway" } } };

/** Pamięć w prompcie: wspólna „o userze” + notatki tego sima. */
export interface MemoryView {
  user: string[];
  sim: string[];
}
const MEMORY_MARK = "{{MEMORY}}";

export interface MemoryDiff {
  added: string[];
  removed: string[];
}

export function memoryPrompt(bot: string, who: string, mem: MemoryView): string {
  const out: string[] = [];
  if (mem.user.length) out.push(`## Co wiesz o ${who}\nWspólna pamięć wszystkich simów — fakty zebrane z wcześniejszych rozmów.\n` + mem.user.map((m) => `- ${m}`).join("\n"));
  if (mem.sim.length) out.push(`## Twoje notatki z pracy (tylko @${bot})\n` + mem.sim.map((m) => `- ${m}`).join("\n"));
  return out.join("\n\n");
}

/** Prompt systemowy sima bez pamięci (zostaje znacznik {{MEMORY}} — wstawia go systemPrompt(name, mem)). */
export function buildSystemPrompt(spec: AgentSpec, user: UserProfile, mcp = ""): string {
  const tpl = readFileSync(resolve(import.meta.dirname, "..", "prompts", "system.md"), "utf8");
  // + narzędzia chat servera, które ma każdy sim (pamięć poprzednich rozmów) + serwery MCP tego sima (z katalogu na dysku)
  const tools = [toolsPrompt(spec.capabilities.map((c) => c.descriptor)), `- ${MEMORY_SEARCH_USAGE.usage}\n  ${MEMORY_SEARCH_USAGE.notes}`, mcp ? `\n${mcp}` : ""].filter(Boolean).join("\n");
  const skills = spec.skills.length
    ? "## Umiejętności (jak podchodzić do zadań)\n" + spec.skills.map((s) => `### ${s.name}${s.description ? ` — ${s.description}` : ""}\n${s.body}`).join("\n\n")
    : "";
  const who = user.name || "użytkownik";
  return [
    tpl
      .replaceAll("{{USER}}", who)
      .replaceAll("{{USER_SLUG}}", user.slug)
      .replaceAll("{{BOT}}", spec.manifest.name)
      .replace("{{TOOLS}}", tools || "(brak narzędzi)")
      .replace("{{MAX_HOPS}}", String(MAX_HOPS))
      .replace("{{SKILLS}}", skills),
    spec.persona,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Kontekst tej konkretnej rozmowy (zmienny, poza cache'owanym promptem): kto jest w rozmowie, workflow. */
export function conversationPrompt(o: { bot: string; members: { name: string; description: string }[]; user: UserProfile; workflow?: { name: string; body: string } | null; recent?: { title: string; day: string }[] }): string {
  const others = o.members.filter((m) => m.name !== o.bot);
  const lines = [
    `## Ta rozmowa`,
    `Jesteś @${o.bot}. Rozmawiasz z ${o.user.name || "użytkownikiem"} (@${o.user.slug}).` +
      (others.length ? ` W rozmowie są też inne simy: ${others.map((m) => `@${m.name}${m.description ? ` (${m.description})` : ""}`).join(", ")}.` : " Jesteś jedynym simem w tej rozmowie."),
    others.length
      ? `Wiadomości innych simów widzisz jako „@nazwa: …”. Żeby przekazać coś innemu simowi, napisz @nazwa w swojej wypowiedzi — odpowie po Tobie. Nie powtarzaj cudzej roboty, nie odpowiadaj za innych. Jak user zwrócił się do kogoś innego, a nie do Ciebie — nie wtrącasz się.`
      : "",
    `Żeby zawołać ${o.user.name || "usera"} (np. potrzebujesz potwierdzenia albo decyzji), napisz @${o.user.slug} w wypowiedzi — dostanie powiadomienie.`,
  ];
  if (o.workflow) lines.push("", `## Workflow tej rozmowy: ${o.workflow.name}`, o.workflow.body.trim());
  if (o.recent?.length) lines.push("", `## Ostatnie wcześniejsze rozmowy (szczegóły: memory.search)`, ...o.recent.map((r) => `- ${r.day} · ${r.title}`));
  return lines.filter((l) => l !== "").join("\n");
}

/** Lekki widok bota dla UI (bez treści skilli — te osobno). */
export function botView(spec: AgentSpec) {
  const m = spec.manifest;
  return {
    name: m.name,
    description: m.description ?? "",
    version: m.version,
    look: { color: m.look?.color ?? "#3A7BD5", emoji: m.look?.emoji ?? "", voice: m.look?.voice ?? "", tempo: m.look?.tempo ?? "normal", avatar: { shape: "circle", eyes: "round", mouth: "smile", acc: [], pattern: "none", idle: "bob", ...(m.look?.avatar ?? {}) } },
    persona: spec.persona,
    capabilities: spec.capabilities.map((c) => ({ name: c.descriptor.name, kind: c.kind, description: c.descriptor.description, tools: c.descriptor.tools.map((t) => t.name), deps: c.descriptor.dependencies?.npm ?? [] })),
    builtin: m.capabilities.builtin ?? [],
    mcp: m.capabilities.mcp ?? [],
    skills: spec.skills.map((s) => ({ name: s.name, description: s.description, uses: s.uses, body: s.body })),
    memory: spec.memory,
    memoryEnabled: m.memory?.enabled !== false,
    model: m.model ?? {},
    dir: spec.dir,
  };
}

export class BotRegistry {
  private specs = new Map<string, AgentSpec>();
  private prompts = new Map<string, string>();
  /** Nazwy wbudowanych capability dostępnych do włączenia (plugins/* w monorepo). */
  readonly builtinAvailable = ["web", "computer", "skills"];

  private user: UserProfile = DEFAULT_USER;
  /** Katalog danych (mcp.json, mcp-catalog.json) — ustawia chat server; bez niego prompt nie ma sekcji MCP. */
  private dataDir: string | null = null;
  setDataDir(dir: string) {
    this.dataDir = dir;
    this.prompts.clear();
  }
  /** Katalog albo konfiguracja MCP się zmieniły → prompty od nowa przy następnej turze. */
  invalidatePrompts() {
    this.prompts.clear();
  }
  /** Które simy mają dostęp do serwera MCP `server` (zapis w manifestach; reszcie odbiera). */
  setMcpAccess(server: string, sims: string[]) {
    for (const spec of this.list()) {
      const m = readManifest(spec.dir);
      const cur = m.capabilities.mcp ?? [];
      const want = sims.includes(m.name);
      if (want === cur.includes(server)) continue;
      m.capabilities.mcp = want ? [...cur, server] : cur.filter((s) => s !== server);
      writeManifest(spec.dir, m);
      this.reload(m.name);
    }
  }

  constructor(readonly root: string, readonly defaultName: string, private llm: LlmAdapter, private onChange?: (name: string) => void) {
    this.reloadAll();
  }

  /** Profil usera wchodzi do promptu każdego sima (imię, @slug). */
  setUser(u: UserProfile) {
    this.user = u;
    this.prompts.clear();
  }
  getUser() {
    return this.user;
  }

  /** Sima jest zawsze (folder tworzony przy starcie, jeśli go nie ma); resztę simów dodaje user w UI. */
  reloadAll() {
    this.specs.clear();
    this.prompts.clear();
    if (!existsSync(join(this.root, SIMA, "AgentManifest.yaml"))) createAgent(this.root, SIMA, SIMA_SPEC as Parameters<typeof createAgent>[2]);
    for (const s of listAgents(this.root)) this.specs.set(s.manifest.name, s);
  }
  reload(name: string) {
    const dir = join(this.root, name);
    if (!existsSync(join(dir, "AgentManifest.yaml"))) {
      this.specs.delete(name);
      this.prompts.delete(name);
      return;
    }
    this.specs.set(name, loadAgentSpec(dir));
    this.prompts.delete(name);
    this.onChange?.(name);
  }
  /** Wszystkie simy (z Simą). */
  list(): AgentSpec[] {
    return [...this.specs.values()];
  }
  /** Simy widoczne w UI (bez Simy). */
  visible(): AgentSpec[] {
    return this.list().filter((s) => s.manifest.name !== SIMA);
  }
  sima(): AgentSpec {
    return this.specs.get(SIMA)!;
  }
  get(name: string): AgentSpec | undefined {
    return this.specs.get(name);
  }
  /** Sim po nazwie, albo domyślny / pierwszy. `undefined`, gdy nie ma żadnego. */
  resolve(name?: string | null): AgentSpec | undefined {
    return (name && this.specs.get(name)) || this.specs.get(this.defaultName) || this.specs.get(SIMA) || this.list()[0];
  }
  names(): string[] {
    return [...this.specs.keys()];
  }
  /** Prompt systemowy z pamięcią. `mem` = migawka z rozmowy (ChatSession), żeby zapis faktu w trakcie nie psuł cache;
   *  bez `mem` — bieżąca pamięć z dysku. */
  systemPrompt(name: string, mem?: MemoryView): string {
    let p = this.prompts.get(name);
    if (!p) {
      const spec = this.specs.get(name);
      if (!spec) throw new Error(`nieznany sim: ${name}`);
      const servers = spec.manifest.capabilities.mcp ?? [];
      p = buildSystemPrompt(spec, this.user, this.dataDir && servers.length ? mcpPrompt(servers, readMcpConfig(this.dataDir), readMcpCatalog(this.dataDir)) : "");
      this.prompts.set(name, p);
    }
    const m = mem ?? this.memoryView(name);
    return p.replace(MEMORY_MARK, memoryPrompt(name, this.user.name || "użytkowniku", m));
  }

  // ── pamięć wspólna „o userze” (settings) ──
  private userMem: { get: () => string[]; set: (lines: string[]) => void } = { get: () => [], set: () => {} };
  setUserMemoryStore(io: { get: () => string[]; set: (lines: string[]) => void }) {
    this.userMem = io;
  }
  userMemory(): string[] {
    return this.userMem.get();
  }
  setUserMemory(lines: string[]) {
    this.userMem.set(lines.map((l) => String(l).trim()).filter(Boolean).slice(-USER_MEMORY_MAX));
  }
  /** Bieżąca pamięć dla sima: wspólna + jego notatki (jeśli ma włączoną pamięć). */
  memoryView(name: string): MemoryView {
    const spec = this.specs.get(name);
    return { user: this.userMemory(), sim: spec && spec.manifest.memory?.enabled !== false ? spec.memory : [] };
  }

  // ── CRUD ──
  create(name: string, opts: Parameters<typeof createAgent>[2]) {
    const s = createAgent(this.root, name, { builtin: ["web", "computer", "skills"], ...opts });
    this.specs.set(s.manifest.name, s);
    return s;
  }
  remove(name: string) {
    if (!this.specs.has(name)) throw new Error("nieznany sim");
    if (name === SIMA) throw new Error("Simy nie da się usunąć — to domyślny sim aplikacji");
    deleteAgent(this.root, name);
    this.specs.delete(name);
    this.prompts.delete(name);
  }
  update(name: string, patch: { description?: string; persona?: string; look?: AgentManifest["look"]; builtin?: string[]; mcp?: string[]; memoryEnabled?: boolean; model?: AgentManifest["model"] }) {
    const spec = this.specs.get(name);
    if (!spec) throw new Error("nieznany bot");
    const m = readManifest(spec.dir);
    if (patch.description !== undefined) m.description = patch.description;
    if (patch.look) m.look = { ...(m.look ?? {}), ...patch.look, avatar: patch.look.avatar ? { ...(m.look?.avatar ?? {}), ...patch.look.avatar } : m.look?.avatar };
    if (patch.builtin) m.capabilities.builtin = patch.builtin.filter((b) => this.builtinAvailable.includes(b));
    if (Array.isArray(patch.mcp)) m.capabilities.mcp = [...new Set(patch.mcp.map(String))].filter((s) => !this.dataDir || !!readMcpConfig(this.dataDir).mcpServers[s]);
    if (patch.memoryEnabled !== undefined) m.memory = { ...(m.memory ?? {}), enabled: patch.memoryEnabled };
    if (patch.model) m.model = { ...(m.model ?? {}), ...patch.model };
    writeManifest(spec.dir, m);
    if (patch.persona !== undefined) writePersona(spec.dir, m, patch.persona);
    this.reload(name);
    return this.specs.get(name)!;
  }
  saveSkill(name: string, skill: string, body: string, description = "") {
    const spec = this.specs.get(name);
    if (!spec) throw new Error("nieznany bot");
    writeSkill(spec.dir, spec.manifest, skill, body, { description });
    this.reload(name);
  }
  removeSkill(name: string, skill: string) {
    const spec = this.specs.get(name);
    if (!spec) throw new Error("nieznany bot");
    deleteSkill(spec.dir, spec.manifest, skill);
    this.reload(name);
  }
  setMemory(name: string, lines: string[]) {
    const spec = this.specs.get(name);
    if (!spec) throw new Error("nieznany bot");
    writeMemory(spec.dir, lines);
    this.reload(name);
  }

  /**
   * Pamięć po turze: z wymiany (user ↔ sim) wyciąga trwałe fakty i rozkłada je na dwie pamięci:
   *   user — wspólna dla wszystkich simów (kim jest user, firma, preferencje, stałe dane),
   *   sim  — notatki tego sima z jego roli (jak robi swoje zadania, ustalenia dotyczące jego pracy).
   * `summary` = streszczenie rozmowy (żeby rozumieć „tamtą firmę” itp.). Async — rozmowa na to nie czeka.
   */
  async remember(name: string, exchange: Turn[], summary = ""): Promise<{ user: MemoryDiff; sim: MemoryDiff }> {
    const none = { user: { added: [], removed: [] }, sim: { added: [], removed: [] } };
    const spec = this.specs.get(name);
    if (!spec || spec.manifest.memory?.enabled === false) return none;
    const who = this.user.name || "user";
    const userNow = this.userMemory();
    const simNow = spec.memory;
    let raw: { user?: { add?: string[]; remove?: string[] }; sim?: { add?: string[]; remove?: string[] } };
    if (this.llm.mock) {
      const u = (exchange.find((t) => t.role === "user")?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
      const aboutUser = /\b(mam na imię|jestem|mieszkam|lubię|nie lubię|moja firma|pracuję)\b/i.test(u);
      const fact = aboutUser ? `(mock) ${who}: ${u}` : `(mock) ${who} pytał: ${u}`;
      const exists = [...userNow, ...simNow].some((e) => e.includes(u));
      raw = !u || exists ? {} : aboutUser ? { user: { add: [fact] } } : { sim: { add: [fact] } };
    } else {
      const { value } = await this.llm.json<typeof raw>(
        [
          `Jesteś pamięcią simów (asystentów AI) użytkownika ${who}. Z ostatniej wymiany wyciągasz TRWAŁE fakty, które przydadzą się w przyszłych rozmowach, i przydzielasz każdy do jednej z dwóch pamięci:`,
          `USER — wspólna dla wszystkich simów: kim jest ${who} i jak wygląda jego świat (imię, rodzina, miejsce, firma i jej dane, stałe kontakty i kontrahenci, z jakich usług/kont korzysta, preferencje, jak lubi, żeby coś robić, ważne terminy).`,
          `SIM — notatki tylko @${name}${spec.manifest.description ? ` (rola: ${spec.manifest.description})` : ""}: wiedza o tym, jak wykonywać zadania tej roli, której inne simy nie potrzebują (kroki procesu, ustalenia co do jego pracy, co działa, a co nie).`,
          `Gdy fakt dotyczy ${who} albo jego spraw ogólnie → USER. Gdy dotyczy sposobu wykonywania pracy tej roli → SIM. Nie zapisuj tego samego w obu.`,
          'Nauczka z pracy narzędziem ma w zdaniu ZAKRES, w którym się wydarzyła: przeglądarka wbudowana (computer.run) to co innego niż cały komputer (computer.run target="desktop") — zacznij od „W przeglądarce wbudowanej…” albo „Na komputerze (desktop)…”. Kłopot z jednego trybu nie jest regułą dla drugiego; pojedynczy błąd narzędzia to nie trwały fakt.',
          "NIE zapisujesz: jednorazowych pytań i chwilowych tematów, rzeczy wynikających tylko z tej jednej rozmowy, treści stron, haseł, numerów kart i kont bankowych, danych wrażliwych (zdrowie, finanse osobiste), własnych odpowiedzi simów.",
          `Każdy fakt: jedno krótkie zdanie po polsku, w 3. osobie („${who}…”), samodzielnie zrozumiałe (bez „ten”, „tamten”). Jeśli fakt już jest w pamięci — pomiń. Jeśli nowy fakt zmienia stary — podaj stary (dokładny tekst) w remove.`,
          'Zwróć TYLKO JSON: {"user":{"add":[],"remove":[]},"sim":{"add":[],"remove":[]}}. Zwykle wszystko jest puste albo 1–2 pozycje.',
        ].join("\n"),
        [
          {
            role: "user",
            content: [
              `PAMIĘĆ USER:\n${userNow.map((l) => `- ${l}`).join("\n") || "(pusta)"}`,
              `PAMIĘĆ SIM (@${name}):\n${simNow.map((l) => `- ${l}`).join("\n") || "(pusta)"}`,
              summary ? `STRESZCZENIE ROZMOWY (kontekst):\n${summary.slice(0, 3000)}` : "",
              `OSTATNIA WYMIANA:\n${exchange.map((t) => `${t.role === "user" ? who : `@${name}`}: ${t.content.replace(/<nativeapi>[\s\S]*$/, "").trim().slice(0, 1500)}`).join("\n")}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        { maxTokens: 400 },
      );
      raw = value ?? {};
    }
    const today = new Date().toISOString().slice(0, 10);
    const clean = (a?: string[]) => (a ?? []).map((s) => String(s).trim()).filter((s) => s && s.length < 240);
    const apply = (existing: string[], add: string[], remove: string[], max: number) => {
      const kept = existing.filter((l) => !remove.some((r) => l.includes(r) || r.includes(l)));
      const fresh = add.filter((a) => !kept.some((k) => k.includes(a)));
      return { next: [...kept, ...fresh.map((a) => `${today} · ${a}`)].slice(-max), added: fresh, removed: existing.filter((l) => !kept.includes(l)) };
    };
    const u = apply(userNow, clean(raw.user?.add), clean(raw.user?.remove), USER_MEMORY_MAX);
    const s = apply(simNow, clean(raw.sim?.add), clean(raw.sim?.remove), spec.manifest.memory?.max ?? 200);
    if (u.added.length || u.removed.length) this.setUserMemory(u.next);
    if (s.added.length || s.removed.length) this.setMemory(name, s.next);
    return { user: { added: u.added, removed: u.removed }, sim: { added: s.added, removed: s.removed } };
  }

  static isSafe(name: string) {
    return SAFE_NAME.test(name);
  }
}
