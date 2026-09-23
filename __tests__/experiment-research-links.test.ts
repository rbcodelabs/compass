import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  workspace: { findFirst: vi.fn() },
  experiment: { findFirst: vi.fn(), findMany: vi.fn() },
  researchStudy: { findFirst: vi.fn(), findMany: vi.fn() },
  experimentResearchStudyLink: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
}))
vi.mock("@/lib/db", () => ({ default: () => m }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: m.enabled }))
import * as links from "@/lib/experiment-research-links"

const scope = { workspaceId: "workspace" }
const actor = { userId: "member", source: "UI" as const }
const pair = { experimentId: "experiment", studyId: "study" }

beforeEach(() => {
  vi.resetAllMocks()
  m.enabled.mockReturnValue(true)
  m.workspace.findFirst.mockResolvedValue({ id: "workspace" })
  m.experiment.findFirst.mockResolvedValue({ id: "experiment" })
  m.researchStudy.findFirst.mockResolvedValue({ id: "study", status: "ACTIVE" })
  m.experimentResearchStudyLink.findFirst.mockResolvedValue(null)
  m.experimentResearchStudyLink.create.mockResolvedValue({ id: "link" })
  m.experimentResearchStudyLink.deleteMany.mockResolvedValue({ count: 1 })
  m.experimentResearchStudyLink.findMany.mockResolvedValue([])
  m.experiment.findMany.mockResolvedValue([])
  m.researchStudy.findMany.mockResolvedValue([])
})

