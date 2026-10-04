import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  workspace: vi.fn(), study: vi.fn(), studyCreate: vi.fn(), sessionFind: vi.fn(), sessionCreate: vi.fn(), turnCreateMany: vi.fn(),
  lock: vi.fn(), tokenCreate: vi.fn(), tokenUpdate: vi.fn(), tokenFind: vi.fn(),
}))
vi.mock("@/lib/research-agent", () => ({ runResearchInterviewAgent: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => {
  const db = {
    workspace: { findFirst: m.workspace },
    researchStudy: { findFirst: m.study, create: m.studyCreate, updateMany: m.lock },
    researchSession: { findFirst: m.sessionFind, create: m.sessionCreate },
    researchTurn: { createMany: m.turnCreateMany },
    researchParticipantToken: { create: m.tokenCreate, updateMany: m.tokenUpdate, findFirst: m.tokenFind },
  }
  return { ...db, $transaction: async (fn: unknown) => typeof fn === "function" ? fn(db) : Promise.all(fn as Promise<unknown>[]) }
} }))

import { activateResearchStudy, addExternalResearchSession, createExternalResearchStudy, issueResearchLink, regenerateResearchLink } from "@/lib/research-study-service"
import { ExternalResearchInputError } from "@/lib/research-external"

const scope = { workspaceId: "00000000-0000-4000-8000-000000000001" }
const actor = { userId: "member" }
const REQUEST_ID = "test-idempotency-key-0001"
const externalStudy = { id: "study", status: "ACTIVE", studyType: "EXTERNAL", workspaceId: scope.workspaceId, _count: { sessions: 0 } }

beforeEach(() => {
  vi.clearAllMocks()
  m.workspace.mockResolvedValue({ id: scope.workspaceId })
  m.study.mockResolvedValue(externalStudy)
  m.sessionFind.mockResolvedValue(null)
  m.sessionCreate.mockResolvedValue({})
  m.turnCreateMany.mockResolvedValue({ count: 0 })
})

describe("createExternalResearchStudy", () => {
  it("creates an ACTIVE EXTERNAL study with no guide and no participant token, scoped to a member workspace", async () => {
    const result = await createExternalResearchStudy(scope, { userId: "member", source: "UI" }, { name: "UT round 1", goal: "Learn", externalProvider: "USERTESTING", externalUrl: "https://ut.example.com/s/1" })
    expect(m.workspace.mock.calls[0][0].where).toMatchObject({ id: scope.workspaceId, members: { some: { userId: "member" } } })
    expect(m.studyCreate.mock.calls[0][0].data).toMatchObject({
      id: result.id, workspaceId: scope.workspaceId, studyType: "EXTERNAL", status: "ACTIVE", guide: "[]",
      externalProvider: "USERTESTING", externalUrl: "https://ut.example.com/s/1", createdById: "member", source: "UI",
    })
    expect(m.tokenCreate).not.toHaveBeenCalled()
  })

  it("refuses non-members and invalid input before writing", async () => {
    m.workspace.mockResolvedValue(null)
    await expect(createExternalResearchStudy(scope, actor, { name: "a", goal: "b", externalProvider: "MAZE" })).rejects.toThrow("Workspace not found")
    m.workspace.mockResolvedValue({ id: scope.workspaceId })
    await expect(createExternalResearchStudy(scope, actor, { name: "a", goal: "b", externalProvider: "NOPE" })).rejects.toThrow(ExternalResearchInputError)
    expect(m.studyCreate).not.toHaveBeenCalled()
  })
})

describe("addExternalResearchSession", () => {
  it("creates a COMPLETED, externally-provenanced session with ordered turns and no participant credentials", async () => {
    const result = await addExternalResearchSession(scope, actor, "study", {
      idempotencyKey: REQUEST_ID, transcript: "Interviewer: Hi\nParticipant: Hello", notes: "Notes", participantName: "Sam", sessionDate: "2026-09-30",
    })
    expect(result.replayed).toBe(false)
    const data = m.sessionCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ id: result.id, studyId: "study", status: "COMPLETED", provenance: "EXTERNAL_IMPORT", participantName: "Sam", sessionNotes: "Notes" })
    expect(data).not.toHaveProperty("participantTokenId")
    expect(data).not.toHaveProperty("resumeTokenHash")
    expect(m.turnCreateMany.mock.calls[0][0].data).toEqual([
      { sessionId: result.id, role: "INTERVIEWER", content: "Hi", sequence: 0 },
      { sessionId: result.id, role: "PARTICIPANT", content: "Hello", sequence: 1 },
    ])
  })

  it("scopes the study lookup to workspace members", async () => {
    await addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })
    expect(m.study.mock.calls[0][0].where.workspace).toMatchObject({ members: { some: { userId: "member" } } })
    expect(m.turnCreateMany).not.toHaveBeenCalled()
  })

  it("is idempotent: a repeated key returns the existing session and writes nothing", async () => {
    m.sessionFind.mockResolvedValue({ id: "existing" })
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })).resolves.toEqual({ id: "existing", replayed: true })
    expect(m.sessionCreate).not.toHaveBeenCalled()
  })

  it("converges when a concurrent submit wins the primary-key race", async () => {
    m.sessionCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
    m.sessionFind.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "raced" })
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })).resolves.toEqual({ id: "raced", replayed: true })
  })

  it("rejects native studies, archived studies and a study outside the actor's workspaces", async () => {
    m.study.mockResolvedValue({ ...externalStudy, studyType: "CUSTOMER_INTERVIEW" })
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })).rejects.toThrow(/external study/)
    m.study.mockResolvedValue({ ...externalStudy, status: "ARCHIVED" })
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })).rejects.toThrow(/Archived/)
    m.study.mockResolvedValue(null)
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID, notes: "n" })).rejects.toThrow("Study not found")
    expect(m.sessionCreate).not.toHaveBeenCalled()
  })

  it("rejects an empty session before touching the database", async () => {
    await expect(addExternalResearchSession(scope, actor, "study", { idempotencyKey: REQUEST_ID })).rejects.toThrow("Add a transcript or notes")
    expect(m.sessionCreate).not.toHaveBeenCalled()
  })
})

describe("participant-link paths refuse external studies", () => {
  it.each([
    ["activate", () => activateResearchStudy(scope, actor, "study")],
    ["rotate", () => regenerateResearchLink(scope, actor, "study")],
    ["issue", () => issueResearchLink(scope, actor, "study")],
  ])("%s", async (_name, run) => {
    await expect(run()).rejects.toThrow("External studies do not have participant links")
    expect(m.tokenCreate).not.toHaveBeenCalled()
  })
})
