/**
 * Serving a v0 chat's running app inside Compass.
 *
 * v0 previews cannot be framed directly: `<slug>.v0.build` redirects to v0's
 * sign-in unless the request carries a session or an `x-v0-preview-token`
 * header, and v0.app's `frame-ancestors` excludes Compass. The token can only
 * travel as a header, so a browser iframe cannot send it. Compass therefore
 * forwards the requests server-side (the same shape as v0's own clone example)
 * from a separate host, `V0_PREVIEW_HOST`, attached to this same deployment.
 *
 * Why a separate host: the previewed app is code v0 generated, so it must not
 * share an origin with Compass. On that host nothing but `/p/<ticket>/…` is
 * served, so it has no Compass session cookies, pages or APIs.
 *
 * The `<ticket>` is the preview's URL + token + expiry, encrypted with
 * `V0_PREVIEW_TICKET_KEY` (AES-256-GCM, tamper-evident). The page that mints it
 * has already fetched the preview with the viewer's own v0 grant, so holding a
 * ticket is holding that short-lived preview and nothing else. A ticket can
 * only ever be aimed at v0's own preview hosts.
 */
import { decrypt, encrypt } from "@/lib/crypto-secrets"

/** Only ever forward to v0's own preview hosts, whatever a connector returns. */
export const V0_PREVIEW_UPSTREAM_HOST = /\.(?:v0\.build|vusercontent\.net)$/i

/** Longest a ticket (and so a framed preview) lives, whatever v0's token says. */
export const V0_PREVIEW_TICKET_MAX_MS = 60 * 60_000

const TICKET_PATH = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/

export interface V0PreviewTicket {
  /** The preview's origin, e.g. https://slug.v0.build */
  upstream: string
  /** Sent upstream as `x-v0-preview-token`. */
  token: string | null
  /** Epoch ms after which the ticket is refused. */
  expiresAt: number
  /** The Compass origin allowed to frame the preview. */
  embedder: string
}

export interface V0PreviewSource {
  url: string
  token: string | null
  expiresAt: string | null
}

/** The host that serves previews, or null when the feature is not configured. */
export function previewHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.V0_PREVIEW_HOST?.trim().toLowerCase()
  return host && /^[a-z0-9.-]+(?::\d+)?$/.test(host) ? host : null
}

function ticketKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.V0_PREVIEW_TICKET_KEY?.trim() || null
}

const toBase64Url = (value: string) => value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const fromBase64Url = (value: string) => value.replace(/-/g, "+").replace(/_/g, "/")

/** An https origin, or http on localhost. Null for anything else. */
export function normalizeEmbedder(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null
    if (url.username || url.password) return null
    return url.origin
  } catch { return null }
}

export function mintPreviewTicket(source: V0PreviewSource, embedder: string | null | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const key = ticketKey(env)
  const origin = normalizeEmbedder(embedder)
  if (!key || !origin) return null
  let upstream: URL
  try { upstream = new URL(source.url) } catch { return null }
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || !V0_PREVIEW_UPSTREAM_HOST.test(upstream.hostname)) return null
  const reported = source.expiresAt ? Date.parse(source.expiresAt) : NaN
  const expiresAt = Math.min(now + V0_PREVIEW_TICKET_MAX_MS, Number.isFinite(reported) ? reported : Infinity)
  if (expiresAt <= now) return null
  const payload: V0PreviewTicket = { upstream: upstream.origin, token: source.token, expiresAt, embedder: origin }
  try { return toBase64Url(encrypt(JSON.stringify(payload), key)) } catch { return null }
}

export type OpenedTicket = { ok: true; ticket: V0PreviewTicket } | { ok: false; reason: "invalid" | "expired" }

export function openPreviewTicket(ticket: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): OpenedTicket {
  const key = ticketKey(env)
  if (!key) return { ok: false, reason: "invalid" }
  try {
    const parsed = JSON.parse(decrypt(fromBase64Url(ticket), key)) as Partial<V0PreviewTicket>
    const upstream = typeof parsed.upstream === "string" ? new URL(parsed.upstream) : null
    const embedder = normalizeEmbedder(parsed.embedder)
    if (!upstream || !embedder || typeof parsed.expiresAt !== "number") return { ok: false, reason: "invalid" }
    if (upstream.protocol !== "https:" || upstream.origin !== parsed.upstream || !V0_PREVIEW_UPSTREAM_HOST.test(upstream.hostname)) return { ok: false, reason: "invalid" }
    if (parsed.expiresAt <= now) return { ok: false, reason: "expired" }
    const token = typeof parsed.token === "string" && parsed.token ? parsed.token : null
    return { ok: true, ticket: { upstream: upstream.origin, token, expiresAt: parsed.expiresAt, embedder } }
  } catch { return { ok: false, reason: "invalid" } }
}

/** The iframe `src` for a preview, or null when previews are not configured. */
export function previewFrameSrc(source: V0PreviewSource, embedder: string | null | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const host = previewHost(env)
  if (!host) return null
  const ticket = mintPreviewTicket(source, embedder, now, env)
  if (!ticket) return null
  // No trailing slash: Next 308s `/p/<t>/` to `/p/<t>` before the proxy runs.
  return `${host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"}://${host}/p/${ticket}`
}

