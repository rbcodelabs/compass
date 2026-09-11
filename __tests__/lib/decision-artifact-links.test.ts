import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  artifact: { findFirst: vi.fn(), findMany: vi.fn() },
  reviewRequest: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  artifactLink: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
}))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
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
    prisma.artifactLink.create.mockRejectedValue({ code: "P2002" })
    expect(await artifacts.linkArtifactToDecision(input)).toMatchObject({ id: "winner", created: false })
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
