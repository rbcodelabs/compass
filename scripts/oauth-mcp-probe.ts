#!/usr/bin/env node
/**
 * End-to-end integration probe for Compass's MCP OAuth handshake.
 *
 * This walks the **real** chain against a running deployment, in the order a
 * real client walks it — which is the point. Unit tests can prove each piece in
 * isolation and still miss the things that actually break a connection: a
 * metadata document served at one URL but not the other, an `issuer` that does
 * not byte-match the URL it was discovered from, a challenge header missing the
 * one parameter that decides how much consent gets requested.
 *
 *   1. POST /api/mcp with no token   → 401 challenge, `resource_metadata` + `scope`
 *   2. Protected-resource metadata   → path-inserted and root URLs, byte-identical
 *   3. Authorization-server metadata → both well-known URLs, `issuer` byte-matches
 *   4. POST /api/oauth/register      → DCR, public client, loopback redirect
 *   5. GET /oauth/authorize          → consent, then `code` + `state` + `iss`
 *   6. POST /api/oauth/token         → exchange the code (PKCE S256)
 *   7. POST /api/mcp `initialize`    → the access token actually works
 *   8. Audience enforcement          → a foreign-`resource` token is refused
 *   9. Scope enforcement             → a read-only token gets a real 403
 *
 * ## Running it
 *
 *   node scripts/oauth-mcp-probe.ts                       # http://localhost:3000
 *   node scripts/oauth-mcp-probe.ts --base-url https://…  # preview or production
 *
 * Step 5 needs an authenticated browser session, because `/oauth/authorize` is
 * deliberately *not* a public path — an authorization endpoint that issues a
 * code without knowing who the user is would be the worst bug in this system.
 * Two ways to supply one, checked in order:
 *
 *   COMPASS_PROBE_SESSION_COOKIE="authjs.session-token=…"
 *       A cookie copied from a signed-in browser. The only option against a
 *       deployment whose database this process cannot reach.
 *
 *   DATABASE_URL=… [COMPASS_PROBE_EMAIL=dev@localhost.dev]
 *       Seeds a `Session` row directly and uses it, then deletes it on the way
 *       out. Requires the database-session strategy, i.e. a production-mode
 *       server (`pnpm build && pnpm start`) — `pnpm dev` issues JWT sessions
 *       from a Credentials provider and has no `sessions` table to seed.
 *
 * Step 8's second half (a real token row carrying a foreign audience) also
 * needs DATABASE_URL. Without it the probe still asserts that the *authorization
 * server* refuses to mint such a token, and says plainly that the resource
 * server's own predicate went unverified rather than reporting a pass.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { getActiveSchema } from "../lib/schema.ts"

// ── Configuration ───────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const BASE_URL = (
  argValue("--base-url") ??
  process.env.COMPASS_PROBE_BASE_URL ??
  "http://localhost:3000"
).replace(/\/$/, "")

const PROBE_EMAIL = process.env.COMPASS_PROBE_EMAIL ?? "dev@localhost.dev"
/** Portless on purpose — the Geode broker registers exactly this. */
const REDIRECT_URI_REGISTERED = "http://127.0.0.1/callback"
/**
 * …and authorizes on an ephemeral port. Registering one and authorizing with
 * the other is the single most fragile thing about the Geode handshake (RFC
 * 8252 §7.3), so the probe does it deliberately rather than using a matching
 * pair that would pass under exact string matching too.
 */
const REDIRECT_URI_AUTHORIZED = "http://127.0.0.1:53219/callback"
/**
 * A *second*, different ephemeral port, used for the re-authorization in step 8.
 * Re-authorizing from the same install is the only place a port-matching bug
 * shows up that a single authorization would not catch.
 */
const REDIRECT_URI_REAUTHORIZED = "http://127.0.0.1:61044/callback"

// ── Reporting ───────────────────────────────────────────────────────────────

let failures = 0
let skipped = 0

function pass(label: string, detail?: string) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`)
}

function fail(label: string, detail: string) {
  failures += 1
  console.log(`  FAIL  ${label} — ${detail}`)
}

function skip(label: string, reason: string) {
  skipped += 1
  console.log(`  SKIP  ${label} — ${reason}`)
}

function step(n: number, title: string) {
  console.log(`\n${n}. ${title}`)
}

function check(label: string, condition: boolean, detail: string) {
  if (condition) pass(label, detail)
  else fail(label, detail)
  return condition
}

function checkEqual(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass(label, String(actual))
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  return ok
}

class ProbeAbort extends Error {}

function abort(message: string): never {
  throw new ProbeAbort(message)
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** Never follows redirects: several assertions are *about* the redirect. */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`
  return fetch(url, { redirect: "manual", ...init })
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }
}

