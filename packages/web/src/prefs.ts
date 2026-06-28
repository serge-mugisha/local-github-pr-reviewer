/**
 * Persistent user preferences, stored in localStorage. Subscribers are
 * notified on change so multiple components stay in sync.
 *
 * Add a new pref by extending `Prefs`, `DEFAULTS`, and `isValidValue` below.
 * Anything else (read, write, subscribe) is generic.
 */

export type ViewMode = "unified" | "split";

export interface Prefs {
  viewMode: ViewMode;
  sidenavCollapsed: boolean;
  collapsedRepoIds: number[];
}

const DEFAULTS: Prefs = {
  viewMode: "unified",
  sidenavCollapsed: false,
  collapsedRepoIds: [],
};

const STORAGE_KEY = "reviewer.prefs";

type Listener = (prefs: Prefs) => void;
const listeners = new Set<Listener>();

function isPrefs(v: unknown): v is Partial<Prefs> {
  return typeof v === "object" && v !== null;
}

function readRaw(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isPrefs(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

let cached: Prefs | null = null;

export function getPrefs(): Prefs {
  if (cached) return cached;
  cached = { ...DEFAULTS, ...readRaw() };
  return cached;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...getPrefs(), [key]: value };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be full or disabled (private mode). Silently degrade —
    // the in-memory cache still serves this session.
  }
  for (const fn of listeners) fn(next);
}

export function subscribePrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
