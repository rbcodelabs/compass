/**
 * resolveDocEmbeds (spec docs phase 3): the batched, tenant-scoped read behind every embed card.
 *
 * The fake database below HONOURS the workspace filter the resolver sends and throws on a query that has none, so a missing filter shows up as a
 * real cross-tenant read rather than a mock that returns what the test told it to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DOC_EMBED_KINDS, type DocEmbedKind } from "@/lib/doc-embeds"
import { MAX_CARD_REFS } from "@/lib/canvas-cards"

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b"
const DOC_A = "dddddddd-0000-4000-8000-00000000000a"
const DOC_B = "dddddddd-0000-4000-8000-00000000000b"
const USER = "user-1"

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as { table: string; workspace: unknown }[],
  metrics: [] as { workspaceId: string; id: string; name: string }[],
  dashboardCalls: 0,
}))

/** workspace the query is scoped to (directly, or through the owning objective / solution), and the workspace a row lives in. */
const scopeOf = (where: Row) => where.workspaceId ?? (where.objective as Row | undefined)?.workspaceId ?? (where.solution as Row | undefined)?.workspaceId
const homeOf = (row: Row) => row.workspaceId ?? (row.objective as Row | undefined)?.workspaceId ?? (row.solution as Row | undefined)?.workspaceId

function table(name: string) {
  return {
    findMany: async ({ where }: { where: Row }) => {
      const workspace = scopeOf(where)
      state.queries.push({ table: name, workspace })
      if (!workspace) throw new Error(`unscoped ${name} query`)
      const ids = (where.id as { in?: string[] } | undefined)?.in
      return (state.tables[name] ?? []).filter((row) => (!ids || ids.includes(row.id as string)) && homeOf(row) === workspace && (where.archived === undefined || row.archived === where.archived))
    },
    findFirst: async ({ where }: { where: Row }) => {
      state.queries.push({ table: name, workspace: where.workspaceId })
      return (state.tables[name] ?? []).find((row) => row.id === where.id && (!where.workspaceId || row.workspaceId === where.workspaceId)) ?? null
    },
  }
}

vi.mock("@/lib/db", () => ({
  default: () =>
    new Proxy({}, { get: (_target, name: string) => table(name) }),
}))
vi.mock("@/lib/analytics/service", () => ({
  listDashboardMetrics: async (_actor: unknown, workspaceId: string) => {
    state.dashboardCalls++
    return state.metrics
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => ({ metric: { id: m.id, name: m.name, unit: "" }, status: "FRESH", statusCaption: "Updated", value: 12, delta: null }))
  },
}))

import { resolveDocEmbeds } from "@/lib/canvas-card-data"

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ID: Record<DocEmbedKind, string> = Object.fromEntries(DOC_EMBED_KINDS.map((kind, i) => [kind, uuid(i + 1)])) as Record<DocEmbedKind, string>
const TABLE: Record<DocEmbedKind, string> = {
  opportunity: "opportunity", solution: "solution", experiment: "experiment", task: "task", doc: "doc", objective: "objective",
  keyResult: "keyResult", assumption: "assumption", roadmapItem: "roadmapItem", metric: "metric", artifact: "artifact",
}

/** A row for `kind` living in `workspaceId`. */
function rowFor(kind: DocEmbedKind, workspaceId: string, extra: Row = {}): Row {
  const base = { id: ID[kind], title: `Live ${kind}`, status: "ACTIVE", updatedAt: new Date("2026-02-03T00:00:00Z") }
  switch (kind) {
    case "keyResult": return { ...base, objective: { workspaceId }, current: 3, target: 10, unit: "%", ...extra }
    case "assumption": return { ...base, solution: { workspaceId, opportunityId: uuid(900), title: "Parent solution" }, riskLevel: "HIGH", ...extra }
    case "objective": return { ...base, workspaceId, owner: "Pat", keyResults: [{ current: 5, target: 10 }], ...extra }
    case "doc": return { ...base, workspaceId, docType: "STANDARD", ...extra }
    case "artifact": return { ...base, workspaceId, kind: null, ...extra }
    default: return { ...base, workspaceId, ...extra }
  }
}

function seed(kind: DocEmbedKind, workspaceId: string, extra: Row = {}) {
  if (kind === "metric") {
    if (extra.archived) {
      state.tables.metricDefinition = [{ id: ID.metric, workspaceId, archived: true, currentRevisionId: uuid(800) }]
      state.tables.metricRevision = [{ id: uuid(800), workspaceId, name: "Live metric" }]
    } else {
      state.metrics.push({ workspaceId, id: ID.metric, name: "Live metric" })
    }
    return
  }
  ;(state.tables[TABLE[kind]] ??= []).push(rowFor(kind, workspaceId, extra))
}

const refsOf = (...kinds: DocEmbedKind[]) => kinds.map((kind) => ({ kind, id: ID[kind] }))
const key = (kind: DocEmbedKind) => `${kind}:${ID[kind]}`

beforeEach(() => {
  state.tables = {
    doc: [
      { id: DOC_A, workspaceId: WS_A, workspace: { slug: "alpha", organization: { slug: "acme" } } },
      { id: DOC_B, workspaceId: WS_B, workspace: { slug: "beta", organization: { slug: "globex" } } },
    ],
  }
  state.queries = []
  state.metrics = []
  state.dashboardCalls = 0
})

// The `doc` table holds the doc rows themselves too; embedded "doc" records are appended to the same table.
const run = (kinds: DocEmbedKind[], extra: Partial<Parameters<typeof resolveDocEmbeds>[0]> = {}) =>
  resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: refsOf(...kinds), ...extra })