/** `/p/<ticket>/rest` → the ticket and the path to request upstream. */
export function parseTicketPath(pathname: string): { ticket: string; rest: string } | null {
  const match = TICKET_PATH.exec(pathname)
  return match ? { ticket: match[1], rest: match[2] ?? "/" } : null
}

/**
 * A root-relative request from inside a framed preview (`/_next/static/…`) has
 * lost its `/p/<ticket>` prefix. Its Referer still names the framed document, so
 * recover the prefix from there. Same host only.
 */
export function ticketPrefixFromReferer(referer: string | null, host: string): string | null {
  if (!referer) return null
  try {
    const url = new URL(referer)
    if (url.host.toLowerCase() !== host.toLowerCase()) return null
    const parsed = parseTicketPath(url.pathname)
    return parsed ? `/p/${parsed.ticket}` : null
  } catch { return null }
}

const DROP_REQUEST_HEADERS = new Set([
  "host", "cookie", "authorization", "connection", "content-length", "transfer-encoding", "upgrade",
  "forwarded", "x-real-ip", "x-matched-path", "x-invoke-path", "x-invoke-query", "x-middleware-rewrite",
  "x-v0-preview-token", "x-v0-preview-refresh",
])
const DROP_REQUEST_PREFIXES = ["x-forwarded-", "x-vercel-", "x-nextjs-", "x-middleware-"]

export function upstreamRequestHeaders(incoming: Headers, ticket: V0PreviewTicket): Headers {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (DROP_REQUEST_HEADERS.has(lower) || DROP_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix))) return
    // The Referer would carry the ticket; Origin would name the Compass preview host.
    // Both are rewritten to the upstream's own origin so its CSRF checks see a same-origin call.
    if (lower === "referer") { headers.set(name, `${ticket.upstream}/`); return }
    if (lower === "origin") { headers.set(name, ticket.upstream); return }
    headers.set(name, value)
  })
  if (ticket.token) headers.set("x-v0-preview-token", ticket.token)
  return headers
}

const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
  // A preload Link carries root-relative URLs that would skip the /p/<ticket> prefix.
  "link",
  "x-frame-options", "content-security-policy", "content-security-policy-report-only",
  "strict-transport-security", "public-key-pins", "clear-site-data", "report-to", "nel",
])

/** Upstream's CSP, minus `frame-ancestors`, plus ours. */
function framingPolicy(upstreamCsp: string | null, embedder: string): string {
  const kept = (upstreamCsp ?? "").split(";").map((part) => part.trim()).filter((part) => part && !/^frame-ancestors(\s|$)/i.test(part))
  return [...kept, `frame-ancestors ${embedder}`].join("; ")
}

/** A `Location` from upstream, aimed back through the ticket prefix. Null = leave the frame. */
export function rewriteLocation(location: string, ticket: V0PreviewTicket, prefix: string): string | null {
  let target: URL
  try { target = new URL(location, `${ticket.upstream}/`) } catch { return null }
  if (target.origin !== ticket.upstream) return null
  return `${prefix}${target.pathname}${target.search}${target.hash}`
}

export function expiredPreviewResponse(embedder: string | null, status = 410): Response {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preview expired</title><body style="font:14px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;color:#555;text-align:center"><p>This preview has expired.<br>Reload the Compass page to start a fresh one.</p></body>`
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex" })
  headers.set("content-security-policy", framingPolicy(null, embedder ?? "'none'"))
  return new Response(body, { status, headers })
}

/**
 * Forward one request to the ticket's preview and return a response that is safe
 * to frame from the ticket's embedder. Never follows a redirect itself: a hop to
 * v0's sign-in means the token no longer works, which is reported as "expired".
 */
export async function forwardPreviewRequest(req: Request, ticket: V0PreviewTicket, prefix: string, rest: string, search: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const target = new URL(`${rest.startsWith("/") ? rest : `/${rest}`}${search}`, ticket.upstream)
  // `rest` is attacker-shaped (`//evil`, `/\evil`): refuse anything that leaves the preview origin.
  if (target.origin !== ticket.upstream) return new Response("Bad request", { status: 400 })

  if (req.headers.get("x-v0-preview-refresh") === "1") return expiredPreviewResponse(ticket.embedder)

  const method = req.method.toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD" && req.body !== null
  let upstream: Response
  try {
    upstream = await fetchImpl(target, {
      method,
      headers: upstreamRequestHeaders(req.headers, ticket),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
    } as RequestInit)
  } catch {
    return new Response("The v0 preview could not be reached.", { status: 502, headers: { "cache-control": "private, no-store" } })
  }

  const headers = new Headers()
  upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value) })

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location")
    const inside = location ? rewriteLocation(location, ticket, prefix) : null
    if (!inside) {
      // Redirected off the preview: v0's sign-in, i.e. the token stopped working.
      await upstream.body?.cancel().catch(() => undefined)
      return expiredPreviewResponse(ticket.embedder)
    }
    headers.set("location", inside)
  }

  headers.set("content-security-policy", framingPolicy(upstream.headers.get("content-security-policy"), ticket.embedder))
  headers.set("cache-control", "private, no-store")
  headers.set("referrer-policy", "same-origin")
  headers.set("x-robots-tag", "noindex")
  headers.set("x-content-type-options", "nosniff")
  // Keep the response from carrying anything the preview could use to probe the viewer's browser.
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()")
  const noBody = method === "HEAD" || upstream.status === 204 || upstream.status === 304
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers })
}
