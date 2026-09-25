import { beforeEach, describe, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ workspace: vi.fn(), study: vi.fn(), list: vi.fn(), lock: vi.fn(), update: vi.fn(), count: vi.fn(), token: vi.fn(), issue: vi.fn(), revoke: vi.fn(), create: vi.fn(), agent: vi.fn(), artifact: vi.fn(), experiments: vi.fn() }))
vi.mock("@/lib/research-agent", () => ({ runResearchInterviewAgent: m.agent }))
vi.mock("@/lib/db", () => ({ default: () => {
  const db = { workspace: { findFirst: m.workspace }, researchStudy: { findFirst: m.study, findMany: m.list, updateMany: m.lock, update: m.update, create: m.create }, researchSession: { count: m.count }, researchParticipantToken: { findFirst: m.token, create: m.issue, updateMany: m.revoke }, artifact: { findFirst: m.artifact } }
  return { ...db, experiment: { findMany: m.experiments }, $transaction: async (fn: unknown) => typeof fn === "function" ? fn(db) : Promise.all(fn as Promise<unknown>[]) }
} }))
import { createResearchStudy, generateResearchGuide, getResearchStudy, issueResearchLink, listResearchStudies, updateResearchStudy } from "@/lib/research-study-service"
const scope = { workspaceId: "00000000-0000-4000-8000-000000000001" }
const actor = { userId: "member" }
beforeEach(() => {
  vi.clearAllMocks()
  m.workspace.mockResolvedValue({ id: scope.workspaceId })
  m.experiments.mockResolvedValue([])
  m.study.mockResolvedValue({ id: "study", workspaceId: scope.workspaceId, status: "ACTIVE", name: "Study", guide: "[]", _count: { sessions: 0 } })
  m.list.mockResolvedValue([]); m.lock.mockResolvedValue({ count: 1 }); m.token.mockResolvedValue(null)
  m.count.mockResolvedValue(0)
  m.agent.mockResolvedValue(JSON.stringify(["One", "Two", "Three", "Four", "Five"]))
})
describe("shared research study service", () => {
  it("fences validation against concurrent protocol changes", async () => {
    const updatedAt = new Date("2026-01-01")
    m.study.mockResolvedValue({ id: "study", name: "Old", status: "ACTIVE", goal: "Goal", studyType: "CUSTOMER_INTERVIEW", targetMinutes: 30, appUrl: null, guide: '[{"id":"1","text":"Question"}]', updatedAt, _count: { sessions: 0 } })
    m.lock.mockResolvedValue({ count: 0 })
    await expect(updateResearchStudy(scope, actor, "study", { name: "New", studyType: "USABILITY_TEST", appUrl: "https://example.com/product" })).rejects.toThrow(/changed/)
    expect(m.lock.mock.calls[0][0].where.updatedAt).toEqual(updatedAt)
    expect(m.update).not.toHaveBeenCalled()
  })
  it("preserves unspecified protocol fields on metadata-only updates", async () => {
    m.study.mockResolvedValue({ id: "study", name: "Old", status: "ACTIVE", goal: "Goal", studyType: "CUSTOMER_INTERVIEW", targetMinutes: 30, appUrl: null, guide: '[{"id":"1","text":"Question"}]', _count: { sessions: 0 } })
    await updateResearchStudy(scope, actor, "study", { name: "Renamed" })
    expect(m.update.mock.calls[0][0].data).toMatchObject({ name: "Renamed" })
    expect(m.update.mock.calls[0][0].data).not.toHaveProperty("goal")
    expect(m.update.mock.calls[0][0].data).not.toHaveProperty("guide")
    expect(m.update.mock.calls[0][0].data).not.toHaveProperty("targetMinutes")
  })
  it("preserves stable pages and rejects a cursor with changed filters", async () => {
    const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]
    m.list.mockResolvedValue(ids.map(id => ({ id, guide: "[]", createdAt: new Date("2026-01-01"), _count: { sessions: 0 } })))
    const first = await listResearchStudies(scope, actor, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))
    await listResearchStudies(scope, actor, { limit: 1, cursor: first.nextCursor! })
    expect(m.list.mock.calls[1][0].where.OR[1]).toEqual({ createdAt: new Date("2026-01-01"), id: { lt: ids[0] } })
    await expect(listResearchStudies(scope, actor, { status: "ARCHIVED", cursor: first.nextCursor! })).rejects.toThrow(/cursor/)
  })
  it("requires an explicit trusted service actor when user identity is absent", async () => {
    await expect(listResearchStudies(scope, { userId: null }, {})).rejects.toThrow(/Unauthorized/)
    expect(m.list).not.toHaveBeenCalled()
    await listResearchStudies(scope, { userId: null, service: true }, {})
    expect(m.list).toHaveBeenCalled()
  })
  it("authorizes membership before reading studies", async () => {
    m.workspace.mockResolvedValue(null)
    await expect(listResearchStudies(scope, actor, {})).rejects.toThrow(/Workspace not found/)
    expect(m.list).not.toHaveBeenCalled()
  })
  it("bounds list queries and returns no secret fields even if the mock supplies them", async () => {
    m.list.mockResolvedValue([{ id: "study", name: "Study", guide: "[]", shareTokenHash: "secret", _count: { sessions: 2 } }])
    const result = await listResearchStudies(scope, actor, { limit: 1 })
    expect(m.list.mock.calls[0][0]).toMatchObject({ where: { workspaceId: scope.workspaceId }, take: 2 })
    expect(JSON.stringify(result)).not.toContain("secret")
  })
  it("rejects a cursor copied from another workspace", async () => {
    const cursor = Buffer.from(JSON.stringify({ version: 1, workspaceId: "other", status: null, createdAt: new Date().toISOString(), id: "study" })).toString("base64url")
    await expect(listResearchStudies(scope, actor, { cursor })).rejects.toThrow(/cursor/)
    expect(m.list).not.toHaveBeenCalled()
  })
  it("get reads metadata only and preserves study tenancy", async () => {
    m.experiments.mockResolvedValue([{ id: "experiment", title: "Discovery", status: "RUNNING" }])
    const result = await getResearchStudy(scope, actor, "study")
    expect(result.experiments).toEqual([{ id: "experiment", title: "Discovery", status: "RUNNING" }])
    expect(m.experiments).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: scope.workspaceId, researchStudyLinks: { some: { workspaceId: scope.workspaceId, studyId: "study" } } } }))
    expect(m.study.mock.calls[0][0].where).toMatchObject({ id: "study", workspace: { id: scope.workspaceId, members: { some: { userId: "member" } } } })
    expect(m.study.mock.calls[0][0]).not.toHaveProperty("include.sessions")
  })
  it("never issues another live primary link implicitly", async () => {
    m.token.mockResolvedValue({ id: "existing" })
    await expect(issueResearchLink(scope, actor, "study")).rejects.toThrow(/rotate/i)
    expect(m.issue).not.toHaveBeenCalled()
  })
  it("issues only a hash after locking the active study", async () => {
    const result = await issueResearchLink(scope, actor, "study")
    expect(result.token).toBeTruthy()
    expect(m.issue.mock.calls[0][0].data.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(m.issue.mock.calls)).not.toContain(result.token)
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(m.token.mock.invocationCallOrder[0])
  })
  it("does not issue a token when a concurrent lifecycle mutation wins", async () => {
    m.lock.mockResolvedValue({ count: 0 })
    await expect(issueResearchLink(scope, actor, "study")).rejects.toThrow(/changed/)
    expect(m.issue).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
  })
  it("rechecks live links after a serialization conflict instead of issuing a duplicate", async () => {
    m.lock.mockRejectedValueOnce({ code: "P2034" }).mockResolvedValue({ count: 1 })
    m.token.mockResolvedValue({ id: "concurrent-primary" })
    await expect(issueResearchLink(scope, actor, "study")).rejects.toThrow(/rotate/)
    expect(m.lock).toHaveBeenCalledTimes(2)
    expect(m.issue).not.toHaveBeenCalled()
  })
  it("passes a bounded invocation deadline for MCP guide generation", async () => {
    const deadline = Date.now() + 45_000
    await generateResearchGuide(scope, actor, { studyType: "CUSTOMER_INTERVIEW", goal: "Goal", appUrl: "", targetMinutes: 15 }, deadline)
    expect(m.agent.mock.calls[0][0].deadline).toBe(deadline)
    expect(m.agent.mock.calls[0][0].prompt).toContain("workarounds")
  })
  it("accepts an otherwise valid generated guide wrapped in a JSON code fence", async () => {
    m.agent.mockResolvedValue('```json\n["One", "Two", "Three", "Four", "Five"]\n```')

    await expect(generateResearchGuide(scope, actor, {
      studyType: "CUSTOMER_INTERVIEW", goal: "Goal", appUrl: "", targetMinutes: 15,
    })).resolves.toEqual(["One", "Two", "Three", "Four", "Five"])
  })
  it("creates an active study and never returns or persists a token hash in its result", async () => {
    const result = await createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Question"] })
    expect(result.id).toBeTruthy()
    expect(result.token).toBeTruthy()
    expect(result.status).toBe("ACTIVE")
    expect(m.create.mock.calls[0][0].data.status).toBe("ACTIVE")
    expect(result).not.toHaveProperty("tokenHash")
  })
  it("stages a draft study without issuing a participant link", async () => {
    const result = await createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Question"], status: "DRAFT" })
    expect(result.id).toBeTruthy()
    expect(result.status).toBe("DRAFT")
    expect(result).not.toHaveProperty("token")
    expect(m.create.mock.calls[0][0].data.status).toBe("DRAFT")
    expect(m.issue).not.toHaveBeenCalled()
  })
  it("rejects an unsupported initial status", async () => {
    await expect(createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Question"], status: "CLOSED" as never }))
      .rejects.toThrow(/status/i)
    expect(m.create).not.toHaveBeenCalled()
  })

  describe("artifact-backed usability tests", () => {
    const artifactId = "00000000-0000-4000-8000-0000000000aa"

    it("creates a usability test targeting a valid in-workspace HTML_UPLOAD artifact", async () => {
      m.artifact.mockResolvedValue({ id: artifactId, title: "Prototype" })
      const result = await createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Task"], studyType: "USABILITY_TEST", artifactId })
      expect(result.id).toBeTruthy()
      expect(m.artifact.mock.calls[0][0].where).toMatchObject({ id: artifactId, workspaceId: scope.workspaceId, status: "ACTIVE", sourceType: "HTML_UPLOAD" })
      expect(m.create.mock.calls[0][0].data.artifactId).toBe(artifactId)
      expect(m.create.mock.calls[0][0].data.appUrl).toBeNull()
    })

    it("rejects an artifact id that does not resolve in this workspace (wrong workspace or archived)", async () => {
      m.artifact.mockResolvedValue(null)
      await expect(createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Task"], studyType: "USABILITY_TEST", artifactId }))
        .rejects.toThrow(/Artifact not found/)
      expect(m.create).not.toHaveBeenCalled()
    })

    it("rejects an artifact whose sourceType is EXTERNAL_LINK by scoping the lookup query", async () => {
      // EXTERNAL_LINK artifacts are filtered out at the query level, so a
      // lookup for one behaves identically to "not found".
      m.artifact.mockResolvedValue(null)
      await expect(createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Task"], studyType: "USABILITY_TEST", artifactId }))
        .rejects.toThrow(/Artifact not found/)
      expect(m.artifact.mock.calls[0][0].where.sourceType).toBe("HTML_UPLOAD")
    })

    it("rejects providing both appUrl and artifactId for a usability test", async () => {
      await expect(createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Task"], studyType: "USABILITY_TEST", appUrl: "https://example.com", artifactId }))
        .rejects.toThrow(/one of|either/i)
      expect(m.create).not.toHaveBeenCalled()
    })

    it("rejects providing neither appUrl nor artifactId for a usability test", async () => {
      await expect(createResearchStudy(scope, actor, { name: "Study", goal: "Goal", guide: ["Task"], studyType: "USABILITY_TEST" }))
        .rejects.toThrow(/one of|either|product URL|artifact/i)
      expect(m.create).not.toHaveBeenCalled()
    })

    it("allows switching a study's target from appUrl to artifactId before the first session", async () => {
      m.study.mockResolvedValue({ id: "study", name: "Old", status: "ACTIVE", goal: "Goal", studyType: "USABILITY_TEST", targetMinutes: 30, appUrl: "https://example.com/product", artifactId: null, guide: '[{"id":"1","text":"Task"}]', _count: { sessions: 0 } })
      m.artifact.mockResolvedValue({ id: artifactId, title: "Prototype" })
      await updateResearchStudy(scope, actor, "study", { name: "Old", studyType: "USABILITY_TEST", artifactId })
      expect(m.update.mock.calls[0][0].data.artifactId).toBe(artifactId)
      expect(m.update.mock.calls[0][0].data.appUrl).toBeNull()
    })

    it("locks the artifact target after the first session, same as appUrl", async () => {
      m.study.mockResolvedValue({ id: "study", name: "Old", status: "ACTIVE", goal: "Goal", studyType: "USABILITY_TEST", targetMinutes: 30, appUrl: null, artifactId, guide: '[{"id":"1","text":"Task"}]', _count: { sessions: 1 } })
      await updateResearchStudy(scope, actor, "study", { name: "Renamed" })
      expect(m.update.mock.calls[0][0].data).not.toHaveProperty("artifactId")
      expect(m.artifact).not.toHaveBeenCalled()
    })
  })
})
