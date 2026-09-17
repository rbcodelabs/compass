import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { PrismaClient, Prisma } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

/**
 * Statement-count proof for the request-scoped workspace resolver.
 *
 * ── Why this file looks unusual ───────────────────────────────────────────
 *
 * React's `cache()` only memoizes under the `react-server` build AND only when
 * a cache dispatcher is installed. Under vitest (`environment: "node"`), the
 * bare `react` entry point resolves to the client build, whose `cache` is:
 *
 *     function (fn) { return function () { return fn.apply(null, arguments); }; }
 *
 * — a passthrough with no memoization whatsoever. That means a test which
 * imports the resolver, calls it twice and sees one query CANNOT exist by
 * accident, and a test asserting dedupe without addressing this is asserting
 * nothing at all. So we load the real react-server `cache` explicitly and
 * install a dispatcher to simulate one request scope.
 *
 * `internals.A` is a module-level global rather than AsyncLocalStorage, so
 * these scopes must not interleave — hence `describe.sequential`.
 */
const req = createRequire(import.meta.url)
const reactServer = req(
  path.join(path.dirname(req.resolve("react/package.json")), "cjs/react.react-server.development.js")
)
const internals = reactServer.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: reactServer.cache,
}))

/** One simulated RSC request scope: a fresh cache root, as Next installs per request. */
async function inRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  const roots = new Map<unknown, unknown>()
  const previous = internals.A
  internals.A = {
    getCacheForType(resourceType: () => unknown) {
      if (!roots.has(resourceType)) roots.set(resourceType, resourceType())
      return roots.get(resourceType)
    },
    cacheSignal: () => null,
  }
  try {
    return await fn()
  } finally {
    internals.A = previous
  }
}

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))

/**
 * Stands in for the production database-session auth path.
 *
 * This matters: `auth.ts` uses JWT sessions with no adapter in development, so
 * a dev-shaped `auth()` costs zero queries and dedupe would be measuring
 * nothing. `authCalls` counts invocations the way the adapter's
 * getSessionAndUser would be hit in production.
 */
const authState = vi.hoisted(() => ({ calls: 0, userId: null as string | null }))
vi.mock("@/auth", () => ({
  auth: async () => {
    authState.calls++
    if (!authState.userId) return null
    return { user: { id: authState.userId, name: "Test User", email: "test@example.com", image: null } }
  },
}))

/**
 * Counts Prisma *model operations* (one per `prisma.x.find…()` call).
 *
 * Note this is NOT the same as counting SQL statements: a relation include is
 * one operation but can be more than one statement. `sql` below is the
 * ground-truth statement count, taken at the pg pool.
 */
const counts = new Map<string, number>()
function countingExtension() {
  return Prisma.defineExtension({
    name: "operation-counter",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          counts.set(`${model}.${operation}`, (counts.get(`${model}.${operation}`) ?? 0) + 1)
          return query(args)
        },
      },
    },
  })
}
const total = () => [...counts.values()].reduce((a, b) => a + b, 0)

/** Ground-truth SQL statements, captured at the pg pool. */
const sql: string[] = []
const selects = () => sql.filter((text) => /^\s*SELECT/i.test(text))

function instrumentPool(target: Pool) {
  const record = (arg: unknown) => {
    const text = typeof arg === "string" ? arg : (arg as { text?: string })?.text
    if (text) sql.push(text)
  }
  const originalQuery = target.query.bind(target)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's query() has 6 overloads; re-declaring them to proxy one call adds nothing.
  target.query = ((...args: any[]) => {
    record(args[0])
    return (originalQuery as any)(...args)
  }) as typeof target.query
  const originalConnect = target.connect.bind(target)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as above, for connect()'s callback/promise overloads.
  target.connect = (async (...args: any[]) => {
    const client = await (originalConnect as any)(...args)
    // `connect()` also has a callback form, in which case it resolves to
    // undefined — and the adapter calls it during teardown after the pool has
    // ended. Guard rather than assume a client object comes back.
    if (client && !client.__instrumented) {
      const clientQuery = client.query.bind(client)
      client.query = (...inner: any[]) => {
        record(inner[0])
        return clientQuery(...inner)
      }
      client.__instrumented = true
    }
    return client
  }) as typeof target.connect
}

