import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  artifact: { findFirst: vi.fn(), findMany: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
}))
const service = vi.hoisted(() => ({ linkEntities: vi.fn(), unlinkEntities: vi.fn(), findLink: vi.fn() }))
const readers = vi.hoisted(() => ({ readEntityLinksArtifact: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (client: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(client, false),
  withAtomicRetry: async (client: unknown, callback: (tx: unknown) => unknown) => callback(client),
  withUpdatesTables: async (client: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(client, false),
}))
vi.mock("@/lib/links/service", () => service)
vi.mock("@/lib/links/readers", () => readers)
import * as artifacts from "@/lib/artifacts"

const input = { workspaceId: "workspace", artifactId: "artifact", requestId: "decision", createdById: "user", source: "UI" as const }
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: "workspace", fromId: "artifact", toId: "decision", toType: "REVIEW_REQUEST", source: "UI", createdById: "user", createdAt: new Date(0), ...extra,
})

describe("Decision supporting Artifacts", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ACTIVE" })
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "decision" })
    service.findLink.mockResolvedValue(null)
    service.linkEntities.mockResolvedValue({ link: row("link"), created: true })
    service.unlinkEntities.mockResolvedValue({ removed: 1, removedIds: ["link"] })
  })
  it("creates an attributed stable request link without modifying the decision", async () => {
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "link", artifactId: "artifact", linkedType: "REVIEW_REQUEST", linkedId: "decision", created: true })
    expect(service.linkEntities).toHaveBeenCalledWith(prisma, {
      linkType: "ARTIFACT_SUPPORTS_DECISION", fromId: "artifact", toId: "decision", expectedWorkspaceId: "workspace",
      ctx: { source: "UI", createdById: "user" }, viaDedicatedWriter: true,
    })
    expect(prisma.reviewRequest.findFirst).toHaveBeenCalledWith({ where: { id: "decision", workspaceId: "workspace", gateType: "TRACKED_DECISION" }, select: { id: true } })
    expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
  })
  it.each(["artifact", "reviewRequest"] as const)("rejects missing or foreign %s and legacy reviews", async (model) => {
    prisma[model].findFirst.mockResolvedValue(null)
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/same workspace/)
    await expect(artifacts.unlinkArtifactFromDecision(input)).rejects.toThrow(/same workspace/)
    expect(service.linkEntities).not.toHaveBeenCalled()
    expect(service.unlinkEntities).not.toHaveBeenCalled()
  })
  it("rejects new archived links but permits existing link replay", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ARCHIVED" })
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/archived/i)
    expect(service.linkEntities).not.toHaveBeenCalled()
    service.findLink.mockResolvedValue(row("link"))
    service.linkEntities.mockResolvedValue({ link: row("link"), created: false })
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "link", created: false })
  })
  it("returns the winning link on a concurrent duplicate", async () => {
    service.linkEntities
      .mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on entity_links"), { code: "P2002" }))
      .mockResolvedValueOnce({ link: row("winner"), created: false })
    // The race aborts the transaction, so the whole thing re-runs and the repeat read returns the winner.
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "winner", created: false })
  })
  it("propagates non-duplicate persistence failures", async () => {
    service.linkEntities.mockRejectedValue(new Error("database unavailable"))
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow("database unavailable")
  })
  it("unlinks archived artifacts idempotently without touching decision state", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ARCHIVED" })
    expect(await artifacts.unlinkArtifactFromDecision(input)).toEqual({ removed: true })
    service.unlinkEntities.mockResolvedValue({ removed: 0, removedIds: [] })
    expect(await artifacts.unlinkArtifactFromDecision(input)).toEqual({ removed: false })
    expect(service.unlinkEntities).toHaveBeenCalledWith(prisma, { linkType: "ARTIFACT_SUPPORTS_DECISION", fromId: "artifact", toId: "decision", expectedWorkspaceId: "workspace", viaDedicatedWriter: true })
    expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
  })
  it("reads the Decision's Artifacts from entity_links, title order, with no storage fields", async () => {
    readers.readEntityLinksArtifact.mockResolvedValue([])
    expect(await artifacts.getDecisionArtifacts("workspace", "decision")).toEqual([])
    expect(readers.readEntityLinksArtifact).toHaveBeenCalledWith(prisma, "workspace", { decisionIds: ["decision"] })
    expect(prisma.artifact.findMany).not.toHaveBeenCalled()
    readers.readEntityLinksArtifact.mockResolvedValue([{ linkType: "ARTIFACT_SUPPORTS_DECISION", fromId: "b" }, { linkType: "ARTIFACT_SUPPORTS_DECISION", fromId: "a" }, { linkType: "ARTIFACT_SUPPORTS_DECISION", fromId: "b" }])
    prisma.artifact.findMany.mockResolvedValue([])
    await artifacts.getDecisionArtifacts("workspace", "decision")
    const query = prisma.artifact.findMany.mock.calls[0][0]
    expect(query.where).toEqual({ id: { in: ["b", "a"] }, workspaceId: "workspace" })
    expect(query.orderBy).toEqual([{ title: "asc" }, { id: "asc" }])
    expect(query.select.currentRevision).toEqual({ select: { revisionNumber: true } })
    expect(JSON.stringify(query)).not.toMatch(/blobPathname|html|externalUrl/)
  })
  it("does not resolve dangling or foreign Decision titles", async () => {
    readers.readEntityLinksArtifact.mockResolvedValue([
      { linkType: "ARTIFACT_SUPPORTS_DECISION", toId: "decision" },
      { linkType: "ARTIFACT_ATTACHED_TO_SOLUTION", toId: "solution" },
    ])
    prisma.reviewRequest.findMany.mockResolvedValue([{ id: "decision", state: "DECIDED", currentRevision: { title: "Choose layout" } }])
    expect(await artifacts.getArtifactDecisions("workspace", "artifact")).toEqual([{ id: "decision", title: "Choose layout", state: "DECIDED" }])
    expect(readers.readEntityLinksArtifact).toHaveBeenCalledWith(prisma, "workspace", { artifactIds: ["artifact"] })
    expect(prisma.reviewRequest.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["decision"] }, workspaceId: "workspace", gateType: "TRACKED_DECISION" })
  })
})
