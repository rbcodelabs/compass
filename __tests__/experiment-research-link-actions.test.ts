import { beforeEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), link: vi.fn(), unlink: vi.fn(), revalidate: vi.fn() }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }))
vi.mock("@/lib/experiment-research-links", () => ({ getResearchLinks: m.get, linkExperimentResearchStudy: m.link, unlinkExperimentResearchStudy: m.unlink }))
import { readExperimentStudyLinks, changeExperimentStudyLink } from "@/app/[orgSlug]/[workspaceSlug]/experiments/research-actions"
const experimentId = "00000000-0000-4000-8000-000000000001"
const studyId = "00000000-0000-4000-8000-000000000002"
beforeEach(() => { vi.resetAllMocks(); m.auth.mockResolvedValue({ user: { id: "member" } }) })
it("refuses unauthenticated reads and writes before accessing services", async () => {
  m.auth.mockResolvedValue(null)
  await expect(readExperimentStudyLinks("org", "workspace", { type: "experiment", id: experimentId })).rejects.toThrow("Unauthorized")
  await expect(changeExperimentStudyLink("org", "workspace", experimentId, studyId, "link")).rejects.toThrow("Unauthorized")
  expect(m.link).not.toHaveBeenCalled()
})
it("forwards authenticated scope and refreshes both detail routes", async () => {
  await changeExperimentStudyLink("org", "workspace", experimentId, studyId, "link")
  expect(m.link).toHaveBeenCalledWith({ orgSlug: "org", workspaceSlug: "workspace" }, { userId: "member", source: "UI" }, { experimentId, studyId })
  expect(m.revalidate).toHaveBeenCalledWith(`/org/workspace/experiments/${experimentId}`)
  expect(m.revalidate).toHaveBeenCalledWith(`/org/workspace/capture/studies/${studyId}`)
})
it("uses the unlink service for removing a relationship", async () => {
  await changeExperimentStudyLink("org", "workspace", experimentId, studyId, "unlink")
  expect(m.unlink).toHaveBeenCalledOnce()
  expect(m.link).not.toHaveBeenCalled()
})
it("rejects malformed IDs, slugs, and search without any service mutation", async () => {
  for (const value of [undefined, null, "", "not-a-uuid"]) {
    await expect(changeExperimentStudyLink("org", "workspace", value as string, studyId, "unlink")).rejects.toThrow()
    await expect(changeExperimentStudyLink("org", "workspace", experimentId, value as string, "unlink")).rejects.toThrow()
    await expect(readExperimentStudyLinks("org", "workspace", { type: "study", id: value as string })).rejects.toThrow()
  }
  await expect(changeExperimentStudyLink("", "workspace", experimentId, studyId, "unlink")).rejects.toThrow()
  await expect(readExperimentStudyLinks("org", "workspace", { type: "study", id: studyId }, "x".repeat(256))).rejects.toThrow()
  expect(m.unlink).not.toHaveBeenCalled()
  expect(m.get).not.toHaveBeenCalled()
})
it("rejects invalid operation and target types at the request boundary", async () => {
  // Exercise untrusted runtime input rather than TypeScript callers.
  await expect(changeExperimentStudyLink("org", "workspace", "experiment", "study", "delete" as "link")).rejects.toThrow("Invalid operation")
  await expect(readExperimentStudyLinks("org", "workspace", { type: "unknown" as "study", id: "study" })).rejects.toThrow("Invalid target")
  expect(m.unlink).not.toHaveBeenCalled()
  expect(m.get).not.toHaveBeenCalled()
})
