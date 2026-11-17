/**
 * Which forwarded headers Compass believes.
 *
 * A forwarded header is only evidence of the real client when the proxy in
 * front of the app overwrites or appends to it. Anything the client can set
 * and the proxy leaves alone is attacker input. Which headers are safe depends
 * on what sits in front of Compass, so that is explicit configuration:
 *
 *   COMPASS_TRUSTED_PROXY=vercel (default)
 *     The Vercel edge. Client address: `x-real-ip`, else the first
 *     `x-forwarded-for` entry. Host: `x-forwarded-host`, else `host`.
 *     Protocol: `x-forwarded-proto`. This is the behaviour Compass has always had.
 *
 *   COMPASS_TRUSTED_PROXY=alb
 *     An AWS Application Load Balancer. The ALB appends the address of the peer
 *     that connected to it to the RIGHT end of `x-forwarded-for`; everything to
 *     the left is whatever the client sent and is spoofable. So the client
 *     address is the right-most entry, or the Nth from the right when
 *     COMPASS_TRUSTED_PROXY_HOPS=N says N proxies (for example CloudFront then
 *     the ALB, N=2) append to the header. `x-real-ip` and `x-forwarded-host`
 *     are NOT set by an ALB, so a client can send them: both are ignored, and
 *     the host is the `host` header. `x-forwarded-proto` is set by the ALB and
 *     is trusted.
 *
 *   COMPASS_TRUSTED_PROXY=none
 *     Compass is reached directly, or through something that is not understood.
 *     No forwarded header is trusted. Every client shares the address
 *     "unknown", which makes per-address limits stricter, never weaker.
 *
 * An unrecognised value throws rather than falling back, because the fallback
 * would be the trusting mode.
 */
export type TrustedProxy = "vercel" | "alb" | "none"

type EnvSource = Record<string, string | undefined>
/** `Headers` and Next's `ReadonlyHeaders` both satisfy this. */
type HeaderReader = { get(name: string): string | null }

const MODES: readonly TrustedProxy[] = ["vercel", "alb", "none"]

export function trustedProxy(env: EnvSource = process.env): TrustedProxy {
  const value = env.COMPASS_TRUSTED_PROXY?.trim()
  if (!value) return "vercel"
  if ((MODES as readonly string[]).includes(value)) return value as TrustedProxy
  throw new Error(`COMPASS_TRUSTED_PROXY must be one of ${MODES.join(", ")} (got "${value}").`)
}

function albHops(env: EnvSource): number {
  const raw = env.COMPASS_TRUSTED_PROXY_HOPS?.trim()
  if (!raw) return 1
  if (!/^[1-9]\d?$/.test(raw)) throw new Error(`COMPASS_TRUSTED_PROXY_HOPS must be a whole number from 1 to 99 (got "${raw}").`)
  return Number(raw)
}

/** The client's address as far as the trusted proxy can tell, or "unknown". */
export function clientAddressFromHeaders(headers: HeaderReader, env: EnvSource = process.env): string {
  const mode = trustedProxy(env)
  if (mode === "none") return "unknown"

  if (mode === "vercel") {
    const realIp = headers.get("x-real-ip")
    if (realIp) return realIp.trim()
    const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    return first || "unknown"
  }

  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) return "unknown"
  // Nth from the right, clamped to the left-most entry when fewer proxies than
  // configured actually appended (a request that skipped the outer proxy). Every
  // entry at or right of that index was appended by a proxy we run.
  return entries[Math.max(0, entries.length - albHops(env))]
}

/** The host the browser used, for same-origin checks and embedder origins. */
export function requestHostFromHeaders(headers: HeaderReader, env: EnvSource = process.env): string | null {
  if (trustedProxy(env) === "vercel") return headers.get("x-forwarded-host") ?? headers.get("host")
  return headers.get("host")
}

/** The protocol the browser used, or null when no trusted header says. */
export function requestProtoFromHeaders(headers: HeaderReader, env: EnvSource = process.env): string | null {
  return trustedProxy(env) === "none" ? null : headers.get("x-forwarded-proto")
}