describe("experiment / study relationships", () => {
  it("rejects missing endpoint IDs before Prisma can omit delete filters", async () => {
    await expect(links.unlinkExperimentResearchStudy(scope, actor, { experimentId: undefined as unknown as string, studyId: "study" })).rejects.toThrow("Invalid identifier")
    await expect(links.unlinkExperimentResearchStudy(scope, actor, { experimentId: "experiment", studyId: "" })).rejects.toThrow("Invalid identifier")
    expect(m.experimentResearchStudyLink.deleteMany).not.toHaveBeenCalled()
    expect(m.workspace.findFirst).not.toHaveBeenCalled()
  })
  it("links metadata with member attribution and both endpoints scoped to the workspace", async () => {
    expect(await links.linkExperimentResearchStudy(scope, actor, pair)).toEqual({ ...pair, changed: true })
    expect(m.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "workspace", members: { some: { userId: "member" } } } }))
    expect(m.experiment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "experiment", workspaceId: "workspace" } }))
    expect(m.researchStudy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "study", workspaceId: "workspace", studyType: { in: ["CUSTOMER_INTERVIEW", "USABILITY_TEST"] } } }))
    expect(m.experimentResearchStudyLink.create).toHaveBeenCalledWith({ data: { workspaceId: "workspace", ...pair, createdById: "member", source: "UI" } })
  })
  it.each(["experiment", "researchStudy"] as const)("rejects missing or foreign %s even for service actors", async model => {
    m[model].findFirst.mockResolvedValue(null)
    await expect(links.linkExperimentResearchStudy(scope, { userId: null, service: true }, pair)).rejects.toThrow(/not found/)
    expect(m.experimentResearchStudyLink.create).not.toHaveBeenCalled()
  })
  it("requires an authenticated member or explicit service actor", async () => {
    await expect(links.linkExperimentResearchStudy(scope, { userId: null }, pair)).rejects.toThrow("Unauthorized")
    m.workspace.findFirst.mockResolvedValue(null)
    await expect(links.linkExperimentResearchStudy(scope, actor, pair)).rejects.toThrow("Workspace not found")
    expect(m.experimentResearchStudyLink.create).not.toHaveBeenCalled()
  })
  it("denies mutations when research is disabled", async () => {
    m.enabled.mockReturnValue(false)
    await expect(links.linkExperimentResearchStudy(scope, actor, pair)).rejects.toThrow(/not enabled/)
    await expect(links.unlinkExperimentResearchStudy(scope, actor, pair)).rejects.toThrow(/not enabled/)
    expect(m.workspace.findFirst).not.toHaveBeenCalled()
  })
  it("returns unchanged for a retried link, including one subsequently archived", async () => {
    m.experimentResearchStudyLink.findFirst.mockResolvedValue({ id: "existing" })
    m.researchStudy.findFirst.mockResolvedValue({ id: "study", status: "ARCHIVED" })
    expect(await links.linkExperimentResearchStudy(scope, actor, pair)).toEqual({ ...pair, changed: false })
    expect(m.experimentResearchStudyLink.create).not.toHaveBeenCalled()
  })
  it("rejects new links to archived studies but allows their unlinking", async () => {
    m.researchStudy.findFirst.mockResolvedValue({ id: "study", status: "ARCHIVED" })
    await expect(links.linkExperimentResearchStudy(scope, actor, pair)).rejects.toThrow(/Archived/)
    expect(await links.unlinkExperimentResearchStudy(scope, actor, pair)).toEqual({ ...pair, changed: true })
    expect(m.experimentResearchStudyLink.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", ...pair } })
  })
  it("handles concurrent duplicate insertion and unlink retries idempotently", async () => {
    m.experimentResearchStudyLink.create.mockRejectedValue({ code: "P2002" })
    m.experimentResearchStudyLink.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" })
    expect(await links.linkExperimentResearchStudy(scope, actor, pair)).toEqual({ ...pair, changed: false })
    m.experimentResearchStudyLink.deleteMany.mockResolvedValue({ count: 0 })
    expect(await links.unlinkExperimentResearchStudy(scope, actor, pair)).toEqual({ ...pair, changed: false })
  })
  it("does not mask uniqueness failures when the scoped pair does not exist", async () => {
    const failure = { code: "P2002" }
    m.experimentResearchStudyLink.create.mockRejectedValue(failure)
    await expect(links.linkExperimentResearchStudy(scope, actor, pair)).rejects.toBe(failure)
  })
  it("does not swallow unrelated persistence failures", async () => {
    m.experimentResearchStudyLink.create.mockRejectedValue(new Error("offline"))
    await expect(links.linkExperimentResearchStudy(scope, actor, pair)).rejects.toThrow("offline")
  })
  it("reads study summaries without participant data and retains archived records", async () => {
    m.researchStudy.findMany.mockResolvedValue([{ id: "study", name: "Interview", status: "ARCHIVED" }])
    expect(await links.getExperimentResearchStudies("workspace", "experiment")).toEqual([{ id: "study", name: "Interview", status: "ARCHIVED" }])
    expect(m.researchStudy.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace", studyType: { in: ["CUSTOMER_INTERVIEW", "USABILITY_TEST"] }, experimentLinks: { some: { workspaceId: "workspace", experimentId: "experiment" } } },
      select: { id: true, name: true, status: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
    })
  })
  it("does not query link tables for disabled experiment readbacks", async () => {
    m.enabled.mockReturnValue(false)
    expect(await links.getExperimentResearchStudies("workspace", "experiment")).toEqual([])
    expect(m.researchStudy.findMany).not.toHaveBeenCalled()
  })
  it("reads reverse summaries scoped to the workspace", async () => {
    m.experiment.findMany.mockResolvedValue([{ id: "experiment", title: "Test", status: "COMPLETE" }])
    expect(await links.getStudyExperiments("workspace", "study")).toEqual([{ id: "experiment", title: "Test", status: "COMPLETE" }])
    expect(m.experiment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "workspace", researchStudyLinks: { some: { workspaceId: "workspace", studyId: "study" } } }, select: { id: true, title: true, status: true } }))
  })
  it("bounds name search and excludes linked, archived, and internal studies", async () => {
    await links.getResearchLinks(scope, actor, { type: "experiment", id: "experiment" }, "  Onboarding  ")
    expect(m.researchStudy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace", studyType: { in: ["CUSTOMER_INTERVIEW", "USABILITY_TEST"] }, status: { not: "ARCHIVED" }, name: { contains: "Onboarding", mode: "insensitive" }, experimentLinks: { none: { workspaceId: "workspace", experimentId: "experiment" } } }, take: 50,
    }))
  })
  it("retains archived study links but supplies no new link candidates", async () => {
    m.researchStudy.findFirst.mockResolvedValue({ id: "study", status: "ARCHIVED" })
    m.experiment.findMany.mockResolvedValue([{ id: "experiment", title: "Existing", status: "COMPLETE" }])
    expect(await links.getResearchLinks(scope, actor, { type: "study", id: "study" })).toEqual({ linked: [{ id: "experiment", title: "Existing", status: "COMPLETE" }], available: [], canLink: false })
    expect(m.experiment.findMany).toHaveBeenCalledTimes(1)
  })
})