/**
 * Parses an RFC 6750 `WWW-Authenticate: Bearer …` header into its parameters.
 * Deliberately tolerant about ordering and whitespace, strict about quoting —
 * the values we assert on are all quoted-string.
 */
function parseChallenge(header: string | null): Record<string, string> {
  if (!header) return {}
  const params: Record<string, string> = {}
  for (const match of header.matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
    params[match[1]] = match[2].replace(/\\(.)/g, "$1")
  }
  return params
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

// ── Database (optional) ─────────────────────────────────────────────────────

type Db = { prisma: PrismaClient; close: () => Promise<void> }

function openDatabase(): Db | null {
  if (!process.env.DATABASE_URL) return null
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: getActiveSchema() }) })
  return { prisma, close: async () => void (await prisma.$disconnect()) }
}

/**
 * Mints an Auth.js database session for `PROBE_EMAIL`, creating the user if it
 * does not exist. Returns the cookie header value plus a cleanup callback.
 *
 * The cookie name has no `__Secure-` prefix because the probe's normal target is
 * `http://localhost`. Against an HTTPS deployment Auth.js uses the prefixed
 * name, so pass `COMPASS_PROBE_SESSION_COOKIE` there instead of seeding.
 */
async function seedSession(db: Db): Promise<{ cookie: string; cleanup: () => Promise<void> }> {
  const user = await db.prisma.user.upsert({
    where: { email: PROBE_EMAIL },
    update: {},
    create: { email: PROBE_EMAIL, name: "OAuth probe", emailVerified: new Date() },
    select: { id: true },
  })
  const sessionToken = randomUUID()
  await db.prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return {
    cookie: `authjs.session-token=${sessionToken}`,
    cleanup: async () => {
      await db.prisma.session.deleteMany({ where: { sessionToken } }).catch(() => {})
    },
  }
}

// ── The authorization leg ───────────────────────────────────────────────────

/**
 * Drives `/oauth/authorize` through to an authorization code, asserting the
 * things a client depends on along the way. Handles both shapes the endpoint
 * can take: a rendered consent screen, and the short-circuit redirect a
 * remembered prior grant produces.
 */
async function authorize(options: {
  clientId: string
  cookie: string
  redirectUri: string
  /** Defaults to both MCP scopes. */
  scope?: string
}): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge: codeChallenge } = pkcePair()
  const state = randomBytes(16).toString("hex")
  const authorizeUrl =
    `/oauth/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: options.clientId,
      // Deliberately a *different* port from the registered URI — see the
      // constant's comment. Exact string matching fails this; RFC 8252 §7.3
      // loopback matching passes it.
      redirect_uri: options.redirectUri,
      scope: options.scope ?? "mcp:read mcp:write",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      // `resource` is deliberately omitted: neither the Geode broker nor
      // mcp-remote sends it, so the defaulted-audience path is the one that
      // must work.
    }).toString()

  const authorizePage = await request(authorizeUrl, { headers: { cookie: options.cookie } })
  let callback: URL
  if (authorizePage.status === 200) {
    const html = await authorizePage.text()
    const signed = /name="request"\s+value="([^"]+)"/.exec(html)?.[1]
    if (!signed) abort("consent screen rendered but carried no signed request blob")
    pass("consent screen rendered", "extracting the signed request blob")
    const consent = await request("/oauth/consent", {
      ...form({ decision: "allow", request: signed }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: options.cookie,
      },
    })
    checkEqual("consent POST status", consent.status, 303)
    const location = consent.headers.get("location")
    if (!location) abort("consent returned no Location header")
    callback = new URL(location)
  } else if ([302, 303, 307].includes(authorizePage.status)) {
    // A previously recorded consent for this client short-circuits the screen.
    const location = authorizePage.headers.get("location")
    if (!location) abort("authorize redirected with no Location header")
    pass("consent", "skipped — a prior grant was remembered")
    callback = new URL(location)
  } else {
    abort(`authorize returned ${authorizePage.status}; expected a consent screen or a redirect`)
  }

  check(
    "redirect goes to the ephemeral loopback port that was authorized",
    `${callback.protocol}//${callback.host}${callback.pathname}` === options.redirectUri,
    `${callback.protocol}//${callback.host}${callback.pathname}`,
  )
  checkEqual("state round-tripped", callback.searchParams.get("state"), state)
  // RFC 9207. New in MCP 2026-07-28 and heading SHOULD → MUST.
  checkEqual("iss on the authorization response", callback.searchParams.get("iss"), BASE_URL)
  const code = callback.searchParams.get("code")
  check("authorization code issued", Boolean(code), code ? `${code.slice(0, 12)}…` : "absent")
  if (!code) abort("no authorization code; nothing further can run")
  return { code, verifier }
}

