import { beforeEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ link: vi.fn(), unlink: vi.fn() }))
vi.mock("@/lib/experiment-research-links", () => ({ linkExperimentResearchStudy: m.link, unlinkExperimentResearchStudy: m.unlink, ExperimentResearchLinkError: class ExperimentResearchLinkError extends Error {} }))
import { linkExperimentToResearchStudyTool, unlinkExperimentFromResearchStudyTool } from "@/lib/experiment-research-link-tool-handlers"
import { runWithMcpActor } from "@/lib/mcp-authz"
const input = { workspaceId: "workspace", experimentId: "experiment", studyId: "study" }
beforeEach(() => { vi.resetAllMocks(); m.link.mockResolvedValue({ experimentId: "experiment", studyId: "study", changed: true }); m.unlink.mockResolvedValue({ experimentId: "experiment", studyId: "study", changed: false }) })
it.each([linkExperimentToResearchStudyTool, unlinkExperimentFromResearchStudyTool])("rejects participant and scoped PM/synthesis credentials before services", async handler => {
  for (const actor of [{ userId: "u", purpose: "RESEARCH" as const }, { userId: "u", purpose: "AGENT_TURN" as const, scopeClaimId: "claim" }]) {
    await expect(runWithMcpActor(actor, () => handler(input))).rejects.toThrow(/not available/)
  }
  expect(m.link).not.toHaveBeenCalled()
  expect(m.unlink).not.toHaveBeenCalled()
})
it("preserves member attribution, changed flag and mutation ID convention", async () => {
  const result = await runWithMcpActor({ userId: "u", purpose: "USER" }, () => linkExperimentToResearchStudyTool(input))
  expect(m.link).toHaveBeenCalledWith({ workspaceId: "workspace" }, { userId: "u", service: false, source: "MCP" }, { experimentId: "experiment", studyId: "study" })
  expect(result.structuredContent).toMatchObject({ ok: true, data: { changed: true, experimentId: "experiment", studyId: "study" } })
  expect(result.content[0].text.split("\n")).toContain("ID: experiment")
})
it("preserves explicit service identity", async () => {
  await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => unlinkExperimentFromResearchStudyTool(input))
  expect(m.unlink.mock.calls[0][1]).toEqual({ userId: null, service: true, source: "MCP" })
})
it("does not leak internal persistence errors", async () => {
  m.link.mockRejectedValue(new Error("secret-db-detail"))
  const result = await runWithMcpActor({ userId: "u" }, () => linkExperimentToResearchStudyTool(input))
  expect(result.structuredContent.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain("secret-db-detail")
})
