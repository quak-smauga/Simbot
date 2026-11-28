// ENV — jedno miejsce czytania process.env dla obu serwerów.
// Dwa korzenie:
//   REPO_ROOT  — gdzie jest KOD (apps/, plugins/, prompty). W Simbot.app to wnętrze paczki: tylko do odczytu.
//   QWE_HOME   — gdzie MIESZKA user: data/ (SQLite, pliki rozmów, profil przeglądarki), agents/ (simy), .env.
//                W repo = REPO_ROOT (jak dawniej). Simbot.app ustawia ~/Library/Application Support/simbot.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const QWE_HOME = resolve(process.env.QWE_HOME || REPO_ROOT);

export function loadDotenv(file = resolve(QWE_HOME, ".env")) {
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
  // ścieżki względne liczone od domu usera; QWE_AGENTS_DIR w .env domu = simy gdzie indziej (np. repo gita, Dropbox)
  const dataDir = resolve(QWE_HOME, env("QWE_DATA_DIR", "./data"));
  const agentsDir = resolve(QWE_HOME, env("QWE_AGENTS_DIR", "./agents"));
  const agentDir = env("QWE_AGENT_DIR") ? resolve(QWE_HOME, env("QWE_AGENT_DIR")) : resolve(agentsDir, "sima");
  ensureHome(dataDir, agentsDir);
  return {
    home: QWE_HOME,
    mock: MOCK,
    anthropicKey: env("ANTHROPIC_API_KEY"),
    chatModel: env("QWE_CHAT_MODEL", "claude-sonnet-5-5"),
    executorModel: env("QWE_EXECUTOR_MODEL", "claude-haiku-5-5"),
    chatMaxTokens: envNum("QWE_CHAT_MAX_TOKENS", 1200),
    chatThinking: envBool("QWE_CHAT_THINKING", false),
    ollamaUrl: env("QWE_OLLAMA_URL", "http://127.0.0.1:11434"),
    ollamaNumCtx: envNum("QWE_OLLAMA_NUM_CTX", 16384),
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

/**
 * Dom poza repo (Simbot.app): przy pierwszym starcie zakłada data/ i kopiuje domyślne simy z paczki.
 * Istniejących simów nigdy nie nadpisuje — aktualizacja aplikacji nie rusza tego, co user zmienił.
 */
export function ensureHome(dataDir: string, agentsDir: string) {
  if (QWE_HOME === REPO_ROOT) return;
  mkdirSync(dataDir, { recursive: true });
  const bundled = resolve(REPO_ROOT, "agents");
  if (!existsSync(agentsDir) && existsSync(bundled)) cpSync(bundled, agentsDir, { recursive: true });
}
