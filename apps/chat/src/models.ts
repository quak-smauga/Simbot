// MODELE — wybór LLM z UI (przycisk modelu pod polem wiadomości). Zapis w settings (klucz "llm"), przełączenie w locie
// w chat serverze i w agencie (AgentLink.setLlm).
//   GET  /api/llm                     wybór + dostawcy: Claude (lista stała, czy jest klucz) i Ollama (status, modele z capabilities)
//   PUT  /api/llm                     { chat: {provider, model}, tools?: {provider, model} | null }  (tools puste = ten sam model)
//   POST /api/llm/ollama/start        uruchom Ollamę (aplikacja na macu albo `ollama serve`)
//   POST /api/llm/ollama/pull         { model } → NDJSON z postępem: {status,total?,completed?} … {done:true} | {error}
// Start i pull tylko z naszego UI (fromOwnUi) — to uruchamia procesy i ściąga gigabajty.
import { ANTHROPIC_MODELS, json, readJson, type LlmProvider, type LlmSelection, type LlmSlot, type Router, type SwitchableLlm } from "@qwe/core";
import type { AgentLink } from "./agent-link.js";
import { fromOwnUi } from "./mcp.js";
import type { Store } from "./store.js";

export const LLM_SETTING = "llm";

export function registerModelRoutes(r: Router, d: { llm: SwitchableLlm; store: Store; link: AgentLink; hasAnthropicKey: boolean; mock: boolean; log: (level: "info" | "warn" | "error", m: string) => void }) {
  const { llm, store, link } = d;

  r.get("/api/llm", async (_q, res) => {
    const status = await llm.ollama.status();
    const models = status.running ? await llm.ollama.models().catch(() => []) : [];
    json(res, {
      mock: d.mock,
      selection: llm.selection(),
      chat: llm.caps("chat"),
      tools: llm.caps("tools"),
      anthropic: { available: d.hasAnthropicKey, models: ANTHROPIC_MODELS.map((m) => ({ ...m, vision: true })) },
      ollama: { ...status, models: models.map((m) => ({ id: m.id, label: m.id, size: m.size, params: m.params, family: m.family, vision: m.vision, ctx: m.ctx })) },
    });
  });

  r.put("/api/llm", async (q, res) => {
    try {
      const body = await readJson<{ chat?: { provider?: LlmProvider; model?: string }; tools?: { provider?: LlmProvider; model?: string } | null }>(q);
      if (!body.chat?.model) {
        // pusty wybór = powrót do modeli z env
        store.setSetting(LLM_SETTING, null);
        llm.select(null);
      } else {
        const sel: LlmSelection = { chat: await resolveSlot(body.chat), tools: body.tools?.model ? await resolveSlot(body.tools) : null };
        store.setSetting(LLM_SETTING, sel);
        llm.select(sel);
      }
      await link.setLlm(llm.selection());
      const c = llm.caps("chat");
      const t = llm.caps("tools");
      d.log("info", `[llm] rozmowa: ${c.provider}/${c.model} · zadania: ${t.provider}/${t.model}${t.vision ? "" : " (bez obrazów)"}`);
      json(res, { selection: llm.selection(), chat: c, tools: t });
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
  });

  r.post("/api/llm/ollama/start", async (q, res) => {
    if (!fromOwnUi(q)) return json(res, { error: "tylko z UI Simbota" }, 403);
    try {
      json(res, await llm.ollama.start());
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
  });

  r.post("/api/llm/ollama/pull", async (q, res) => {
    if (!fromOwnUi(q)) return json(res, { error: "tylko z UI Simbota" }, 403);
    const { model } = await readJson<{ model?: string }>(q);
    const name = (model ?? "").trim();
    if (!/^[\w.\-/:]+$/.test(name)) return json(res, { error: "zła nazwa modelu" }, 400);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
    try {
      let last = 0;
      await llm.ollama.pull(
        name,
        (p) => {
          // postęp co ~150 ms (Ollama sypie liniami bardzo gęsto)
          const now = Date.now();
          if (p.total && p.completed && p.completed < p.total && now - last < 150) return;
          last = now;
          line(p);
        },
        ac.signal,
      );
      d.log("info", `[llm] pobrano model ${name}`);
      line({ done: true });
    } catch (e) {
      if (!ac.signal.aborted) line({ error: (e as Error).message });
    }
    res.end();
  });

  /** {provider, model} → slot z tym, co model potrafi (vision, kontekst). Sprawdza, czy model jest dostępny. */
  async function resolveSlot(s: { provider?: LlmProvider; model?: string }): Promise<LlmSlot> {
    const model = (s.model ?? "").trim();
    if (s.provider === "ollama") {
      const info = await llm.ollama.show(model).catch(() => null);
      if (!info) throw new Error(`Ollama nie ma modelu ${model} — pobierz go albo uruchom Ollamę`);
      return { provider: "ollama", model, vision: info.capabilities.includes("vision"), ctx: info.ctx };
    }
    if (s.provider !== "anthropic") throw new Error(`nieznany dostawca: ${s.provider}`);
    if (!/^claude-[\w.-]+$/.test(model)) throw new Error(`nieznany model Claude: ${model}`);
    if (!d.hasAnthropicKey && !d.mock) throw new Error("brak ANTHROPIC_API_KEY — Claude niedostępny");
    return { provider: "anthropic", model, vision: true, ctx: ANTHROPIC_MODELS.find((m) => m.id === model)?.ctx ?? 200_000 };
  }
}
