// ENV — jedno miejsce czytania process.env dla obu serwerów. `.env` ładujemy z korzenia repo (jeśli jest).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export function loadDotenv(file = resolve(REPO_ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line.replace(/\s+#.*$/, ""));
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

export const MOCK = process.argv.includes("--mock") || process.env.QWE_MOCK === "1";

export const env = (name: string, fallback = "") => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};
export const envNum = (name: string, fallback: number) => Number(env(name, String(fallback)));
export const envBool = (name: string, fallback: boolean) => {
  const v = env(name, fallback ? "1" : "0").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
};

export function commonConfig() {
  loadDotenv();
  const dataDir = resolve(REPO_ROOT, env("QWE_DATA_DIR", "./data"));
  const agentsDir = resolve(REPO_ROOT, env("QWE_AGENTS_DIR", "./agents"));
  const agentDir = resolve(REPO_ROOT, env("QWE_AGENT_DIR", "./agents/sima"));
  return {
    mock: MOCK,
    anthropicKey: env("ANTHROPIC_API_KEY"),
    chatModel: env("QWE_CHAT_MODEL", "claude-sonnet-5-5"),
    executorModel: env("QWE_EXECUTOR_MODEL", "claude-haiku-5-5"),
    chatMaxTokens: envNum("QWE_CHAT_MAX_TOKENS", 1200),
    chatThinking: envBool("QWE_CHAT_THINKING", false),
    host: env("QWE_HOST", "127.0.0.1"),
    chatPort: envNum("QWE_CHAT_PORT", 3100),
    agentPort: envNum("QWE_AGENT_PORT", 7777),
    agentMode: env("QWE_AGENT_MODE", "spawn") as "spawn" | "url",
    agentUrl: env("QWE_AGENT_URL", `http://127.0.0.1:${envNum("QWE_AGENT_PORT", 7777)}`),
    agentDir,
    agentsDir,
    defaultAgent: env("QWE_DEFAULT_AGENT", "sima"),
    dataDir,
  };
}
