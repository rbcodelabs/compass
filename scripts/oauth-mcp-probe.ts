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
 *   7. Agent authorization matrix    → identity, grants, gates, audited mutation
 *   8. Audience enforcement          → a foreign-`resource` token is refused
 *   9. Scope enforcement             → a read-only token gets a real 403
 *  10. Agent suspension              → the same access token immediately gets 401
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
 *       Seeds a `Session`, isolated organization, two workspaces and an agent
 *       directly, then deletes them on the way out. Requires the database-
 *       session strategy, i.e. a production-mode server (`pnpm build && pnpm
 *       start`) — `pnpm dev` issues JWT sessions from a Credentials provider
 *       and has no `sessions` table to seed.
 *
 *   COMPASS_PROBE_SESSION_COOKIE=… COMPASS_PROBE_AGENT_ID=…
 *       Against a remote deployment, names an existing active agent for a
 *       fresh consent screen. Optional `COMPASS_PROBE_AGENT_NAME`,
 *       `COMPASS_PROBE_GRANTED_WORKSPACE_ID`,
 *       `COMPASS_PROBE_UNGRANTED_WORKSPACE_ID` and `COMPASS_PROBE_ORG_SLUG`
 *       enable the corresponding assertions without database readback.
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
import {
  mcpErrorText,
  mcpToolEnvelope,
  parseMcpPayload,
  runCleanupStack,
  type McpPayload,
} from "./oauth-mcp-probe-helpers.ts"

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
const PROBE_AGENT_ID = process.env.COMPASS_PROBE_AGENT_ID
const PROBE_AGENT_NAME = process.env.COMPASS_PROBE_AGENT_NAME
const PROBE_GRANTED_WORKSPACE_ID = process.env.COMPASS_PROBE_GRANTED_WORKSPACE_ID
const PROBE_UNGRANTED_WORKSPACE_ID = process.env.COMPASS_PROBE_UNGRANTED_WORKSPACE_ID
const PROBE_ORG_SLUG = process.env.COMPASS_PROBE_ORG_SLUG
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

function mcpRequest(accessToken: string, body: unknown): Promise<Response> {
  return request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })
}

async function callTool(
  accessToken: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ response: Response; payload: McpPayload }> {
  const response = await mcpRequest(accessToken, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })
  return { response, payload: parseMcpPayload(await response.text()) }
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
      await db.prisma.session.deleteMany({ where: { sessionToken } })
    },
  }
}

type AgentFixture = {
  agentId: string
  agentName: string
  orgSlug: string
  grantedWorkspaceId: string
  ungrantedWorkspaceId: string
  cleanup: () => Promise<void>
}

/**
 * Builds two isolated workspaces for the probe user and grants the probe agent
 * only the first. This makes both sides of the grant boundary deterministic;
 * no shared developer or preview data is inspected or modified.
 */
