// Eventy rozmowy (in-process bus). Tor użytkownika: mic.audio → vad → user.utterance → stt → user.text → dispatch (@).
// Tor sima: bot.turn → say.* (+ voice.*) | tool.call → (agent server: task.*, plan.*, step.*, computer.*, web.*) → tool.result → sim.
// W rozmowie może być wielu simów — eventy sima niosą `bot` (kto mówi / pracuje).
// Eventy z agent servera przychodzą SSE i są re-emitowane 1:1 pod swoją nazwą (payload = AgentEvent).
import type { FoundConversation } from "./recall.js";
import type { AgentEvent, EventBus, MentionAction } from "@qwe/core";
import type { VoiceEvents } from "@qwe/voice";

export type AgentState = "idle" | "listening" | "thinking" | "speaking" | "working" | "waiting_user";

export interface ChatEvents extends VoiceEvents {
  // ── użytkownik ──
  "user.utterance": { pcm: Buffer; sampleRate: number; durationMs: number };
  /** VAD zamknął wypowiedź — UI mruga, zanim przyjdzie transkrypcja. */
  "user.heard": { durationMs: number };
  "user.text": { text: string; source: "stt" | "typed"; messageId?: string; author: string };
  "user.level": { rms: number; speaking: boolean };
  "user.interrupt": {};
  "user.command": { command: string; text: string };

  // ── simy ──
  /** Stan rozmowy jako całości (do kropki / chipa) + który sim to powoduje. */
  "agent.state": { state: AgentState; taskId?: string; bot?: string };
  /** Sim zaczyna turę (po @ albo jako prowadzący). `by` = kto go zawołał (user albo inny sim). */
  "bot.turn": { bot: string; action: MentionAction; by: string; joined?: boolean };
  /** User wspomniał simy, których nie ma w rozmowie — nie odpowiadają; UI proponuje „dodaj”. */
  "mention.absent": { names: string[] };
  "agent.thinking": { turn: number; bot: string };
  "agent.error": { message: string; bot?: string };
  "assistant.message": { messageId: string; text: string; bot: string };
  /** Sim zawołał usera (@imię) — powiadomienie. */
  "mention.user": { bot: string; text: string; messageId: string };

  // ── narzędzia (po stronie chatu: wywołanie → task w agent serverze → wynik) ──
  "tool.call": { callId: string; taskId?: string; block: unknown; bot: string };
  "tool.result": { callId: string; taskId?: string; ok: boolean; ms: number; text: string; bot: string; /** lokalne narzędzia (memory.search): co znaleziono — do rozwijanej karty w UI */ found?: FoundConversation[] };

  // ── z agent servera (mirror) — nazwa = e.type, payload = cała koperta ──
  "agent.event": AgentEvent;

  // ── rozmowa ──
  "session.voice": { on: boolean };
  /** Tytuł: `pending` zanim LLM odpowie (UI pokazuje skeleton), potem emoji + tytuł. */
  "session.title": { title: string; emoji?: string; pending?: boolean };
  "session.reset": {};
  /** Skład rozmowy się zmienił (ktoś dołączył przez @, dodany ręcznie, usunięty). */
  "session.members": { members: string[]; joined?: string; left?: string; /** kto dodał: slug usera albo nazwa sima (@ w łańcuchu) */ by?: string };
  /** Workflow rozmowy zmieniony. */
  "session.workflow": { workflowId: string | null; name?: string };
  /** Pamięć sima po turze (async): co doszło / co wyleciało. */
  /** scope: user = wspólna pamięć o userze (wszystkie simy), sim = notatki tego sima. */
  "memory.saved": { agent: string; scope?: "user" | "sim"; added: string[]; removed: string[] };
}

export type ChatBus = EventBus<ChatEvents>;
