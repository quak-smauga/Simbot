// @qwe/mcp — klient Model Context Protocol i menedżer wielu serwerów (proces agenta).
// Modele, konfiguracja i prompt są w @qwe/core (mcp.ts) — potrzebuje ich też chat, który klienta nie uruchamia.
export { McpClient, McpError, PROTOCOL_VERSION } from "./client.js";
export type { McpClientOptions, InitializeResult } from "./client.js";
export { McpManager } from "./manager.js";
export type { McpManagerOptions } from "./manager.js";
