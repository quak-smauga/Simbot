// pantry.list — czyta agents/<sim>/pantry.txt (jedna linia = jeden produkt). Opis krok po kroku: docs, „Napisz własną capability”.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function create(ctx) {
  return {
    "pantry.list": async (args, call) => {
      call.emit("pantry.started", { category: args._ });
      const file = join(ctx.agentsDir, call.agent ?? "kucharz", "pantry.txt");
      const lines = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
      const hit = args._ ? lines.filter((l) => l.includes(args._)) : lines;
      return { ok: true, text: hit.join("\n") || "Spiżarnia pusta.", data: { count: hit.length } };
    },
  };
}
