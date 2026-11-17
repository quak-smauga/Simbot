// sh — uruchom proces i przekaż jego stdio (docker, node). Rzuca przy niezerowym kodzie.
import { spawn, type SpawnOptions } from "node:child_process";

export function sh(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", (e) => reject(new Error(`${cmd}: ${e.message} (jest zainstalowany?)`)));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ""} zakończył się kodem ${code}`))));
  });
}

export function shOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.on("error", (e) => reject(e));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} → ${code}`))));
  });
}