describe.each(DOC_EMBED_KINDS)("resolveDocEmbeds: %s", (kind) => {
  it("ok: live title, status and an href into the DOC's workspace", async () => {
    seed(kind, WS_A)
    const result = await run([kind])
    const card = result!.cards[key(kind)]
    expect(card).toMatchObject({ state: "ok", kind, id: ID[kind], title: `Live ${kind}` })
    if (card.state === "ok") {
      expect(card.href.startsWith("/acme/alpha")).toBe(true)
      expect(card.href).not.toContain("globex")
    }
  })

  it("missing: unavailable", async () => {
    expect((await run([kind]))!.cards[key(kind)]).toEqual({ state: "unavailable", kind, id: ID[kind] })
  })

  it("foreign workspace: unavailable, and byte-identical to the missing result", async () => {
    const missing = await run([kind])
    seed(kind, WS_B)
    const foreign = await run([kind])
    expect(foreign!.cards[key(kind)]).toEqual({ state: "unavailable", kind, id: ID[kind] })
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing))
  })

  it("restricted contexts (participant, PM interview, synthesis): unavailable, and no record is read", async () => {
    seed(kind, WS_A)
    for (const context of ["participant", "pm-interview", "synthesis"] as const) {
      state.queries = []
      state.dashboardCalls = 0
      const result = await run([kind], { context })
      expect(result!.cards[key(kind)]).toEqual({ state: "unavailable", kind, id: ID[kind] })
      // Only the doc row itself (for its workspace) is read; nothing of the embedded record.
      expect(state.queries.filter((q) => !(q.table === "doc" && q.workspace === undefined))).toEqual([])
      expect(state.dashboardCalls).toBe(0)
    }
  })

  it("archived or killed records resolve normally with their status", async () => {
    const status = kind === "experiment" ? "KILLED" : "ARCHIVED"
    seed(kind, WS_A, kind === "metric" ? { archived: true } : { status })
    const card = (await run([kind]))!.cards[key(kind)]
    expect(card.state).toBe("ok")
    if (card.state === "ok" && kind !== "doc" && kind !== "keyResult") expect(card.status).toBe(status)
  })
})

describe("resolveDocEmbeds: tenancy", () => {
  it("uses the DOC's workspace even when the reference is forged to name another", async () => {
    seed("task", WS_B)
    const forged = [{ kind: "task", id: ID.task, workspaceId: WS_B, workspace: "globex/beta", orgSlug: "globex" }]
    const result = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: forged })
    expect(result!.cards[key("task")]).toEqual({ state: "unavailable", kind: "task", id: ID.task })
    const taskQueries = state.queries.filter((q) => q.table === "task")
    expect(taskQueries.length).toBeGreaterThan(0)
    expect(taskQueries.every((q) => q.workspace === WS_A)).toBe(true)
  })

  it("every record query carries the doc's workspace, for a mixed batch", async () => {
    for (const kind of DOC_EMBED_KINDS) seed(kind, WS_A)
    const result = await run([...DOC_EMBED_KINDS])
    expect(Object.values(result!.cards).every((c) => c.state === "ok")).toBe(true)
    expect(state.queries.filter((q) => q.table !== "doc" || q.workspace !== undefined).every((q) => q.workspace === WS_A)).toBe(true)
  })

  it("a doc in another workspace than the caller declared, a missing doc and a malformed id all read as null", async () => {
    expect(await resolveDocEmbeds({ docId: DOC_B, userId: USER, refs: [], expectedWorkspaceId: WS_A })).toBeNull()
    expect(await resolveDocEmbeds({ docId: uuid(404), userId: USER, refs: [] })).toBeNull()
    expect(await resolveDocEmbeds({ docId: "not-a-uuid", userId: USER, refs: [] })).toBeNull()
    expect(await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: [], expectedWorkspaceId: WS_A })).toEqual({ cards: {}, deferred: [] })
  })

  it("ignores malformed references and unknown kinds instead of throwing", async () => {
    const result = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: [null, "x", { kind: "nope", id: ID.task }, { kind: "task", id: "zzz" }, { kind: "task" }] })
    expect(result).toEqual({ cards: {}, deferred: [] })
  })
})

describe("resolveDocEmbeds: MAX_CARD_REFS", () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "task", id: uuid(1000 + i) }))

  it("resolves at most MAX_CARD_REFS per request and reports the rest as deferred", async () => {
    state.tables.task = tasks(MAX_CARD_REFS + 5).map((ref) => ({ id: ref.id, workspaceId: WS_A, title: "T", status: "TODO" }))
    const result = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: tasks(MAX_CARD_REFS + 5) })
    expect(Object.keys(result!.cards)).toHaveLength(MAX_CARD_REFS)
    expect(result!.deferred).toHaveLength(5)
    expect(result!.deferred.map((r) => r.id)).toEqual(tasks(MAX_CARD_REFS + 5).slice(MAX_CARD_REFS).map((r) => r.id))
  })

  it("a deferred reference resolves in a follow-up request", async () => {
    state.tables.task = tasks(MAX_CARD_REFS + 1).map((ref) => ({ id: ref.id, workspaceId: WS_A, title: "T", status: "TODO" }))
    const first = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: tasks(MAX_CARD_REFS + 1) })
    const second = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs: first!.deferred })
    expect(Object.values(second!.cards)).toMatchObject([{ state: "ok", id: first!.deferred[0].id }])
    expect(second!.deferred).toEqual([])
  })

  it("duplicates (and case variants of one id) count once", async () => {
    const id = uuid(1)
    const refs = [{ kind: "task", id }, { kind: "task", id: id.toUpperCase() }, { kind: "task", id }]
    const result = await resolveDocEmbeds({ docId: DOC_A, userId: USER, refs })
    expect(Object.keys(result!.cards)).toEqual([`task:${id}`])
  })
})
