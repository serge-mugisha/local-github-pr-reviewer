import type { Provider } from "./types.js";
import { claudeProvider } from "./claude.js";
import { antigravityProvider } from "./antigravity.js";
import { codexProvider } from "./codex.js";

const REGISTRY: Record<string, Provider> = {
  [claudeProvider.id]: claudeProvider,
  [antigravityProvider.id]: antigravityProvider,
  [codexProvider.id]: codexProvider,
};

const ALIASES: Record<string, string> = {
  agy: antigravityProvider.id,
  gemini: antigravityProvider.id,
};

export function getProvider(id: string): Provider {
  const p = REGISTRY[ALIASES[id] ?? id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function listProviders(): Provider[] {
  return Object.values(REGISTRY);
}

export async function listProviderStatus(): Promise<
  { id: string; displayName: string; available: boolean }[]
> {
  return Promise.all(
    listProviders().map(async (p) => ({
      id: p.id,
      displayName: p.displayName,
      available: await p.isAvailable(),
    })),
  );
}

export type { Provider } from "./types.js";
