import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ link: vi.fn(), unlink: vi.fn(), artifacts: vi.fn(), decisions: vi.fn(), tracked: vi.fn(), review: vi.fn(), artifact: vi.fn() }))
vi.mock("@/lib/artifacts", () => ({ linkArtifactToDecision: mocks.link, unlinkArtifactFromDecision: mocks.unlink, getDecisionArtifacts: mocks.artifacts, getArtifactDecisions: mocks.decisions }))
vi.mock("@/lib/tracked-decisions", () => ({ getTrackedDecision: mocks.tracked }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: "agent-owner" }) }))
vi.mock("@/lib/db", () => ({ default: () => ({ reviewRequest: { findUnique: mocks.review }, artifact: { findUnique: mocks.artifact } }) }))
import * as handlers from "@/lib/artifact-tool-handlers"
import { getDecision, getReviewRequest } from "@/lib/decision-tool-handlers"

const input = { workspaceId: "workspace", artifactId: "artifact", requestId: "decision" }
beforeEach(() => { vi.resetAllMocks(); mocks.artifacts.mockResolvedValue([]); mocks.decisions.mockResolvedValue([]) })
it("attributes MCP links and returns stable relationship identifiers", async () => {
  mocks.link.mockResolvedValue({ id: "link", created: false })
  const result = await handlers.linkArtifactDecision(input)
  expect(result.structuredContent.data).toEqual({ ...input, linkId: "link", created: false })
  expect(mocks.link).toHaveBeenCalledWith({ ...input, createdById: "agent-owner", source: "MCP" })
})
it("returns idempotent unlink results and reports failure", async () => {
  mocks.unlink.mockResolvedValue({ removed: false })
  expect((await handlers.unlinkArtifactDecision(input)).structuredContent.data).toEqual({ ...input, removed: false })
  mocks.unlink.mockRejectedValue(new Error("same workspace required"))
  expect((await handlers.unlinkArtifactDecision(input)).structuredContent.ok).toBe(false)
})
it.each(["decision", "review"])("adds live artifact metadata to the %s getter without editing packets", async (kind) => {
  const request = { id: "decision", workspaceId: "workspace", gateType: "TRACKED_DECISION", state: "DECIDED", currentRevision: { title: "Choose", packetJson: "frozen", fingerprint: "frozen" } }
  mocks.tracked.mockResolvedValue(request); mocks.review.mockResolvedValue(request)
  mocks.artifacts.mockResolvedValue([{ id: "artifact", title: "Prototype", status: "ACTIVE", currentRevision: { revisionNumber: 2 } }])
  const result = kind === "decision" ? await getDecision(input) : await getReviewRequest(input)
  // reviewUrl is additive alongside artifacts and is null here because this file's
  // prisma mock has no `workspace` delegate to resolve org/workspace slugs from.
  expect(result.structuredContent.data).toEqual({ ...request, reviewUrl: null, artifacts: [{ id: "artifact", title: "Prototype", status: "ACTIVE", currentRevision: { revisionNumber: 2 } }] })
  expect(mocks.artifacts).toHaveBeenCalledWith("workspace", "decision")
})
it("does not expose supporting links for legacy reviews", async () => {
  mocks.review.mockResolvedValue({ id: "decision", gateType: "RELEASE_AUTHORIZATION" })
  expect((await getReviewRequest(input)).structuredContent.data).toMatchObject({ artifacts: [] })
  expect(mocks.artifacts).not.toHaveBeenCalled()
})
it("adds linked Decisions while preserving Artifact storage redaction", async () => {
  mocks.artifact.mockResolvedValue({ id: "artifact", workspaceId: "workspace", title: "Prototype", links: [], revisions: [{ id: "revision", blobPathname: "private/key" }], currentRevision: { revisionNumber: 2, blobPathname: "private/key" } })
  mocks.decisions.mockResolvedValue([{ id: "decision", title: "Choose", state: "DECIDED" }])
  const result = await handlers.getArtifact(input)
  expect(result.structuredContent.data).toMatchObject({ decisions: [{ id: "decision", title: "Choose", state: "DECIDED" }] })
  expect(JSON.stringify(result)).not.toContain("private/key")
})
