// WS GATEWAY — lustro bus rozmowy ↔ przeglądarka. Klient wybiera rozmowę (?session=…); wiele kart może patrzeć na jedną.
//   serwer → klient: JSON {t:"<event>", ...payload}; voice.chunk jako ramka binarna (packVoice)
//   klient → serwer: binarnie = PCM s16le 16k z mikrofonu; JSON {t:"text"|"voice"|"played"|"interrupt"|"reset"|"control"}
// Lobby (?session=lobby): zmiany na liście rozmów, powiadomienia (@user), stan agenta — dla sidebara, niezależnie od otwartej rozmowy.
import type { IncomingMessage } from "node:http";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentEvent } from "@qwe/core";
import type { ChatEvents } from "./events.js";
import type { SessionHub } from "./hub.js";

const MIRROR = new Set<keyof ChatEvents>([
  "agent.state", "agent.thinking", "agent.error", "bot.turn", "mention.user",
  "say.start", "say.text", "say.end", "voice.end",
  "tool.call", "tool.result",
  "user.text", "user.heard", "user.level", "user.command",
  "assistant.message", "session.voice", "session.title", "session.members", "session.workflow", "memory.saved", "log", "mention.absent", "chain.limit",
]);

/** [u8 magic=1][u32 seq][u32 sampleRate][u8 idLen][id][pcm] */
export function packVoice(p: ChatEvents["voice.chunk"]): Buffer {
  const id = Buffer.from(p.sayId, "utf8");
  const head = Buffer.alloc(10 + id.length);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(p.seq, 1);
  head.writeUInt32LE(p.sampleRate, 5);
  head.writeUInt8(id.length, 9);
  id.copy(head, 10);
  return Buffer.concat([head, p.pcm]);
}

export function attachWs(wss: WebSocketServer, hub: SessionHub) {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://x");
    const sessionId = url.searchParams.get("session");
    const send = (obj: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

    if (sessionId === "lobby") {
      const offs = [
        hub.lobby.on("session.updated", (p) => send({ t: "session.updated", ...p })),
        hub.lobby.on("session.removed", (p) => send({ t: "session.removed", ...p })),
        hub.lobby.on("notify", (p) => send({ t: "notify", ...p })),
        hub.lobby.on("agent.status", (p) => send({ t: "agent.status", ...p })),
        hub.lobby.on("mcp.status", (p) => send({ t: "mcp.status", ...p })),
      ];
      send({ t: "hello", lobby: true, agent: hub.link.status });
      ws.on("close", () => offs.forEach((off) => off()));
      return;
    }

    const session = sessionId ? hub.open(sessionId) : null;
    if (!session) {
      send({ t: "error", message: "nieznana rozmowa" });
      ws.close();
      return;
    }
    session.clients++;
    hub.store.markRead(session.id);
    hub.announce(session.id);
    const { bus } = session;
    let levelT = 0;

    const offs = [
      bus.onAny((name, payload) => {
        if (name === "agent.event") {
          const e = payload as AgentEvent;
          send({ t: e.type, agent: true, seq: e.seq, at: e.at, taskId: e.taskId, stepId: e.stepId, planId: e.planId, ...e.data });
          return;
        }
        if (!MIRROR.has(name as keyof ChatEvents)) return;
        if (name === "user.level") {
          const now = Date.now();
          if (now - levelT < 100) return; // 33 ramki/s to za dużo dla UI — 10/s wystarczy
          levelT = now;
        }
        if (name === "tool.result") {
          const p = payload as ChatEvents["tool.result"];
          send({ t: name, callId: p.callId, taskId: p.taskId, ok: p.ok, ms: p.ms, bot: p.bot, found: p.found });
          return;
        }
        send({ t: name, ...(payload as object) });
      }),
      bus.on("voice.chunk", (p) => ws.readyState === WebSocket.OPEN && ws.send(packVoice(p))),
    ];

    const wf = session.workflow;
    send({
      t: "hello",
      sessionId: session.id,
      state: session.getState(),
      voice: session.voice.enabled,
      members: session.members,
      workflow: wf ? { id: wf.id, name: wf.name } : null,
      mock: hub.mock,
      sampleRate: hub.voiceCfg.micSampleRate,
      ttsSampleRate: hub.voiceCfg.ttsSampleRate,
      agentUrl: hub.link.url,
      activeTaskId: session.activeTaskId,
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.pushAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      let msg: { t?: string; text?: string; files?: string[]; on?: boolean; sayId?: string; op?: "pause" | "resume" | "cancel"; taskId?: string; bot?: string; workflowId?: string | null };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        switch (msg.t) {
          case "text": {
            const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === "string").slice(0, 50) : [];
            if (msg.text?.trim() || files.length) session.sendText((msg.text ?? "").trim(), files);
            break;
          }
          case "voice":
            bus.emit("session.voice", { on: !!msg.on });
            break;
          case "played":
            if (msg.sayId) bus.emit("voice.played", { sayId: msg.sayId });
            break;
          case "interrupt":
            bus.emit("user.interrupt", {});
            break;
          case "reset":
            bus.emit("session.reset", {});
            break;
          case "member.add":
            if (msg.bot) session.addMember(msg.bot);
            break;
          case "lead":
            if (msg.bot) session.setLead(msg.bot);
            break;
          case "chain.continue":
            session.continueChain();
            break;
          case "member.remove":
            if (msg.bot) session.removeMember(msg.bot);
            break;
          case "workflow":
            session.setWorkflow(msg.workflowId ?? null);
            break;
          case "control":
            if (msg.op) void session.control(msg.op, msg.taskId).then((r) => send({ t: "control.result", op: msg.op, ...r }));
            break;
        }
      } catch (e) {
        send({ t: "error", message: (e as Error).message });
      }
    });
    ws.on("close", () => {
      offs.forEach((off) => off());
      session.clients--;
      // rozmowa żyje dalej (task w tle, historia w bazie); tylko audio klienta nas już nie obchodzi
      if (!session.clients) session.vad.reset();
    });
  });
}
