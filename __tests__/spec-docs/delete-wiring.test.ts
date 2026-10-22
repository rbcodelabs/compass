/**
 * Delete wiring for DOC_SPECIFIES_SCOPE: every way of deleting a doc ends in deleteDocument, which sweeps the doc's scope links, and
 * deleting a solution or opportunity sweeps the link from the other side. Neither leaves an orphan link; neither deletes the other end.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | { client: Record<string, unknown> } }))
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }))
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}))

import { deleteDocById, deletePath } from "@/lib/doc-fs"
import { deleteDocument } from "@/lib/document-service"
import { deleteLinksForEntity, linkEntities } from "@/lib/links/service"
import { getLinkType } from "@/lib/links/registry"
import type { AppTransactionClient } from "@/lib/db"

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf-8")
const actor = { authorName: "Tester" }

let tenant: ReturnType<typeof createTenantFakePrisma>
const linkRows = () => tenant.state.entityLinks.filter((l) => l.linkType === "DOC_SPECIFIES_SCOPE")

beforeEach(async () => {
  tenant = createTenantFakePrisma()
  // The fake's doc table plus the two child tables deleteDocument empties, and a transaction that hands back this same client.
  const client: Record<string, unknown> = {
    ...tenant.client,
    docVersion: { deleteMany: async () => ({ count: 0 }) },
    docComment: { deleteMany: async () => ({ count: 0 }) },
  }
  client.$transaction = async (work: (tx: unknown) => unknown) => work(client)
  fake.current = { client }
  tenant.state.docs.push(
    { id: "spec-1", workspaceId: WS_A.id, title: "Spec", docType: "SPEC", metadata: null, parentId: null, sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1), storageProvider: null },
    { id: "spec-2", workspaceId: WS_A.id, title: "Spec two", docType: "SPEC", metadata: null, parentId: null, sortOrder: 1, createdAt: new Date(2), updatedAt: new Date(2), storageProvider: null },
  )
  const tx = client as unknown as AppTransactionClient
  for (const docId of ["spec-1", "spec-2"]) {
    await linkEntities(tx, { linkType: "DOC_SPECIFIES_SCOPE", fromId: docId, toId: "sol-a", toType: "SOLUTION", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })
  }
  await linkEntities(tx, { linkType: "DOC_SPECIFIES_SCOPE", fromId: "spec-1", toId: "opp-a", toType: "OPPORTUNITY", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })
})

describe("deleting a doc removes its scope links", () => {
  it("deleteDocument (the server action's and every other path's single delete)", async () => {
    expect(linkRows()).toHaveLength(3)
    await deleteDocument("spec-1", { workspaceId: WS_A.id, ...actor })
    expect(linkRows().map((l) => l.fromId)).toEqual(["spec-2"])
    expect(tenant.state.docs.some((d) => d.id === "spec-1")).toBe(false)
    expect(tenant.state.solutions.some((s) => s.id === "sol-a")).toBe(true)
    expect(tenant.state.opportunities.some((o) => o.id === "opp-a")).toBe(true)
  })

  it("deleteDocById (the sandbox reconciler)", async () => {
    await deleteDocById(WS_A.id, "spec-1", actor)
    expect(linkRows().map((l) => l.fromId)).toEqual(["spec-2"])
  })

  it("deletePath (the MCP delete_doc tool)", async () => {
    await deletePath(WS_A.id, "Spec two", actor)
    expect(linkRows().map((l) => l.fromId)).toEqual(["spec-1", "spec-1"])
  })
})

describe("deleting a scope removes the link and leaves the doc", () => {
  it.each([["SOLUTION", "sol-a", 2], ["OPPORTUNITY", "opp-a", 1]] as const)("deleting %s %s removes %i link(s) and no doc", async (type, id, removed) => {
    const before = linkRows().length
    expect(await deleteLinksForEntity(fake.current!.client as unknown as AppTransactionClient, type, [id])).toBe(removed)
    expect(linkRows()).toHaveLength(before - removed)
    expect(linkRows().some((l) => l.toId === id)).toBe(false)
    expect(tenant.state.docs.filter((d) => d.docType === "SPEC")).toHaveLength(2)
  })
})

describe("the wiring is pinned in source", () => {
  it("DOC_SPECIFIES_SCOPE sweeps both ends on delete and keeps the doc when only the scope goes", () => {
    const def = getLinkType("DOC_SPECIFIES_SCOPE")!
    expect(def.lifecycle).toEqual({ onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" })
  })

  it("deleteDocument sweeps DOC links after the doc delete commits", () => {
    const source = read("lib/document-service.ts")
    const fn = source.slice(source.indexOf("export async function deleteDocument"))
    expect(fn.indexOf("tx.doc.delete")).toBeGreaterThan(-1)
    expect(fn.indexOf('deleteLinksForEntity(db, "DOC", [docId])')).toBeGreaterThan(fn.indexOf("tx.doc.delete"))
  })

  it("every doc deletion path funnels through deleteDocument", () => {
    const docFs = read("lib/doc-fs.ts")
    expect(docFs.match(/await deleteDocument\(/g)).toHaveLength(3) // deleteDocById, deletePath (leaf), deletePath (recursive)
    expect(read("app/[orgSlug]/[workspaceSlug]/docs/actions.ts")).toMatch(/export async function deleteDoc[\s\S]*?await deleteDocument\(docId/)
    expect(read("lib/doc-fs-tool-handlers.ts")).toMatch(/export async function deleteDoc[\s\S]*?docFs\.deletePath\(/)
    expect(read("lib/agent-doc-reconciliation.ts")).toContain("docFs.deleteDocById(")
  })

  it("nothing else deletes a doc row: only deleteDocument and the workspace cascade (which sweeps DOC links first) do", () => {
    const offenders = ["lib/doc-fs.ts", "lib/doc-fs-tool-handlers.ts", "lib/doc-tool-handlers.ts", "lib/positioning-brief.ts", "app/[orgSlug]/[workspaceSlug]/docs/actions.ts"].filter((file) =>
      /\.doc\.(delete|deleteMany)\(/.test(read(file)),
    )
    expect(offenders).toEqual([])
    const cascade = read("lib/delete-workspace-cascade.ts")
    expect(cascade.indexOf('deleteLinksForEntity(prisma, "DOC", docIds)')).toBeGreaterThan(-1)
    expect(cascade.indexOf('deleteLinksForEntity(prisma, "DOC", docIds)')).toBeLessThan(cascade.indexOf("prisma.doc.deleteMany"))
  })
})
