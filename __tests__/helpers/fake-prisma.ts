/**
 * A small in-memory stand-in for the Prisma client, just rich enough for the delete/prune code paths:
 * findMany / findFirst / findUnique / count / updateMany / deleteMany / delete, with the filter operators
 * those paths use (equality, in, notIn, lt, lte, gt, gte, not, AND, OR, null). It records every call so tests can
 * assert ordering and batching, and can simulate a table that has not been migrated (Prisma's P2021).
 */
export type Row = Record<string, unknown>

export interface FakeCall {
  model: string
  op: string
  where?: unknown
  count?: number
}

type Operator = { in?: unknown[]; notIn?: unknown[]; lt?: Date | number; lte?: Date | number; gt?: unknown; gte?: Date | number; not?: unknown }

const isOperator = (value: unknown): value is Operator =>
  typeof value === "object" && value !== null && !(value instanceof Date) && Object.keys(value).some((key) => ["in", "notIn", "lt", "lte", "gt", "gte", "not"].includes(key))

const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : value)

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (isOperator(expected)) {
    const a = comparable(actual) as number
    if (expected.in && !expected.in.includes(actual)) return false
    if (expected.notIn && expected.notIn.includes(actual)) return false
    if (expected.lt !== undefined && !(a < (comparable(expected.lt) as number))) return false
    if (expected.lte !== undefined && !(a <= (comparable(expected.lte) as number))) return false
    if (expected.gt !== undefined && !(a > (comparable(expected.gt) as number))) return false
    if (expected.gte !== undefined && !(a >= (comparable(expected.gte) as number))) return false
    if ("not" in expected && matchesValue(actual, expected.not) === true) return false
    return true
  }
  if (expected === null) return actual === null || actual === undefined
  return comparable(actual) === comparable(expected)
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") return (Array.isArray(expected) ? expected : [expected]).every((clause) => matches(row, clause as Record<string, unknown>))
    if (key === "OR") return (expected as Record<string, unknown>[]).some((clause) => matches(row, clause))
    return matchesValue(row[key], expected)
  })
}

export function createFakePrisma(seed: Record<string, Row[]> = {}, options: { missingTables?: string[]; failOn?: (model: string, op: string) => Error | null } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]))
  const calls: FakeCall[] = []
  const missing = new Set(options.missingTables ?? [])
  const rowsOf = (model: string) => (tables[model] ??= [])

  const delegate = (model: string) => {
    const guard = (op: string, where?: unknown) => {
      calls.push({ model, op, where })
      if (missing.has(model)) throw Object.assign(new Error(`The table for ${model} does not exist`), { code: "P2021" })
      const failure = options.failOn?.(model, op)
      if (failure) throw failure
    }
    return {
      findMany: async (args: { where?: Record<string, unknown>; take?: number; orderBy?: { id?: "asc" | "desc" } } = {}) => {
        guard("findMany", args.where)
        let rows = rowsOf(model).filter((row) => matches(row, args.where))
        if (args.orderBy?.id) rows = [...rows].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)
        return (args.take ? rows.slice(0, args.take) : rows).map((row) => ({ ...row }))
      },
      findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
        guard("findFirst", args.where)
        const row = rowsOf(model).find((candidate) => matches(candidate, args.where))
        return row ? { ...row } : null
      },
      findUnique: async (args: { where: Record<string, unknown> }) => {
        guard("findUnique", args.where)
        const row = rowsOf(model).find((candidate) => matches(candidate, args.where))
        return row ? { ...row } : null
      },
      count: async (args: { where?: Record<string, unknown> } = {}) => {
        guard("count", args.where)
        return rowsOf(model).filter((row) => matches(row, args.where)).length
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Row }) => {
        guard("updateMany", args.where)
        const hit = rowsOf(model).filter((row) => matches(row, args.where))
        for (const row of hit) Object.assign(row, args.data)
        calls[calls.length - 1].count = hit.length
        return { count: hit.length }
      },
      deleteMany: async (args: { where?: Record<string, unknown> } = {}) => {
        guard("deleteMany", args.where)
        const keep = rowsOf(model).filter((row) => !matches(row, args.where))
        const count = rowsOf(model).length - keep.length
        tables[model] = keep
        calls[calls.length - 1].count = count
        return { count }
      },
      delete: async (args: { where: Record<string, unknown> }) => {
        guard("delete", args.where)
        const hit = rowsOf(model).find((row) => matches(row, args.where))
        if (!hit) throw Object.assign(new Error("Record to delete does not exist"), { code: "P2025" })
        tables[model] = rowsOf(model).filter((row) => row !== hit)
        return hit
      },
    }
  }

  const delegates = new Map<string, ReturnType<typeof delegate>>()
  const prisma = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined
      if (!delegates.has(property)) delegates.set(property, delegate(property))
      return delegates.get(property)
    },
  })
  return { prisma: prisma as never, tables, calls, rows: (model: string) => rowsOf(model) }
}