// ── The probe ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Compass MCP OAuth probe → ${BASE_URL}`)

  // 1 ──────────────────────────────────────────────────────────────────────
  step(1, "POST /api/mcp with no token → 401 challenge")
  const unauthenticated = await request("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  })
  checkEqual("status", unauthenticated.status, 401)
  const challenge = parseChallenge(unauthenticated.headers.get("www-authenticate"))
  const expectedMetadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`
  checkEqual("WWW-Authenticate resource_metadata", challenge.resource_metadata, expectedMetadataUrl)
  // Without this parameter a client requests every scope in `scopes_supported`,
  // i.e. maximal consent on every connection. This is the assertion the whole
  // hand-rolled challenge exists for.
  checkEqual("WWW-Authenticate scope", challenge.scope, "mcp:read")

  // 2 ──────────────────────────────────────────────────────────────────────
  step(2, "Protected-resource metadata at both URLs")
  const prmPathInserted = await request("/.well-known/oauth-protected-resource/api/mcp")
  const prmRoot = await request("/.well-known/oauth-protected-resource")
  checkEqual("path-inserted status", prmPathInserted.status, 200)
  checkEqual("root status", prmRoot.status, 200)
  const prmPathInsertedBody = await prmPathInserted.text()
  const prmRootBody = await prmRoot.text()
  check(
    "both URLs serve byte-identical documents",
    prmPathInsertedBody === prmRootBody,
    `${prmPathInsertedBody.length} bytes`,
  )
  const prm = JSON.parse(prmPathInsertedBody) as Record<string, unknown>
  checkEqual("resource", prm.resource, `${BASE_URL}/api/mcp`)
  // Claude reads only the first entry and does not fall back, so the order of
  // this array is load-bearing, not cosmetic.
  checkEqual("authorization_servers[0]", (prm.authorization_servers as string[])?.[0], BASE_URL)
  checkEqual("scopes_supported", prm.scopes_supported, ["mcp:read", "mcp:write"])

  // 3 ──────────────────────────────────────────────────────────────────────
  step(3, "Authorization-server metadata at both well-known URLs")
  const asPrimary = await request("/.well-known/oauth-authorization-server")
  const asOidc = await request("/.well-known/openid-configuration")
  checkEqual("oauth-authorization-server status", asPrimary.status, 200)
  checkEqual("openid-configuration status", asOidc.status, 200)
  const asPrimaryBody = await asPrimary.text()
  const asOidcBody = await asOidc.text()
  check(
    "both spellings serve byte-identical documents",
    asPrimaryBody === asOidcBody,
    `${asPrimaryBody.length} bytes`,
  )
  const meta = JSON.parse(asPrimaryBody) as Record<string, unknown>
  // Clients MUST byte-compare this against the issuer they built the URL from.
  // A mismatch is not cosmetic: a conforming client aborts.
  checkEqual("issuer byte-matches the URL it was discovered from", meta.issuer, BASE_URL)
  check(
    "registration_endpoint is present (DCR is blocking for the Geode broker)",
    typeof meta.registration_endpoint === "string",
    String(meta.registration_endpoint),
  )
  checkEqual("code_challenge_methods_supported", meta.code_challenge_methods_supported, ["S256"])
  check(
    'token_endpoint_auth_methods_supported includes "none"',
    (meta.token_endpoint_auth_methods_supported as string[])?.includes("none"),
    JSON.stringify(meta.token_endpoint_auth_methods_supported),
  )
  checkEqual("authorization_response_iss_parameter_supported", meta.authorization_response_iss_parameter_supported, true)
  // Absent, not false: advertising it would make Claude attempt a CIMD flow
  // this server does not implement instead of falling back to DCR (decision 5).
  check(
    "client_id_metadata_document_supported is absent, not null or false",
    !("client_id_metadata_document_supported" in meta),
    "absent",
  )

  // 4 ──────────────────────────────────────────────────────────────────────
  step(4, "Dynamic client registration")
  const registration = await request(meta.registration_endpoint as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Compass OAuth probe",
      redirect_uris: [REDIRECT_URI_REGISTERED],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:read mcp:write offline_access",
    }),
  })
  checkEqual("status", registration.status, 201)
  const client = (await registration.json()) as Record<string, unknown>
  const clientId = client.client_id as string
  if (!clientId) abort("registration returned no client_id; nothing further can run")
  check("client_id issued", true, clientId)
  check(
    "registered as a public client (no secret)",
    !("client_secret" in client),
    client.token_endpoint_auth_method as string,
  )

  // 5 ──────────────────────────────────────────────────────────────────────
  step(5, "Authorize with a signed-in session")
  const db = openDatabase()
  let cookie = process.env.COMPASS_PROBE_SESSION_COOKIE ?? null
  let cleanupSession: (() => Promise<void>) | null = null
  if (!cookie && db) {
    const seeded = await seedSession(db)
    cookie = seeded.cookie
    cleanupSession = seeded.cleanup
    pass("session", `seeded a database session for ${PROBE_EMAIL}`)
  } else if (cookie) {
    pass("session", "using COMPASS_PROBE_SESSION_COOKIE")
  } else {
    abort(
      "no session available: set COMPASS_PROBE_SESSION_COOKIE, or DATABASE_URL to seed one",
    )
  }

  const authorized = await authorize({ clientId, cookie, redirectUri: REDIRECT_URI_AUTHORIZED })
  const { code, verifier } = authorized

  // 6 ──────────────────────────────────────────────────────────────────────
  step(6, "Exchange the code at the token endpoint")
  const tokenStarted = Date.now()
  const tokenResponse = await request(meta.token_endpoint as string, {
    ...form({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI_AUTHORIZED,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  const tokenElapsed = Date.now() - tokenStarted
  checkEqual("status", tokenResponse.status, 200)
  const tokens = (await tokenResponse.json()) as Record<string, unknown>
  const accessToken = tokens.access_token as string
  check("access_token issued", typeof accessToken === "string", String(tokens.token_type))
  // Unconditional, never gated on `offline_access`: the Geode broker requests
  // the refresh grant at DCR but does not ask for that scope, and its proxy
  // depends on refresh to recover from an upstream 401.
  check("refresh_token issued unconditionally", typeof tokens.refresh_token === "string", "present")
  checkEqual("granted scope", tokens.scope, "mcp:read mcp:write")
  // Claude enforces a 10 s budget on the token request, and a cold function plus
  // an IAM-signed DSQL connection can approach it. Informational, not a failure.
  console.log(`  INFO  token endpoint responded in ${tokenElapsed} ms (Claude's budget is 10 s)`)
  if (!accessToken) abort("no access token; nothing further can run")

  // 7 ──────────────────────────────────────────────────────────────────────
  step(7, "initialize against /api/mcp with the access token")
  const initialize = await request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "compass-oauth-probe", version: "1.0.0" },
      },
    }),
  })
  checkEqual("status", initialize.status, 200)
  const initializeBody = await initialize.text()
  check(
    "server answered the initialize handshake",
    initializeBody.includes("serverInfo") || initializeBody.includes("protocolVersion"),
    initializeBody.slice(0, 120).replace(/\s+/g, " "),
  )

  // 8 ──────────────────────────────────────────────────────────────────────
  step(8, "Audience enforcement")
  const foreignResource = "https://not-compass.example/api/mcp"

  // 8a — the authorization server refuses to mint a foreign-audience token.
  //
  // This needs a genuinely valid code, not a fabricated one: the token endpoint
  // claims and validates the code before it looks at `resource`, so a fake code
  // returns `invalid_grant` and the audience check is never reached. Getting one
  // means re-authorizing — which is the cross-repo regression the design calls
  // out anyway, because the second authorization binds a *different* ephemeral
  // loopback port and that is the only place port-matching breaks.
  const reauthorized = await authorize({
    clientId,
    cookie,
    redirectUri: REDIRECT_URI_REAUTHORIZED,
  })
  const foreignExchange = await request(meta.token_endpoint as string, {
    ...form({
      grant_type: "authorization_code",
      code: reauthorized.code,
      redirect_uri: REDIRECT_URI_REAUTHORIZED,
      client_id: clientId,
      code_verifier: reauthorized.verifier,
      resource: foreignResource,
    }),
  })
  const foreignBody = (await foreignExchange.json()) as Record<string, unknown>
  check(
    "token endpoint rejects a foreign resource indicator on an otherwise-valid exchange",
    foreignExchange.status === 400 && foreignBody.error === "invalid_target",
    `${foreignExchange.status} ${String(foreignBody.error)}`,
  )

  // 8b — and the resource server refuses a token that somehow carries one.
  //      This is the predicate in validateMcpAuth; nothing else exercises it.
  if (db) {
    const raw = `cmp_oat_${randomBytes(16).toString("hex")}`
    const familyId = randomUUID()
    const sessionUser = await db.prisma.user.findUnique({
      where: { email: PROBE_EMAIL },
      select: { id: true },
    })
    if (!sessionUser) {
      skip("resource server rejects a foreign-audience token", `no user ${PROBE_EMAIL}`)
    } else {
      await db.prisma.oAuthToken.create({
        data: {
          tokenHash: createHash("sha256").update(raw).digest("hex"),
          type: "ACCESS",
          clientId,
          userId: sessionUser.id,
          scope: "mcp:read mcp:write",
          resource: foreignResource,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          familyId,
        },
      })
      try {
        const foreignCall = await request("/api/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        })
        check(
          "resource server rejects an otherwise-valid token minted for another audience",
          foreignCall.status === 401,
          `${foreignCall.status}`,
        )
      } finally {
        await db.prisma.oAuthToken.deleteMany({ where: { familyId } }).catch(() => {})
      }
    }
  } else {
    skip(
      "resource server rejects a foreign-audience token",
      "needs DATABASE_URL to plant one; the AS-level refusal above was still checked",
    )
  }

  // 9 ──────────────────────────────────────────────────────────────────────
  step(9, "Scope enforcement on a read-only token")
  const readOnly = await authorize({
    clientId,
    cookie,
    redirectUri: REDIRECT_URI_AUTHORIZED,
    scope: "mcp:read",
  })
  const readOnlyExchange = await request(meta.token_endpoint as string, {
    ...form({
      grant_type: "authorization_code",
      code: readOnly.code,
      redirect_uri: REDIRECT_URI_AUTHORIZED,
      client_id: clientId,
      code_verifier: readOnly.verifier,
    }),
  })
  const readOnlyTokens = (await readOnlyExchange.json()) as Record<string, unknown>
  checkEqual("granted scope is read-only", readOnlyTokens.scope, "mcp:read")
  const readOnlyToken = readOnlyTokens.access_token as string
  if (!readOnlyToken) abort("read-only exchange returned no access token")

  const call = (body: unknown) =>
    request("/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${readOnlyToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    })

  const listTools = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  checkEqual("tools/list is allowed", listTools.status, 200)

  const writeCall = await call({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "create_opportunity", arguments: { workspaceId: randomUUID(), title: "probe" } },
  })
  // A real 403, not a 200 carrying an error body: Claude ignores
  // WWW-Authenticate on a 200, so the status is what makes this actionable.
  checkEqual("a write tool is refused with 403", writeCall.status, 403)
  const writeChallenge = parseChallenge(writeCall.headers.get("www-authenticate"))
  checkEqual("error", writeChallenge.error, "insufficient_scope")
  checkEqual("scope", writeChallenge.scope, "mcp:write")
  checkEqual("resource_metadata", writeChallenge.resource_metadata, expectedMetadataUrl)

  const readCall = await call({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_workspaces", arguments: { orgSlug: "probe-nonexistent-org" } },
  })
  // Reaching the tool's own "no such org" answer proves the scope layer let it
  // through and the ordinary authorization gate ran, exactly as for an API key.
  checkEqual("a read tool is allowed through to its own gate", readCall.status, 200)

  if (cleanupSession) await cleanupSession()
  if (db) await db.close()
}

main()
  .then(() => {
    console.log(
      `\n${failures === 0 ? "PROBE PASSED" : "PROBE FAILED"} — ` +
        `${failures} failure(s), ${skipped} skipped`,
    )
    process.exitCode = failures === 0 ? 0 : 1
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`\n  ABORT ${message}`)
    if (!(error instanceof ProbeAbort)) console.error(error)
    console.log(`\nPROBE FAILED — aborted after ${failures} failure(s)`)
    process.exitCode = 1
  })
