/** The spec docs read models (phase 3): the specs listed on a scope and the scopes shown on a spec doc, against the tenant fake. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }))
const docService = vi.hoisted(() => ({ created: 0 }))

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }))
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}))
vi.mock("@/lib/document-service", () => ({
  documentRevision: (doc: { revision: string | null }) => doc.revision ?? "legacy",
  createDocument: vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `doc-new-${++docService.created}`, revision: `rev-${docService.created}`, createdAt: new Date(2_000 + docService.created), updatedAt: new Date(2_000 + docService.created), ...input }
    fake.current!.state.docs.push(row)
    return row
  }),
  deleteDocument: vi.fn(),
}))

import { createSpecCore } from "@/lib/spec-docs/create"
import { loadScopeSpecItems, loadSpecScopeViews, sortSpecsByUpdated } from "@/lib/spec-docs/view"
import { specKindLabels, humanizeStatus, UNSCOPED_SPEC_LABEL, DOC_EMBED_KIND_LABEL } from "@/lib/spec-docs/labels"
import { DOC_EMBED_KINDS } from "@/lib/doc-embeds"

const actor = { userId: "user-alice", authorName: "Alice", source: "UI" as const }
const slugs = { orgSlug: WS_A.org, workspaceSlug: WS_A.slug }
const state = () => fake.current!.state
const make = (scopeType: "SOLUTION" | "OPPORTUNITY", scopeId: string, label?: string) => createSpecCore({ workspaceId: WS_A.id, scopeType, scopeId, label }, actor)
const touch = (docId: string, iso: string) => { state().docs.find((d) => d.id === docId)!.updatedAt = new Date(iso) }

beforeEach(() => {
  fake.current = createTenantFakePrisma()
  docService.created = 0
})

describe("sortSpecsByUpdated", () => {
  it("newest first, ties by id", () => {
    const rows = [
      { id: "b", updatedAt: new Date("2026-01-01") },
      { id: "c", updatedAt: new Date("2026-03-01") },
      { id: "a", updatedAt: new Date("2026-01-01") },
    ]
    expect(sortSpecsByUpdated(rows).map((r) => r.id)).toEqual(["c", "a", "b"])
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]) // input untouched
  })
})

describe("loadScopeSpecItems", () => {
  it("empty for a scope with no specs (not null: the scope exists)", async () => {
    expect(await loadScopeSpecItems({ workspaceId: WS_A.id, ...slugs, scopeType: "SOLUTION", scopeId: "sol-a" })).toEqual([])
  })

  it("lists every spec, ordered by updatedAt, with label and a link to the doc; nothing assumes one per scope", async () => {
    await make("SOLUTION", "sol-a", "v1")
    await make("SOLUTION", "sol-a")
    await make("SOLUTION", "sol-a", "v3")
    touch("doc-new-1", "2026-03-01T00:00:00Z")
    touch("doc-new-2", "2026-01-01T00:00:00Z")
    touch("doc-new-3", "2026-05-01T00:00:00Z")
    const items = await loadScopeSpecItems({ workspaceId: WS_A.id, ...slugs, scopeType: "SOLUTION", scopeId: "sol-a" })
    expect(items!.map((i) => [i.id, i.label])).toEqual([["doc-new-3", "v3"], ["doc-new-1", "v1"], ["doc-new-2", null]])
    expect(items![0]).toMatchObject({ href: "/acme/alpha/docs/doc-new-3", updatedAt: "2026-05-01T00:00:00.000Z" })
  })

  it("an opportunity lists its plans, and a foreign or missing scope is null", async () => {
    await make("OPPORTUNITY", "opp-a")
    expect((await loadScopeSpecItems({ workspaceId: WS_A.id, ...slugs, scopeType: "OPPORTUNITY", scopeId: "opp-a" }))!.map((i) => i.id)).toEqual(["doc-new-1"])
    expect(await loadScopeSpecItems({ workspaceId: WS_A.id, ...slugs, scopeType: "OPPORTUNITY", scopeId: "opp-b" })).toBeNull()
    expect(await loadScopeSpecItems({ workspaceId: WS_B.id, orgSlug: WS_B.org, workspaceSlug: WS_B.slug, scopeType: "OPPORTUNITY", scopeId: "opp-a" })).toBeNull()
  })
})

describe("loadSpecScopeViews", () => {
  it("returns the scope with its live title and a link", async () => {
    await make("SOLUTION", "sol-a")
    const views = await loadSpecScopeViews({ workspaceId: WS_A.id, ...slugs, docId: "doc-new-1" })
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ scopeType: "SOLUTION", scopeId: "sol-a", title: "A solution" })
    expect(views[0].href.startsWith("/acme/alpha")).toBe(true)
  })

  it("is empty (the unscoped state) once the scope is deleted, and never throws", async () => {
    await make("SOLUTION", "sol-a")
    state().solutions.splice(state().solutions.findIndex((s) => s.id === "sol-a"), 1)
    expect(await loadSpecScopeViews({ workspaceId: WS_A.id, ...slugs, docId: "doc-new-1" })).toEqual([])
  })

  it("is empty for a doc id in another workspace", async () => {
    await make("SOLUTION", "sol-a")
    expect(await loadSpecScopeViews({ workspaceId: WS_B.id, orgSlug: WS_B.org, workspaceSlug: WS_B.slug, docId: "doc-new-1" })).toEqual([])
  })
})

describe("labels", () => {
  it("Spec for a solution, Discovery Plan for an opportunity, both for both, unscoped for none", () => {
    expect(specKindLabels(["SOLUTION"])).toEqual(["Spec"])
    expect(specKindLabels(["OPPORTUNITY"])).toEqual(["Discovery Plan"])
    expect(specKindLabels(["OPPORTUNITY", "SOLUTION", "SOLUTION"])).toEqual(["Spec", "Discovery Plan"])
    expect(specKindLabels([])).toEqual([UNSCOPED_SPEC_LABEL])
    expect(UNSCOPED_SPEC_LABEL).toBe("Spec (unscoped)")
  })

  it("every embed kind has a label, and statuses read as words", () => {
    for (const kind of DOC_EMBED_KINDS) expect(DOC_EMBED_KIND_LABEL[kind].length).toBeGreaterThan(0)
    expect(humanizeStatus("IN_PROGRESS")).toBe("In progress")
    expect(humanizeStatus("")).toBe("")
  })
})
