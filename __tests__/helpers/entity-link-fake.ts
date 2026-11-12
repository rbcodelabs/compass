/**
 * In-memory stand-in for `prisma.entityLink`, for tests that exercise the typed-link writers and readers
 * (lib/typed-links.ts, lib/links/*) against hand-written fakes instead of a database.
 *
 * Supports the query shapes those modules issue: equality, `in`, `notIn`, `not`, `gt`/`lt`, AND/OR, `orderBy`, `take`,
 * `select`. Unknown where keys throw, so a new query shape cannot silently pass. `create` enforces the (fromId, linkType,
 * toId) unique key with a P2002 error and stamps a strictly increasing `createdAt`, so ordering assertions are deterministic.
 * Rows are plain objects held in the array the caller passes, so a transactional fake can clone and commit them with the
 * rest of its state.
 */
type Row = Record<string, unknown> & { id: string }
type Where = Record<string, unknown>

export type EntityLinkFakeRow = Row

let clock = 0

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return a === b ? 0 : (a as number) > (b as number) ? 1 : -1
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "AND") {
      const parts = Array.isArray(cond) ? cond : [cond]
      if (!parts.every((part) => matchesWhere(row, part as Where))) return false
      continue
    }
    if (key === "OR") {
      if (!(cond as Where[]).some((part) => matchesWhere(row, part))) return false
      continue
    }
    if (!(key in row)) throw new Error(`entity link fake: unsupported where key "${key}"`)
    const value = row[key]
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const op = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; gt?: unknown; lt?: unknown; gte?: unknown; lte?: unknown }
      if (op.in !== undefined) { if (!op.in.includes(value)) return false; continue }
      if (op.notIn !== undefined) { if (op.notIn.includes(value)) return false; continue }
      if (op.not !== undefined) { if (value === op.not) return false; continue }
      if (op.gt !== undefined) { if (value == null || compare(value, op.gt) <= 0) return false; continue }
      if (op.gte !== undefined) { if (value == null || compare(value, op.gte) < 0) return false; continue }
      if (op.lt !== undefined) { if (value == null || compare(value, op.lt) >= 0) return false; continue }
      if (op.lte !== undefined) { if (value == null || compare(value, op.lte) > 0) return false; continue }
      throw new Error(`entity link fake: unsupported operator on ${key}`)
    }
    if (value instanceof Date && cond instanceof Date ? value.getTime() !== cond.getTime() : value !== cond) return false
  }
  return true
}

function project(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return { ...row }
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on === true).map(([key]) => [key, row[key]])) as Row
}

/** A full link row as the app writes it; tests seed these directly. */
export function entityLinkRow(input: {
  id?: string
  workspaceId: string
  linkType: string
  fromType: string
  fromId: string
  toType: string
  toId: string
  origin?: string | null
  source?: string
  createdById?: string | null
  createdAt?: Date
}): Row {
  clock += 1
  return {
    id: input.id ?? `link-${clock}`,
    workspaceId: input.workspaceId,
    linkType: input.linkType,
    fromType: input.fromType,
    fromId: input.fromId,
    toType: input.toType,
    toId: input.toId,
    origin: input.origin ?? null,
    source: input.source ?? "UI",
    createdById: input.createdById ?? null,
    createdAt: input.createdAt ?? new Date(1_000 + clock),
    updatedAt: input.createdAt ?? new Date(1_000 + clock),
  }
}

export function createEntityLinkDelegate(rows: Row[]) {
  const matching = (where: Where | undefined) => rows.filter((row) => matchesWhere(row, where))
  return {
    findFirst: async (args: { where?: Where; select?: Record<string, unknown> } = {}) => {
      const row = matching(args.where)[0]
      return row ? project(row, args.select) : null
    },
    findUnique: async (args: { where: Where; select?: Record<string, unknown> }) => {
      const row = matching(args.where)[0]
      return row ? project(row, args.select) : null
    },
    findMany: async (args: { where?: Where; select?: Record<string, unknown>; take?: number; orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[] } = {}) => {
      const found = matching(args.where)
      const orderings = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : []
      for (const ordering of [...orderings].reverse()) {
        const [[field, direction]] = Object.entries(ordering)
        found.sort((a, b) => (direction === "desc" ? -compare(a[field], b[field]) : compare(a[field], b[field])))
      }
      const page = args.take ? found.slice(0, args.take) : found
      return page.map((row) => project(row, args.select))
    },
    count: async (args: { where?: Where } = {}) => matching(args.where).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (rows.some((row) => row.fromId === data.fromId && row.linkType === data.linkType && row.toId === data.toId)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { modelName: "EntityLink" } })
      }
      clock += 1
      const row = { id: `link-${clock}`, createdAt: new Date(1_000 + clock), updatedAt: new Date(1_000 + clock), ...data } as Row
      rows.push(row)
      return { ...row }
    },
    update: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const row = matching(where)[0]
      if (!row) throw new Error("Record to update not found.")
      Object.assign(row, data)
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const found = matching(where)
      for (const row of found) Object.assign(row, data)
      return { count: found.length }
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const doomed = matching(where)
      for (const row of doomed) rows.splice(rows.indexOf(row), 1)
      return { count: doomed.length }
    },
  }
}
