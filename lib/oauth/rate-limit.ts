/**
 * Per-IP rate limiting for `POST /api/oauth/register`.
 *
 * ## What this is, honestly
 *
 * A fixed-size in-memory sliding window, per serverless instance. It is **not**
 * a distributed rate limiter: Vercel runs many instances, so the effective
 * global ceiling is the per-instance cap times however many instances are warm,
 * and a cold start resets a caller's window.
 *
 * That is a deliberate choice, not an oversight. Dynamic client registration is
 * unauthenticated by design (decision 2 — registration happens before any user
 * exists, so there is no session to gate on), which means the only durable
 * alternative is a database-backed counter, and that needs a table this phase's
 * migration does not have. Weighed against the actual threat — registration
 * writes one bounded row and grants nothing until a human approves a consent
 * screen — a per-instance speed bump that stops a naive loop is worth having
 * now, and a shared counter is worth adding alongside the TTL pruning that
 * phase 2 already schedules.
 *
 * The expected legitimate volume is one registration per Geode install, ever.
 */

/** Requests allowed per IP per window, per instance. */
const MAX_REGISTRATIONS_PER_WINDOW = 10
const WINDOW_MS = 60 * 60 * 1000
/**
 * Caps the tracking map itself, so a flood of distinct source addresses evicts
 * old entries instead of growing memory without bound — the limiter must not
 * become the thing that takes the instance down.
 */
const MAX_TRACKED_KEYS = 5_000

const hits = new Map<string, number[]>()

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the caller's oldest hit falls out of the window. */
  retryAfterSeconds: number
}

/**
 * Records an attempt from `key` and reports whether it is allowed.
 *
 * Counts the attempt whether or not it succeeds. Only counting *successful*
 * registrations would let an attacker probe validation as fast as it liked by
 * sending bodies that fail.
 */
export function checkRegistrationRateLimit(
  key: string,
  now: number = Date.now(),
): RateLimitDecision {
  const cutoff = now - WINDOW_MS
  const recent = (hits.get(key) ?? []).filter((at) => at > cutoff)

  if (recent.length >= MAX_REGISTRATIONS_PER_WINDOW) {
    hits.set(key, recent)
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] - cutoff) / 1000))
    return { allowed: false, retryAfterSeconds }
  }

  recent.push(now)
  hits.set(key, recent)
  if (hits.size > MAX_TRACKED_KEYS) evictStale(cutoff)
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Test seam. Never called by the routes. */
export function resetRegistrationRateLimit(): void {
  hits.clear()
}

/**
 * The client address, from the proxy headers Vercel sets.
 *
 * `x-forwarded-for` is attacker-controllable in general, but on Vercel the edge
 * rewrites it, so the *last* entry is not trustworthy while the platform's own
 * `x-real-ip` is. Preferring `x-real-ip` and falling back to the **first**
 * `x-forwarded-for` entry is the usual compromise; a caller who successfully
 * spoofs it only gives themselves a different bucket in a per-instance limiter,
 * which is why this is not load-bearing security.
 */
export function clientAddress(request: Request): string {
  const realIp = request.headers.get("x-real-ip")
  if (realIp) return realIp.trim()
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return "unknown"
}

function evictStale(cutoff: number): void {
  for (const [key, timestamps] of hits) {
    const live = timestamps.filter((at) => at > cutoff)
    if (live.length === 0) hits.delete(key)
    else hits.set(key, live)
  }
  // Still oversized after dropping expired entries: drop oldest-inserted keys.
  // Map iteration is insertion-ordered, so this is the closest thing to an LRU
  // that does not need a second data structure.
  if (hits.size > MAX_TRACKED_KEYS) {
    const excess = hits.size - MAX_TRACKED_KEYS
    let dropped = 0
    for (const key of hits.keys()) {
      hits.delete(key)
      if (++dropped >= excess) break
    }
  }
}