// Observed counts, asserted as exact integers so the performance claim is a
// test result rather than a paragraph.
//
// The baseline's 10 SELECTs are: 3 x (workspace + organization) for the three
// independent getWorkspace() calls — the `include` is a second statement
// because the generator sets no previewFeatures, so relationJoins is off and
// Prisma's relation load strategy is "query" — plus 3 for getUserWorkspaces'
// two-level include (members, workspaces, organizations) and 1 for the org
// membership. After: 1 workspace + 1 org membership from the resolver, and
// 2 (workspaces + organizations) from the narrowed getUserWorkspaces.
const BASELINE_OPERATIONS = 5
const BASELINE_SELECTS = 10
const DEDUPED_OPERATIONS = 3
const DEDUPED_SELECTS = 4

const databaseUrl = process.env.WORKSPACE_DEDUPE_DATABASE_URL

describe.skipIf(!databaseUrl).sequential("workspace request dedupe", () => {
  const schema = `ws_dedupe_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  const ids = { org: "", workspace: "", user: "", outsider: "" }
  const ORG_SLUG = "acme"
  const WS_SLUG = "core"

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Requires a local compass_e2e URL without a schema override")
    }
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    instrumentPool(pool)
    created = true
    url.searchParams.set("schema", schema)
    // Existing integration-suite convention: schema push is local/disposable
    // only, never a substitute for deployed registered-migration verification.
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], {
      stdio: "pipe",
      timeout: 120_000,
    })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(
      countingExtension()
    ) as unknown as AppPrismaClient
    connection.prisma = prisma

    const org = await prisma.organization.create({ data: { slug: ORG_SLUG, name: "Acme" } })
    const member = await prisma.user.create({ data: { email: "member@example.com", name: "Member" } })
    const outsider = await prisma.user.create({ data: { email: "outsider@example.com", name: "Outsider" } })
    const workspace = await prisma.workspace.create({
      data: { organizationId: org.id, slug: WS_SLUG, name: "Core" },
    })
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: "ADMIN" },
    })
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: member.id, role: "OWNER" },
    })
    Object.assign(ids, {
      org: org.id,
      workspace: workspace.id,
      user: member.id,
      outsider: outsider.id,
    })
  }, 180_000)

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    if (pool && !pool.ended) await pool.end()
  })

  beforeEach(() => {
    counts.clear()
    sql.length = 0
    authState.calls = 0
    authState.userId = ids.user
  })

  /**
   * Replays, literally, the queries the workspace layout + docs layout + page
   * issued before this change. Kept as executable documentation of the
   * baseline so the improvement is a measured delta, not a claim.
   */
  async function legacyRenderSequence() {
    const db = connection.prisma!
    const { auth } = await import("@/auth")
    for (const _level of ["workspace-layout", "docs-layout", "page"]) {
      const session = (await auth()) as { user: { id: string } } | null
      if (!session?.user?.id) throw new Error("expected a session")
      await db.workspace.findFirst({
        where: {
          slug: WS_SLUG,
          organization: { slug: ORG_SLUG },
          members: { some: { userId: session.user.id } },
        },
        include: { organization: true },
      })
    }
    await db.workspaceMember.findMany({
      where: { userId: ids.user },
      include: { workspace: { include: { organization: true } } },
      orderBy: { workspace: { name: "asc" } },
    })
    await db.organizationMember.findFirst({
      where: { organization: { slug: ORG_SLUG }, userId: ids.user },
      select: { role: true },
    })
  }

  /** The same render, through the shared resolver. */
  async function dedupedRenderSequence() {
    const { requireWorkspaceContext, getUserWorkspaces } = await import("@/lib/workspace")
    const { getSessionUser } = await import("@/lib/session")
    const user = await getSessionUser()
    if (!user) throw new Error("expected a session")
    await Promise.all([
      requireWorkspaceContext(ORG_SLUG, WS_SLUG),
      getUserWorkspaces(user.id),
    ])
    // The nested docs layout and the page each ask again.
    await requireWorkspaceContext(ORG_SLUG, WS_SLUG)
    await requireWorkspaceContext(ORG_SLUG, WS_SLUG)
  }

  it("baseline: the pre-change render sequence issues 11 statements and 3 session reads", async () => {
    await inRequestScope(legacyRenderSequence)
    expect(authState.calls).toBe(3)
    expect(counts.get("Workspace.findFirst")).toBe(3)
    expect(counts.get("WorkspaceMember.findMany")).toBe(1)
    expect(counts.get("OrganizationMember.findFirst")).toBe(1)
    expect(total()).toBe(BASELINE_OPERATIONS)
    expect(selects().length).toBe(BASELINE_SELECTS)
  })

  it("deduped: the same render issues 4 statements and 1 session read", async () => {
    await inRequestScope(dedupedRenderSequence)
    expect(authState.calls).toBe(1)
    expect(counts.get("Workspace.findFirst")).toBe(1)
    expect(counts.get("OrganizationMember.findFirst")).toBe(1)
    expect(counts.get("Workspace.findMany")).toBe(1)
    // The old join-table walk is gone entirely.
    expect(counts.get("WorkspaceMember.findMany")).toBeUndefined()
    expect(total()).toBe(DEDUPED_OPERATIONS)
    expect(selects().length).toBe(DEDUPED_SELECTS)
  })

  it("keys the memo by arguments", async () => {
    await inRequestScope(async () => {
      const { getWorkspaceContext } = await import("@/lib/workspace")
      await getWorkspaceContext(ORG_SLUG, WS_SLUG)
      await getWorkspaceContext(ORG_SLUG, "some-other-workspace")
    })
    expect(counts.get("Workspace.findFirst")).toBe(2)
  })

  it("does NOT persist across request scopes", async () => {
    const { getWorkspaceContext } = await import("@/lib/workspace")
    await inRequestScope(() => getWorkspaceContext(ORG_SLUG, WS_SLUG))
    await inRequestScope(() => getWorkspaceContext(ORG_SLUG, WS_SLUG))
    // If this ever reads 1, someone has hoisted the memo to module scope and
    // turned a per-request cache into a cross-tenant data leak. It is the most
    // important assertion in this file.
    expect(counts.get("Workspace.findFirst")).toBe(2)
  })

  it("keeps redirect/notFound control flow outside the cache", async () => {
    authState.userId = ids.outsider
    await inRequestScope(async () => {
      const { requireWorkspaceContext } = await import("@/lib/workspace")
      for (let i = 0; i < 3; i++) {
        // Every caller gets its own throw...
        await expect(requireWorkspaceContext(ORG_SLUG, WS_SLUG)).rejects.toThrow()
      }
    })
    // ...while the query underneath ran exactly once.
    expect(counts.get("Workspace.findFirst")).toBe(1)
  })

  it("denies a non-member (the discovery/ membership tightening)", async () => {
    authState.userId = ids.outsider
    const ctx = await inRequestScope(async () => {
      const { getWorkspaceContext } = await import("@/lib/workspace")
      return getWorkspaceContext(ORG_SLUG, WS_SLUG)
    })
    expect(ctx.status).toBe("not-found")
  })

  it("returns unauthenticated without touching the database", async () => {
    authState.userId = null
    const ctx = await inRequestScope(async () => {
      const { getWorkspaceContext } = await import("@/lib/workspace")
      return getWorkspaceContext(ORG_SLUG, WS_SLUG)
    })
    expect(ctx.status).toBe("unauthenticated")
    expect(total()).toBe(0)
  })

  it("never selects SSO secret material into the shared context", async () => {
    const ctx = await inRequestScope(async () => {
      const { getWorkspaceContext } = await import("@/lib/workspace")
      return getWorkspaceContext(ORG_SLUG, WS_SLUG)
    })
    expect(ctx.status).toBe("ok")
    if (ctx.status !== "ok") return
    expect(Object.keys(ctx.workspace)).not.toContain("ssoSecretEncrypted")
    expect(Object.keys(ctx.workspace)).not.toContain("ssoEnabled")
  })

  it("normalizes a lowercase org owner to admin", async () => {
    await prisma.organizationMember.updateMany({
      where: { organizationId: ids.org, userId: ids.user },
      data: { role: "owner" },
    })
    const ctx = await inRequestScope(async () => {
      const { getWorkspaceContext } = await import("@/lib/workspace")
      return getWorkspaceContext(ORG_SLUG, WS_SLUG)
    })
    expect(ctx.status === "ok" && ctx.isOrgAdmin).toBe(true)
    await prisma.organizationMember.updateMany({
      where: { organizationId: ids.org, userId: ids.user },
      data: { role: "OWNER" },
    })
  })
})