async function seedAgentFixture(db: Db): Promise<AgentFixture> {
  const user = await db.prisma.user.findUnique({ where: { email: PROBE_EMAIL }, select: { id: true } })
  if (!user) abort(`cannot seed agent fixture: no user ${PROBE_EMAIL}`)

  const nonce = randomBytes(6).toString("hex")
  const organizationId = randomUUID()
  const grantedWorkspaceId = randomUUID()
  const ungrantedWorkspaceId = randomUUID()
  const agentId = randomUUID()
  const orgSlug = `oauth-probe-${nonce}`
  const agentName = `OAuth probe agent ${nonce}`

  const cleanup = async () => {
    const cleanupFailures = await runCleanupStack([
      async () => void (await db.prisma.organization.deleteMany({ where: { id: organizationId } })),
      async () => void (await db.prisma.organizationMember.deleteMany({ where: { organizationId } })),
      async () => void (await db.prisma.workspace.deleteMany({
        where: { id: { in: [grantedWorkspaceId, ungrantedWorkspaceId] } },
      })),
      async () => void (await db.prisma.workspaceMember.deleteMany({
        where: { workspaceId: { in: [grantedWorkspaceId, ungrantedWorkspaceId] } },
      })),
      async () => void (await db.prisma.agent.deleteMany({ where: { id: agentId } })),
      async () => void (await db.prisma.agentWorkspaceGrant.deleteMany({ where: { agentId } })),
      async () => void (await db.prisma.agentToolCall.deleteMany({ where: { agentId } })),
      async () => void (await db.prisma.task.deleteMany({
        where: { workspaceId: { in: [grantedWorkspaceId, ungrantedWorkspaceId] } },
      })),
    ])
    if (cleanupFailures.length > 0) {
      throw new Error(`agent fixture cleanup had ${cleanupFailures.length} failure(s)`)
    }
  }

  try {
    await db.prisma.organization.create({
      data: { id: organizationId, slug: orgSlug, name: `OAuth probe ${nonce}` },
    })
    await db.prisma.organizationMember.create({
      data: { organizationId, userId: user.id, role: "OWNER" },
    })
    await db.prisma.workspace.createMany({
      data: [
        { id: grantedWorkspaceId, organizationId, slug: "granted", name: "OAuth probe granted" },
        { id: ungrantedWorkspaceId, organizationId, slug: "ungranted", name: "OAuth probe ungranted" },
      ],
    })
    await db.prisma.workspaceMember.createMany({
      data: [
        { workspaceId: grantedWorkspaceId, userId: user.id, role: "ADMIN" },
        { workspaceId: ungrantedWorkspaceId, userId: user.id, role: "ADMIN" },
      ],
    })
    await db.prisma.agent.create({
      data: { id: agentId, ownerUserId: user.id, name: agentName },
    })
    await db.prisma.agentWorkspaceGrant.create({
      data: {
        agentId,
        workspaceId: grantedWorkspaceId,
        access: "WRITE",
        grantedByUserId: user.id,
      },
    })
  } catch (error) {
    try {
      await cleanup()
    } catch {
      console.error("  WARN  partial agent fixture cleanup failed")
    }
    throw error
  }

  return {
    agentId,
    agentName,
    orgSlug,
    grantedWorkspaceId,
    ungrantedWorkspaceId,
    cleanup,
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
  /** Required when a fresh Stage 2 consent screen renders. */
  agentId?: string
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
    if (!options.agentId) {
      abort(
        "Stage 2 consent requires an agent binding; set DATABASE_URL for an isolated fixture or COMPASS_PROBE_AGENT_ID",
      )
    }
    pass("consent screen rendered", "extracting the signed request blob")
    const consent = await request("/oauth/consent", {
      ...form({ decision: "allow", request: signed, binding: "agent", agentId: options.agentId }),
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
  check("authorization code issued", Boolean(code), code ? "present" : "absent")
  if (!code) abort("no authorization code; nothing further can run")
  return { code, verifier }
}

// ── The probe ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Compass MCP OAuth probe → ${BASE_URL}`)
  const cleanupStack: Array<() => Promise<void>> = []
  let probeError: unknown

  try {

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
  const db = openDatabase()
  if (db) {
    // Registered as soon as the client ID exists. LIFO cleanup closes the
    // connection last, after every dependent OAuth row has been attempted.
    cleanupStack.push(db.close)
    cleanupStack.push(async () => void (await db.prisma.oAuthClient.deleteMany({ where: { clientId } })))
    cleanupStack.push(async () => void (await db.prisma.oAuthConsent.deleteMany({ where: { clientId } })))
    cleanupStack.push(async () => void (await db.prisma.oAuthToken.deleteMany({ where: { clientId } })))
    cleanupStack.push(async () => void (await db.prisma.oAuthAuthorizationCode.deleteMany({ where: { clientId } })))
    cleanupStack.push(async () => void (await db.prisma.oAuthAuthorizationEvent.deleteMany({ where: { clientId } })))
  }
  check("client_id issued", true, clientId)
  check(
    "registered as a public client (no secret)",
    !("client_secret" in client),
    client.token_endpoint_auth_method as string,
  )

  // 5 ──────────────────────────────────────────────────────────────────────
  step(5, "Authorize with a signed-in session")
  let cookie = process.env.COMPASS_PROBE_SESSION_COOKIE ?? null
  let cleanupSession: (() => Promise<void>) | null = null
  if (!cookie && db) {
    const seeded = await seedSession(db)
    cookie = seeded.cookie
    cleanupSession = seeded.cleanup
    cleanupStack.push(seeded.cleanup)
    pass("session", `seeded a database session for ${PROBE_EMAIL}`)
  } else if (cookie) {
    pass("session", "using COMPASS_PROBE_SESSION_COOKIE")
  } else {
    abort(
      "no session available: set COMPASS_PROBE_SESSION_COOKIE, or DATABASE_URL to seed one",
    )
  }

  // Only pair a database fixture with the database session we minted for the
  // same PROBE_EMAIL. An externally supplied cookie may belong to a different
  // user, in which case a fixture owned by PROBE_EMAIL would be correctly
  // rejected by consent and would make the probe configuration misleading.
  const fixture = db && cleanupSession ? await seedAgentFixture(db) : null
  if (fixture) cleanupStack.push(fixture.cleanup)
  const agentId = fixture?.agentId ?? PROBE_AGENT_ID
  const expectedAgentName = fixture?.agentName ?? PROBE_AGENT_NAME
  const grantedWorkspaceId = fixture?.grantedWorkspaceId ?? PROBE_GRANTED_WORKSPACE_ID
  const ungrantedWorkspaceId = fixture?.ungrantedWorkspaceId ?? PROBE_UNGRANTED_WORKSPACE_ID
  const probeOrgSlug = fixture?.orgSlug ?? PROBE_ORG_SLUG
  if (fixture) {
    pass("agent fixture", "created isolated granted and ungranted workspaces")
  } else if (agentId) {
    pass("agent fixture", "using COMPASS_PROBE_AGENT_ID")
  }

  const authorized = await authorize({
    clientId,
    cookie,
    redirectUri: REDIRECT_URI_AUTHORIZED,
    agentId,
  })
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
  step(7, "Agent binding and authorization matrix")
  const initialize = await mcpRequest(accessToken, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "compass-oauth-probe", version: "1.0.0" },
    },
  })
  checkEqual("status", initialize.status, 200)
  const initializeBody = await initialize.text()
  check(
    "server answered the initialize handshake",
    initializeBody.includes("serverInfo") || initializeBody.includes("protocolVersion"),
    initializeBody.slice(0, 120).replace(/\s+/g, " "),
  )

  const identityCall = await callTool(accessToken, 2, "get_current_identity", {})
  checkEqual("get_current_identity status", identityCall.response.status, 200)
  const identity = mcpToolEnvelope(identityCall.payload)
  const identityData = identity?.data as
    | { purpose?: unknown; agent?: { id?: unknown; name?: unknown } | null; workspaces?: Array<{ id?: unknown }> }
    | undefined
  checkEqual("OAuth token acts with AGENT purpose", identityData?.purpose, "AGENT")
  if (agentId) checkEqual("OAuth token is bound to the selected agent", identityData?.agent?.id, agentId)
  if (expectedAgentName) {
    checkEqual("selected agent name round-trips", identityData?.agent?.name, expectedAgentName)
  }
  if (grantedWorkspaceId) {
    check(
      "identity includes the granted workspace",
      Boolean(identityData?.workspaces?.some((workspace) => workspace.id === grantedWorkspaceId)),
      grantedWorkspaceId,
    )
  }
  if (ungrantedWorkspaceId) {
    check(
      "identity excludes the ungranted workspace",
      !identityData?.workspaces?.some((workspace) => workspace.id === ungrantedWorkspaceId),
      ungrantedWorkspaceId,
    )
  }

  if (grantedWorkspaceId) {
    const grantedRead = await callTool(accessToken, 3, "list_opportunities", {
      workspaceId: grantedWorkspaceId,
    })
    const grantedEnvelope = mcpToolEnvelope(grantedRead.payload)
    check(
      "read in a granted workspace succeeds",
      grantedRead.response.status === 200 && grantedEnvelope?.ok === true,
      `${grantedRead.response.status} ${grantedEnvelope?.message ?? mcpErrorText(grantedRead.payload) ?? "no result"}`,
    )
  } else {
    skip("read in a granted workspace succeeds", "set DATABASE_URL or COMPASS_PROBE_GRANTED_WORKSPACE_ID")
  }

  if (ungrantedWorkspaceId) {
    const ungrantedRead = await callTool(accessToken, 4, "list_opportunities", {
      workspaceId: ungrantedWorkspaceId,
    })
    const denial = mcpErrorText(ungrantedRead.payload)
    check(
      "read in an ungranted workspace is denied",
      ungrantedRead.response.status === 200 && Boolean(denial?.includes("Workspace not found or access denied")),
      `${ungrantedRead.response.status} ${denial ?? "no error"}`,
    )
  } else {
    skip("read in an ungranted workspace is denied", "set DATABASE_URL or COMPASS_PROBE_UNGRANTED_WORKSPACE_ID")
  }

  if (probeOrgSlug) {
    const humanOnly = await callTool(accessToken, 5, "create_workspace", {
      orgSlug: probeOrgSlug,
      name: "Must not be created",
      slug: `must-not-exist-${randomBytes(4).toString("hex")}`,
    })
    const denial = mcpErrorText(humanOnly.payload)
    check(
      "create_workspace is denied as human-only",
      humanOnly.response.status === 200 &&
        Boolean(denial?.includes("Tool requires a human identity: create_workspace")),
      `${humanOnly.response.status} ${denial ?? "no error"}`,
    )
  } else {
    skip("create_workspace is denied as human-only", "set DATABASE_URL or COMPASS_PROBE_ORG_SLUG")
  }

  // All four MCP tools backed by assertWorkspaceAdmin/assertOrgAdminBySlug are
  // classified DENY, and policy denial runs before the tool gate. The distinct
  // message is therefore unreachable through MCP by design; direct coverage is
  // in __tests__/lib/oauth-agent-binding.test.ts.
  skip(
    "representative admin tool returns Human administrator required",
    "policy-level human-only denial runs first; direct authz assertion is unit-tested",
  )

  if (grantedWorkspaceId) {
    const mutation = await callTool(accessToken, 6, "create_task", {
      workspaceId: grantedWorkspaceId,
      title: `OAuth credentialId probe ${randomBytes(4).toString("hex")}`,
    })
    const mutationEnvelope = mcpToolEnvelope(mutation.payload)
    check(
      "agent-bound mutation succeeds",
      mutation.response.status === 200 && mutationEnvelope?.ok === true,
      `${mutation.response.status} ${mutationEnvelope?.message ?? mcpErrorText(mutation.payload) ?? "no result"}`,
    )

    if (db && agentId) {
      const audit = await db.prisma.agentToolCall.findFirst({
        where: { agentId, toolName: "create_task" },
        orderBy: { createdAt: "desc" },
        select: { credentialId: true, credentialType: true, status: true },
      })
      const credential = audit
        ? await db.prisma.oAuthToken.findUnique({
            where: { id: audit.credentialId },
            select: { agentId: true, authorizationMode: true },
          })
        : null
      check(
        "mutation audit points to its OAuth credential",
        audit?.credentialType === "OAUTH" &&
          audit.status === "SUCCEEDED" &&
          credential?.authorizationMode === "AGENT" &&
          credential.agentId === agentId,
        audit ? `${audit.status} ${audit.credentialType}` : "no audit row",
      )
    } else {
      skip("mutation audit points to its OAuth credential", "needs DATABASE_URL for readback")
    }
  } else {
    skip("agent-bound mutation succeeds", "set DATABASE_URL or COMPASS_PROBE_GRANTED_WORKSPACE_ID")
    skip("mutation audit points to its OAuth credential", "mutation was not run")
  }

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
    agentId,
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
    agentId,
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

  // 10 ─────────────────────────────────────────────────────────────────────
  step(10, "Agent suspension invalidates the existing access token")
  if (db && fixture) {
    await db.prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: "SUSPENDED", updatedAt: new Date() },
    })
    const afterSuspension = await mcpRequest(accessToken, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "get_current_identity", arguments: {} },
    })
    checkEqual("the next call after suspension is unauthorized", afterSuspension.status, 401)
  } else {
    skip("the next call after suspension is unauthorized", "needs DATABASE_URL to suspend the isolated agent")
  }

  } catch (error) {
    probeError = error
    throw error
  } finally {
    const cleanupFailures = await runCleanupStack(cleanupStack)
    if (cleanupFailures.length > 0) {
      // Counts only: cleanup errors may contain database values or connection
      // details and must not replace (or leak alongside) the original failure.
      console.error(`  WARN  probe cleanup had ${cleanupFailures.length} failure(s)`)
      if (probeError === undefined) {
        throw new Error(`probe cleanup had ${cleanupFailures.length} failure(s)`)
      }
    }
  }
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
