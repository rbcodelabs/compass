import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  artifact: { findFirst: vi.fn(), findMany: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  artifactLink: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
}))
const mirror = vi.hoisted(() => ({ link: vi.fn(), unlink: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
// The legacy write and its entity_links mirror share ONE transaction (ADR phase 6); the mirror has its own tests (links/artifact-link-mirror.test.ts).
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (client: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(client, false),
}))
vi.mock("@/lib/links/legacy-mirror", () => ({ mirrorArtifactLink: mirror.link, unmirrorArtifactLink: mirror.unlink }))
import * as artifacts from "@/lib/artifacts"

const input = { workspaceId: "workspace", artifactId: "artifact", requestId: "decision", createdById: "user", source: "UI" as const }

describe("Decision supporting Artifacts", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ACTIVE" })
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "decision" })
    prisma.artifactLink.create.mockResolvedValue({ id: "link" })
    prisma.artifactLink.deleteMany.mockResolvedValue({ count: 1 })
  })
  it("creates an attributed stable request link without modifying the decision", async () => {
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "link", created: true })
    expect(prisma.artifactLink.create).toHaveBeenCalledWith({ data: { workspaceId: "workspace", artifactId: "artifact", linkedType: "REVIEW_REQUEST", linkedId: "decision", createdById: "user", source: "UI" } })
    expect(prisma.reviewRequest.findFirst).toHaveBeenCalledWith({ where: { id: "decision", workspaceId: "workspace", gateType: "TRACKED_DECISION" }, select: { id: true } })
    expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
  })
  it.each(["artifact", "reviewRequest"] as const)("rejects missing or foreign %s and legacy reviews", async (model) => {
    prisma[model].findFirst.mockResolvedValue(null)
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/same workspace/)
    await expect(artifacts.unlinkArtifactFromDecision(input)).rejects.toThrow(/same workspace/)
    expect(prisma.artifactLink.create).not.toHaveBeenCalled()
    expect(prisma.artifactLink.deleteMany).not.toHaveBeenCalled()
  })
  it("rejects new archived links but permits existing link replay", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ARCHIVED" })
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/archived/i)
    prisma.artifactLink.findFirst.mockResolvedValue({ id: "link" })
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "link", created: false })
  })
  it("returns the winning link on a concurrent duplicate", async () => {
    prisma.artifactLink.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" })
    prisma.artifactLink.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed on artifact_links"), { code: "P2002" }))
    // The race aborts the transaction, so the whole thing re-runs and the repeat read returns the winner.
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "winner", created: false })
  })
  it("mirrors a new link, an idempotent replay and an unlink into entity_links in the same transaction", async () => {
    await artifacts.linkArtifactToDecision(input)
    expect(mirror.link).toHaveBeenCalledWith(prisma, { linkedType: "REVIEW_REQUEST", artifactId: "artifact", linkedId: "decision", workspaceId: "workspace", ctx: { source: "UI", createdById: "user" } })
    prisma.artifactLink.findFirst.mockResolvedValue({ id: "link", source: "MCP", createdById: "original-actor" })
    mirror.link.mockClear()
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ created: false })
    expect(mirror.link).toHaveBeenCalledTimes(1)
    // A replay heals the mirror with the LEGACY row's source and actor (as the backfill copies), not the replaying caller's.
    expect(mirror.link.mock.calls[0][1].ctx).toEqual({ source: "MCP", createdById: "original-actor" })
    await artifacts.unlinkArtifactFromDecision(input)
    expect(mirror.unlink).toHaveBeenCalledWith(prisma, { linkedType: "REVIEW_REQUEST", artifactId: "artifact", linkedId: "decision", workspaceId: "workspace" })
  })
  it("does not mirror a refused link (foreign target, archived Artifact) and rolls back when the mirror fails", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/same workspace/)
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "decision" })
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ARCHIVED" })
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow(/archived/i)
    expect(mirror.link).not.toHaveBeenCalled()
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ACTIVE" })
    mirror.link.mockRejectedValue(new Error("mirror failed"))
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow("mirror failed")
  })
  it("propagates non-duplicate persistence failures", async () => {
    prisma.artifactLink.create.mockRejectedValue(new Error("database unavailable"))
    await expect(artifacts.linkArtifactToDecision(input)).rejects.toThrow("database unavailable")
  })
  it("unlinks archived artifacts idempotently without touching decision state", async () => {
    prisma.artifact.findFirst.mockResolvedValue({ id: "artifact", status: "ARCHIVED" })
    expect(await artifacts.unlinkArtifactFromDecision(input)).toEqual({ removed: true })
    prisma.artifactLink.deleteMany.mockResolvedValue({ count: 0 })
    expect(await artifacts.unlinkArtifactFromDecision(input)).toEqual({ removed: false })
    expect(prisma.artifactLink.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", artifactId: "artifact", linkedType: "REVIEW_REQUEST", linkedId: "decision" } })
    expect(prisma.reviewRequest.update).not.toHaveBeenCalled()
  })
  it("scopes live Artifact metadata to both workspace and link, with no storage fields", async () => {
    prisma.artifact.findMany.mockResolvedValue([])
    expect(await artifacts.getDecisionArtifacts("workspace", "decision")).toEqual([])
    const query = prisma.artifact.findMany.mock.calls[0][0]
    expect(query.where).toEqual({ workspaceId: "workspace", links: { some: { workspaceId: "workspace", linkedType: "REVIEW_REQUEST", linkedId: "decision" } } })
    expect(query.select.currentRevision).toEqual({ select: { revisionNumber: true } })
    expect(JSON.stringify(query)).not.toMatch(/blobPathname|html|externalUrl/)
  })
  it("does not resolve dangling or foreign Decision titles", async () => {
    prisma.artifactLink.findMany.mockResolvedValue([{ linkedId: "decision" }])
    prisma.reviewRequest.findMany.mockResolvedValue([{ id: "decision", state: "DECIDED", currentRevision: { title: "Choose layout" } }])
    expect(await artifacts.getArtifactDecisions("workspace", "artifact")).toEqual([{ id: "decision", title: "Choose layout", state: "DECIDED" }])
    expect(prisma.reviewRequest.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["decision"] }, workspaceId: "workspace", gateType: "TRACKED_DECISION" })
  })
})
