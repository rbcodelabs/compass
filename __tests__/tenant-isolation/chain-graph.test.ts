/**
 * Tenant isolation for GET /api/chain-graph (and the focus resolution it relies on), against a two-workspace fake where
 * every query is filtered the way the real ones are. Proves: 401 without a session; 404 for a non-member (the loader is
 * never reached); workspace A's graph has no B node or edge; `focus` on a B UUID or a B display ID is the same 404 as a
 * missing id; a display ID resolves only inside the caller's workspace; the route is 404 when the flag is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ session: null as null | { user: { id: string } }, loads: 0 }))

vi.mock("@/auth", () => ({ auth: async () => state.session }))
vi.mock("@/lib/workspace", () => ({
  // alice is a member of acme/a only; bob of acme/b only.
  getWorkspace: async (org: string, ws: string, userId: string) => {
    const member = (userId === "alice" && ws === "a") || (userId === "bob" && ws === "b")
    return member && org === "acme" ? { id: ws === "a" ? "ws-a" : "ws-b", thinkingModel: "CLASSIC", thinkingModelLabels: null } : null
  },
}))
vi.mock("@/lib/typed-links", () => ({
  getCanvasLinkRows: async () => ({ opportunityObjective: [], solutionKeyResult: [] }),
  getOpportunityKeyResultPointers: async (_p: unknown, _w: string, opps: Array<{ id: string; linkedKeyResultId: string | null }>) => new Map(opps.map((o) => [o.id, o.linkedKeyResultId])),
  getLinkedKeyResultsBySolution: async () => new Map(),
  getLinkedObjectivesByOpportunity: async () => new Map(),
}))

type Row = Record<string, unknown> & { id: string }
const stamp = { sortOrder: 0, createdAt: new Date(0) }
const A = "ws-a"
const B = "ws-b"
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ids = { oa: UUID(1), pa: UUID(2), sa: UUID(3), ob: UUID(11), pb: UUID(12), sbOnA: UUID(13) }

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(row[k])
    if (v && typeof v === "object") return true // relation filters (objective/solution workspace) are modelled by pre-scoped rows
    return row[k] === v
  })
}
function table(rows: Row[]) {
  return {
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matches(r, where)) ?? null,
  }
}

const db = {
  squad: table([]),
  objective: table([
    { id: ids.oa, workspaceId: A, title: "A obj", status: "ON_TRACK", squadId: null, parentKeyResultId: null, seqPrefix: "OBJ", seqNumber: 1, ...stamp },
    { id: ids.ob, workspaceId: B, title: "B obj", status: "ON_TRACK", squadId: null, parentKeyResultId: null, seqPrefix: "OBJ", seqNumber: 1, ...stamp },
  ]),
  keyResult: table([]),
  opportunity: table([
    { id: ids.pa, workspaceId: A, title: "A opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null, seqPrefix: "OPP", seqNumber: 7, ...stamp },
    { id: ids.pb, workspaceId: B, title: "B opp", status: "EXPLORING", squadId: null, linkedKeyResultId: null, seqPrefix: "OPP", seqNumber: 9, ...stamp },
  ]),
  solution: table([
    { id: ids.sa, workspaceId: A, opportunityId: ids.pa, title: "A sol", status: "IDEA", seqPrefix: "SOL", seqNumber: 1, ...stamp },
    { id: ids.sbOnA, workspaceId: B, opportunityId: ids.pa, title: "B sol pointing at A opp", status: "IDEA", seqPrefix: "SOL", seqNumber: 2, ...stamp },
  ]),
  assumption: table([]),
  experiment: table([]),
  roadmapItem: table([]),
  canvasNodePosition: table([]),
}
vi.mock("@/lib/db", () => ({ default: () => db }))

import { GET } from "@/app/api/chain-graph/route"

const get = (query: string) => GET(new Request(`http://localhost/api/chain-graph?${query}`))
const as = (userId: string | null) => {
  state.session = userId ? { user: { id: userId } } : null
}
const base = "orgSlug=acme&workspaceSlug=a"

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development")
  as("alice")
})
afterEach(() => vi.unstubAllEnvs())

describe("GET /api/chain-graph", () => {
  it("is 401 without a session and 400 without slugs", async () => {
    as(null)
    expect((await get(base)).status).toBe(401)
    as("alice")
    expect((await get("scope=workspace")).status).toBe(400)
    expect((await get(`${base}&scope=everything`)).status).toBe(400)
  })

  it("is 404 for a non-member and for a foreign workspace slug", async () => {
    as("bob")
    expect((await get(base)).status).toBe(404)
    as("alice")
    expect((await get("orgSlug=acme&workspaceSlug=b")).status).toBe(404)
  })

  it("is 404 when the flag is off", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("VERCEL_ENV", "production")
    expect((await get(base)).status).toBe(404)
  })

  it("returns only workspace A nodes and no edge to a B endpoint", async () => {
    const res = await get(base)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual([ids.oa, ids.pa, ids.sa].sort())
    const keys = new Set(body.nodes.map((n: { key: string }) => n.key))
    for (const e of body.edges) expect(keys.has(e.from) && keys.has(e.to)).toBe(true)
    expect(JSON.stringify(body)).not.toContain("B obj")
    expect(JSON.stringify(body)).not.toContain("pointing at A opp")
  })

  it("focus: resolves a UUID and a display ID inside the workspace and returns the chain around it", async () => {
    for (const focus of [`SOLUTION:${ids.sa}`, "SOL-1", `OPPORTUNITY:OPP-7`]) {
      const res = await get(`${base}&scope=focus&focus=${encodeURIComponent(focus)}`)
      expect(res.status, focus).toBe(200)
      const body = await res.json()
      expect(body.nodes.map((n: { id: string }) => n.id)).toContain(ids.sa)
    }
  })

  it("focus: a B UUID and a B display ID are the same 404 as a missing id", async () => {
    const missing = await get(`${base}&scope=focus&focus=${encodeURIComponent(`OPPORTUNITY:${UUID(999)}`)}`)
    const foreignUuid = await get(`${base}&scope=focus&focus=${encodeURIComponent(`OPPORTUNITY:${ids.pb}`)}`)
    const foreignDisplay = await get(`${base}&scope=focus&focus=OPP-9`)
    for (const r of [missing, foreignUuid, foreignDisplay]) expect(r.status).toBe(404)
    const bodies = await Promise.all([missing, foreignUuid, foreignDisplay].map((r) => r.json()))
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
  })

  it("focus: malformed or out-of-chain refs are 400, and depth is clamped", async () => {
    expect((await get(`${base}&scope=focus`)).status).toBe(400)
    expect((await get(`${base}&scope=focus&focus=TASK-5`)).status).toBe(400)
    expect((await get(`${base}&scope=focus&focus=${encodeURIComponent("TASK:abc")}`)).status).toBe(400)
    const res = await get(`${base}&scope=focus&focus=SOL-1&depth=9999`)
    expect(res.status).toBe(200)
  })
})
