import { loadConfig, type AppConfig } from "./config.js";

let cached: AppConfig | null = null;

function get(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function getSettings(): { provider: string; port: number; host: string } {
  const c = get();
  return { provider: c.provider, port: c.port, host: c.host };
}

export function setProvider(provider: "claude" | "antigravity" | string): void {
  const c = get();
  (c as AppConfig).provider = provider as AppConfig["provider"];
}

export function resetCache(): void {
  cached = null;
}
