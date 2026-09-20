/**
 * An in-memory stand-in for the four OAuth tables.
 *
 * The point of building this rather than reaching for per-call `vi.fn()`
 * stubs is the **concurrency tests**. A stub that resolves a canned value
 * proves only that the code read what it was handed; it cannot distinguish a
 * conditional `updateMany` from a read-then-write, which is the single most
 * important property of the code and refresh paths.
 *
 * So `updateMany` here does what Postgres does: it evaluates the `where`
 * predicate against current state and reports how many rows it actually
 * changed — and it does so *after* yielding to the microtask queue, so two
 * concurrent callers genuinely interleave. Under this fake, a read-then-write
 * implementation double-spends and the tests go red.
 */
import { vi } from "vitest"

interface Row {
  [key: string]: unknown
}

let sequence = 0
function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${String(sequence).padStart(8, "0")}`
}

/**
 * Prisma `where` support, limited on purpose to the shapes this code actually
 * uses: scalar equality, `null`, `{ gt }` / `{ lt }` on dates, and a
 * compound-unique group such as `{ userId_clientId: { userId, clientId } }`,
 * which is flattened and matched field by field.
 *
 * Anything else throws rather than silently matching, so a query shape that
 * grows past what the fake models fails loudly instead of quietly passing a
 * test it should not.
 */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected === null) return actual === null || actual === undefined
    if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Record<string, unknown>
      if ("gt" in condition) return (actual as Date) > (condition.gt as Date)
      if ("lt" in condition) return (actual as Date) < (condition.lt as Date)
      // A compound-unique group: the key names the index, the value holds the
      // real fields. Recursing matches them against the row directly.
      if (actual === undefined && Object.keys(condition).every((field) => field in row)) {
        return matches(row, condition)
      }
      throw new Error(`oauth-store fake does not implement where condition ${JSON.stringify(expected)}`)
    }
    if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime()
    return actual === expected
  })
}

/**
 * `select` values are `true` for a scalar and a nested `{ select: … }` object
 * for a relation. Relations are copied wholesale rather than re-projected —
 * the seeded rows already hold the shape the query would have produced, and
 * modelling Prisma's relation projection would be more fake than is useful.
 */
function project(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key]
  return out
}

class Table {
  rows: Row[] = []
  constructor(
    private readonly idPrefix: string,
    private readonly defaults: () => Row,
  ) {}

  create = vi.fn(async ({ data, select }: { data: Row; select?: Record<string, unknown> }) => {
    const row: Row = { id: nextId(this.idPrefix), ...this.defaults(), ...data }
    this.rows.push(row)
    return project(row, select)
  })

  findUnique = vi.fn(
    async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      const row = this.rows.find((candidate) => matches(candidate, where))
      return row ? project(row, select) : null
    },
  )

  findMany = vi.fn(
    async ({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) =>
      this.rows.filter((row) => (where ? matches(row, where) : true)).map((row) => project(row, select)),
  )

  /**
   * Yields before mutating, so two callers in the same `Promise.all` are both
   * past their `await` before either writes. This is what makes the
   * single-use assertions real rather than decorative.
   */
  updateMany = vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
    await Promise.resolve()
    const targets = this.rows.filter((row) => matches(row, where))
    for (const row of targets) Object.assign(row, data)
    return { count: targets.length }
  })

  upsert = vi.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>
      create: Row
      update: Row
    }) => {
      // Prisma compound-unique `where` arrives as { userId_clientId: { ... } }.
      const flattened = Object.values(where)[0] as Record<string, unknown>
      const existing = this.rows.find((row) => matches(row, flattened))
      if (existing) {
        Object.assign(existing, update)
        return { ...existing }
      }
      const row: Row = { id: nextId(this.idPrefix), ...this.defaults(), ...create }
      this.rows.push(row)
      return { ...row }
    },
  )
}

export function createOAuthStore() {
  const oAuthClient = new Table("client", () => ({
    clientSecretHash: null,
    logoUri: null,
    clientUri: null,
    softwareId: null,
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-09-18T00:00:00.000Z"),
    lastUsedAt: null,
  }))
  const oAuthAuthorizationCode = new Table("code", () => ({
    consumedAt: null,
    createdAt: new Date(),
  }))
  const oAuthToken = new Table("token", () => ({
    revokedAt: null,
    parentTokenId: null,
    scopeWorkspaceId: null,
    createdAt: new Date(),
    lastUsedAt: null,
  }))
  const oAuthConsent = new Table("consent", () => ({ grantedAt: new Date() }))
  const workspaceMember = new Table("workspace-member", () => ({}))
  const organizationMember = new Table("org-member", () => ({}))

  const prisma = {
    oAuthClient,
    oAuthAuthorizationCode,
    oAuthToken,
    oAuthConsent,
    workspaceMember,
    organizationMember,
  }

  return {
    prisma,
    ...prisma,
    reset() {
      for (const table of Object.values(prisma)) table.rows = []
      sequence = 0
    },
  }
}

export type OAuthStore = ReturnType<typeof createOAuthStore>
