// @qwe/plugin-skills — skill.save: bot zapisuje workflow do agents/<bot>/skills/<name>.md.
// Event skill.saved → chat przeładowuje prompt bota. Capability nie wie, czy wywołał ją direct czy plan.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeSkill, type CapabilityContext, type CapabilityDescriptor, type ToolMap } from "@qwe/core";

export const descriptor: Partial<CapabilityDescriptor> = { name: "skills" };

export function create(ctx: CapabilityContext): ToolMap {
  return {
    "skill.save": async (args, call) => {
      const name = (args.name ?? "").trim().toLowerCase();
      const body = (args._ ?? "").trim();
      if (!call.agent) return { ok: false, text: "Brak bota w kontekście — skill nie wie, gdzie się zapisać." };
      if (!name || !body) return { ok: false, text: "Podaj name=\"…\" i treść skilla." };
      const dir = join(ctx.agentsDir, call.agent);
      if (!existsSync(join(dir, "AgentManifest.yaml"))) return { ok: false, text: `Nie ma bota "${call.agent}" w ${ctx.agentsDir}.` };
      try {
        const m = readManifest(dir);
        const path = writeSkill(dir, m, name, body, { description: args.description ?? "" });
        call.emit("skill.saved", { agent: call.agent, name, description: args.description ?? "", path, chars: body.length });
        ctx.log("info", `[skills] ${call.agent}: zapisano skill "${name}" (${body.length} zn.)`);
        return { ok: true, text: `Zapisano skill "${name}" dla bota ${call.agent}. Od następnej tury jest w prompcie.`, data: { name, path } };
      } catch (e) {
        return { ok: false, text: `Nie zapisałem skilla: ${(e as Error).message}` };
      }
    },
  };
}
