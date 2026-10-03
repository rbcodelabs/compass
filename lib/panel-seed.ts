/**
 * A tiny hand-off between a card and the detail panel it opens.
 *
 * The board already holds most of what the panel's header shows. Without this,
 * every open paints a skeleton until `/api/panels/entity/...` answers, which is
 * a session lookup, a membership lookup and a wide query in sequence. A card
 * stashes what it already knows here just before calling `openPanel`, and the
 * panel paints that immediately while the real fetch fills in the rest.
 *
 * Module-level on purpose: the seed is read once during the first render after
 * navigation, and must not cause re-renders of every panel consumer. It is a
 * paint hint only — the fetched payload always supersedes it.
 */
/** A seed older than this is ignored: it is a paint hint, never a cache. */
export const PANEL_SEED_TTL_MS = 10_000;

const seeds = new Map<string, { data: unknown; at: number }>();

// NUL cannot appear in a type or an id, so keys cannot collide.
const key = (type: string, id: string) => `${type}\u0000${id}`;

export function setPanelSeed<T>(type: string, id: string, data: T): void {
  seeds.set(key(type, id), { data, at: Date.now() });
}

export function peekPanelSeed<T>(type: string, id: string): T | undefined {
  const k = key(type, id);
  const hit = seeds.get(k);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PANEL_SEED_TTL_MS) {
    seeds.delete(k);
    return undefined;
  }
  return hit.data as T;
}

export function clearPanelSeed(type: string, id: string): void {
  seeds.delete(key(type, id));
}
