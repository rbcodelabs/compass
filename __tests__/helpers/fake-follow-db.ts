import { randomUUID } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"

/**
 * A tiny in-memory stand-in for the Prisma delegates the following feature
 * touches: follow, notification, workspaceMember, user, agent. It implements
 * only the operators the service code uses (equality, in, not null, lt/lte,
 * OR/AND) and mimics the two behaviours the design depends on: a unique index
 * rejecting duplicates with P2002, and createMany({skipDuplicates}).
 *
 * The real unique-index and ON CONFLICT behaviour is proven against Postgres in
 * follows-notifications-migration.integration.test.ts.
 */
type Row = Record<string, unknown>
type Where = Record<string, unknown>

function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    const c = condition as Record<string, unknown>
    if ("in" in c) return (c.in as unknown[]).includes(actual)
    if ("not" in c) return c.not === null ? actual !== null && actual !== undefined : actual !== c.not
    if ("lt" in c) return (actual as Date) < (c.lt as Date)
    if ("lte" in c) return (actual as Date) <= (c.lte as Date)
    if ("gt" in c) return (actual as Date) > (c.gt as Date)
    if ("gte" in c) return (actual as Date) >= (c.gte as Date)
    throw new Error(`fake db: unsupported operator ${JSON.stringify(Object.keys(c))}`)
  }
  if (condition === null) return actual === null || actual === undefined
  if (condition instanceof Date) return actual instanceof Date && actual.getTime() === condition.getTime()
  return actual === condition
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((clause) => matches(row, clause))
    if (key === "AND") return (condition as Where[]).every((clause) => matches(row, clause))
    return matchesValue(row[key], condition)
  })
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
}

function delegate(table: Row[], options: { defaults?: () => Row; unique?: string[][]; createdAtSort?: boolean } = {}) {
  const checkUnique = (candidate: Row) =>
    (options.unique ?? []).some((cols) => table.some((row) => cols.every((col) => row[col] === candidate[col])))
  const sorted = (rows: Row[], orderBy?: Row | Row[]) => {
    const clauses = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const [[field, direction]] = Object.entries(clause) as [[string, "asc" | "desc"]]
        const av = a[field] as Date | string
        const bv = b[field] as Date | string
        if (av < bv) return direction === "asc" ? -1 : 1
        if (av > bv) return direction === "asc" ? 1 : -1
      }
      return 0
    })
  }
  return {
    async findUnique({ where, select }: { where: Row; select?: Record<string, boolean> }) {
      const flat: Row = {}
      for (const [key, value] of Object.entries(where)) {
        if (value && typeof value === "object" && !(value instanceof Date)) Object.assign(flat, value)
        else flat[key] = value
      }
      const found = table.find((row) => matches(row, flat))
      return found ? project(found, select) : null
    },
    async findFirst({ where, select }: { where?: Where; select?: Record<string, boolean> } = {}) {
      const found = table.find((row) => matches(row, where))
      return found ? project(found, select) : null
    },
    async findMany({ where, select, take, orderBy }: { where?: Where; select?: Record<string, boolean>; take?: number; orderBy?: Row | Row[] } = {}) {
      const rows = sorted(table.filter((row) => matches(row, where)), orderBy)
      return rows.slice(0, take ?? rows.length).map((row) => project(row, select))
    },
    async create({ data }: { data: Row }) {
      const row = { ...options.defaults?.(), ...data }
      if (checkUnique(row)) throw uniqueViolation()
      table.push(row)
      return { ...row }
    },
    async createMany({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) {
      let count = 0
      for (const item of data) {
        const row = { ...options.defaults?.(), ...item }
        if (checkUnique(row)) {
          if (skipDuplicates) continue
          throw uniqueViolation()
        }
        table.push(row)
        count++
      }
      return { count }
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const target = table.find((row) => matches(row, where))
      if (!target) throw new Error("fake db: record to update not found")
      Object.assign(target, data)
      return { ...target }
    },
    async updateMany({ where, data }: { where?: Where; data: Row }) {
      const targets = table.filter((row) => matches(row, where))
      targets.forEach((row) => Object.assign(row, data))
      return { count: targets.length }
    },
    async deleteMany({ where }: { where?: Where } = {}) {
      const keep = table.filter((row) => !matches(row, where))
      const count = table.length - keep.length
      table.splice(0, table.length, ...keep)
      return { count }
    },
    async count({ where }: { where?: Where } = {}) {
      return table.filter((row) => matches(row, where)).length
    },
  }
}

export function createFakeFollowDb() {
  const tables = {
    follow: [] as Row[],
    notification: [] as Row[],
    workspaceMember: [] as Row[],
    user: [] as Row[],
    agent: [] as Row[],
    workspace: [] as Row[],
  }
  const now = () => new Date()
  const db = {
    follow: delegate(tables.follow, {
      defaults: () => ({ id: randomUUID(), createdAt: now(), updatedAt: now() }),
      unique: [["userId", "subjectType", "subjectId"]],
    }),
    notification: delegate(tables.notification, {
      defaults: () => ({ id: randomUUID(), readAt: null, actorId: null, payload: {}, createdAt: now() }),
      unique: [["recipientUserId", "dedupeKey"]],
    }),
    workspaceMember: delegate(tables.workspaceMember, { defaults: () => ({ id: randomUUID() }) }),
    user: delegate(tables.user),
    agent: delegate(tables.agent),
    workspace: delegate(tables.workspace),
  }
  return { db: db as unknown as AppPrismaClient, tables, member: (workspaceId: string, userId: string) => tables.workspaceMember.push({ id: randomUUID(), workspaceId, userId }) }
}
