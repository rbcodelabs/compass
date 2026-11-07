import { describe, expect, it } from "vitest"
import { StuckDeleteError } from "@/lib/workspace-export/leaf-first"
import { sweepWorkspaceOwnedRows } from "@/lib/workspace-export/sweep"
import { delegateKey } from "@/lib/workspace-export/scope"

/**
 * Unit tests for the deletion sweep against an in-memory client that, unlike the hand-built mocks elsewhere, honours paging
 * (take/cursor/skip), `where` (equality and `in`) and Prisma's emulated Restrict (P2014), so the loops are really exercised.
 * The same sweep runs against real Postgres in workspace-export-coverage.integration.test.ts.
 */
type Row = Record<string, unknown> & { id: string }

function prismaError(code: string, message = code) {
  return Object.assign(new Error(message), { code })
}

function createFake(initial: Record<string, Row[]>, options: { missing?: string[]; alwaysBlocked?: string[]; selfRef?: Record<string, string> } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, [...v]]))
  const statements: { model: string; op: string; ids: number }[] = []

  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === "object" && "in" in (cond as object)) return ((cond as { in: unknown[] }).in).includes(row[key])
      return row[key] === cond
    })

  const delegate = (model: string) => ({
    async findMany(args: { where: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number }) {
      statements.push({ model, op: "findMany", ids: 0 })
      if (options.missing?.includes(model)) throw prismaError("P2021")
      let rows = (tables[model] ?? []).filter((r) => matches(r, args.where)).sort((a, b) => a.id.localeCompare(b.id))
      if (args.cursor) rows = rows.slice(rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0))
      if (args.take !== undefined) rows = rows.slice(0, args.take)
      return rows.map((r) => ({ ...r }))
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      const rows = tables[model] ?? []
      const doomed = rows.filter((r) => matches(r, args.where))
      const idCount = (args.where.id as { in?: unknown[] } | undefined)?.in?.length ?? 1
      statements.push({ model, op: "deleteMany", ids: idCount })
      if (options.missing?.includes(model)) throw prismaError("P2021")
      if (options.alwaysBlocked?.includes(model) && doomed.length) throw prismaError("P2014", "blocked forever")
      // Emulated Restrict on a self-reference: refuses to delete a row that is anyone's parent, even if that child is in the same statement.
      const parentKey = options.selfRef?.[model]
      if (parentKey && doomed.some((d) => rows.some((r) => r[parentKey] === d.id))) throw prismaError("P2014", "self reference")
      tables[model] = rows.filter((r) => !doomed.includes(r))
      return { count: doomed.length }
    },
  })

  const client = new Proxy({}, { get: (_t, key: string) => delegate(key) })
  return { client, tables, statements }
}

const WS = "ws-1"
const OTHER = "ws-2"
const key = (model: string) => delegateKey(model)

describe("sweepWorkspaceOwnedRows", () => {
  it("pages past one query and keeps every delete statement small, and never touches another workspace", async () => {
    const mine = Array.from({ length: 1250 }, (_, i) => ({ id: `a${String(i).padStart(5, "0")}`, workspaceId: WS }))
    const theirs = Array.from({ length: 40 }, (_, i) => ({ id: `b${String(i).padStart(5, "0")}`, workspaceId: OTHER }))
    const fake = createFake({ [key("Task")]: [...mine, ...theirs] })

    const removed = await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Task"] })

    expect(removed.Task).toBe(1250)
    expect(fake.tables[key("Task")].map((r) => r.workspaceId)).toEqual(Array(40).fill(OTHER))
    const deletes = fake.statements.filter((s) => s.model === key("Task") && s.op === "deleteMany")
    expect(Math.max(...deletes.map((s) => s.ids))).toBeLessThanOrEqual(250)
    expect(deletes.length).toBeGreaterThanOrEqual(5)
  })

  it("removes children before parents and finds children through their parents' ids only", async () => {
    const fake = createFake({
      [key("Doc")]: [{ id: "d1", workspaceId: WS }, { id: "d2", workspaceId: OTHER }],
      [key("DocVersion")]: [{ id: "v1", docId: "d1" }, { id: "v2", docId: "d1" }, { id: "v3", docId: "d2" }],
      [key("DocComment")]: [{ id: "c1", docId: "d1", parentId: null }, { id: "c2", docId: "d2", parentId: null }],
    })
    const order: string[] = []
    await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["DocVersion", "DocComment", "Doc"] })
    for (const s of fake.statements.filter((s) => s.op === "deleteMany")) order.push(s.model)

    expect(order.indexOf(key("DocVersion"))).toBeLessThan(order.indexOf(key("Doc")))
    expect(order.indexOf(key("DocComment"))).toBeLessThan(order.indexOf(key("Doc")))
    expect(fake.tables[key("Doc")].map((r) => r.id)).toEqual(["d2"])
    expect(fake.tables[key("DocVersion")].map((r) => r.id)).toEqual(["v3"])
    expect(fake.tables[key("DocComment")].map((r) => r.id)).toEqual(["c2"])
  })

  it("deletes a deep self-referencing thread leaf-first when a single statement is refused (P2014)", async () => {
    const fake = createFake(
      { [key("Comment")]: [{ id: "c1", workspaceId: WS, parentId: null }, { id: "c2", workspaceId: WS, parentId: "c1" }, { id: "c3", workspaceId: WS, parentId: "c2" }, { id: "c4", workspaceId: WS, parentId: "c3" }] },
      { selfRef: { [key("Comment")]: "parentId" } },
    )
    const removed = await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Comment"] })
    expect(removed.Comment).toBe(4)
    expect(fake.tables[key("Comment")]).toEqual([])
  })

  it("throws a StuckDeleteError naming the model when nothing can make progress", async () => {
    const fake = createFake({ [key("Squad")]: [{ id: "s1", workspaceId: WS }] }, { alwaysBlocked: [key("Squad")] })
    const run = sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Squad"] })
    await expect(run).rejects.toBeInstanceOf(StuckDeleteError)
    await expect(sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Squad"] })).rejects.toThrow(/Squad/)
    expect(fake.tables[key("Squad")]).toHaveLength(1)
  })

  it("skips a table whose migration has not run (P2021) and still deletes the rest", async () => {
    const fake = createFake(
      { [key("Doc")]: [{ id: "d1", workspaceId: WS }], [key("WorkspaceModule")]: [{ id: "m1", workspaceId: WS }] },
      { missing: [key("WorkspaceModule")] },
    )
    const removed = await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Doc", "WorkspaceModule"] })
    expect(removed.Doc).toBe(1)
    expect(removed.WorkspaceModule).toBeUndefined()
    expect(fake.tables[key("Doc")]).toEqual([])
  })

  it("rejects models it must not sweep: non-content models and workspace-owned Agents", async () => {
    const fake = createFake({})
    await expect(sweepWorkspaceOwnedRows(fake.client, WS, { only: ["User"] })).rejects.toThrow(/not a sweepable content model/)
    await expect(sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Agent"] })).rejects.toThrow(/not a sweepable content model/)
  })

  it("is safe to run twice", async () => {
    const fake = createFake({ [key("Squad")]: [{ id: "s1", workspaceId: WS }] })
    expect((await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Squad"] })).Squad).toBe(1)
    expect((await sweepWorkspaceOwnedRows(fake.client, WS, { only: ["Squad"] })).Squad ?? 0).toBe(0)
  })
})
