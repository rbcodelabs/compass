import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 4: "Generate synthesis" opens a linked core-agent conversation
 * instead of running the standalone pipeline. Mirrors completePmInterview's
 * contract — authenticated, workspace-member gated, one conversation carrying a
 * PENDING RESEARCH_SYNTHESIS claim, and a URL to navigate to.
 */
const mocks = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), study: vi.fn(), sessions: vi.fn(), create: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: mocks.enabled }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy: { findFirst: mocks.study }, researchSession: { count: mocks.sessions }, agentConversation: { create: mocks.create } }) }))
import { POST } from "@/app/api/research/synthesis-handoff/route"
import { parseProcessingState, handoffKind } from "@/lib/pm-agent-processing"

const request = (body: unknown, origin = "http://localhost") =>
  new Request("http://localhost/api/research/synthesis-handoff", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) })

const STUDY_ID = "11111111-1111-4111-8111-111111111111"
const STUDY = { id: STUDY_ID, studyType: "CUSTOMER_INTERVIEW", workspaceId: "workspace", workspace: { slug: "product", organization: { slug: "acme" } } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "member" } })
  mocks.enabled.mockReturnValue(true)
  mocks.study.mockResolvedValue(STUDY)
  mocks.sessions.mockResolvedValue(2)
  mocks.create.mockResolvedValue({ id: "conversation-1" })
})

describe("research synthesis handoff route", () => {
  it("creates one linked conversation and returns where to continue", async () => {
    const response = await POST(request({ studyId: STUDY_ID }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ conversationId: "conversation-1", conversationUrl: "/acme/product/agent?c=conversation-1" })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it("seeds a PENDING RESEARCH_SYNTHESIS claim bound to exactly this study", async () => {
    await POST(request({ studyId: STUDY_ID }))
    const data = mocks.create.mock.calls[0][0].data
    expect(data).toMatchObject({ workspaceId: "workspace", userId: "member" })
    const state = parseProcessingState(data.interviewProcessingJson)!
    expect(handoffKind(state)).toBe("RESEARCH_SYNTHESIS")
    expect(state).toMatchObject({ status: "PENDING", studyId: STUDY_ID, targetUrl: `/acme/product/capture/studies/${STUDY_ID}` })
    // A research claim must never carry a PM interview binding.
    expect(state.interviewId).toBeUndefined()
  })

  it("scopes the study lookup to the caller's workspace membership", async () => {
    await POST(request({ studyId: STUDY_ID }))
    expect(mocks.study.mock.calls[0][0].where).toEqual({ id: STUDY_ID, workspace: { members: { some: { userId: "member" } } } })
  })

  it("rejects a PM_INTERVIEW study indistinguishably from a missing one", async () => {
    mocks.study.mockResolvedValue({ ...STUDY, studyType: "PM_INTERVIEW" })
    const pm = await POST(request({ studyId: STUDY_ID }))
    mocks.study.mockResolvedValue(null)
    const missing = await POST(request({ studyId: STUDY_ID }))
    expect(pm.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await pm.json()).toEqual(await missing.json())
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("requires an authenticated identity", async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await POST(request({ studyId: STUDY_ID }))).status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("rejects cross-origin conversation creation", async () => {
    expect((await POST(request({ studyId: STUDY_ID }, "https://attacker.test"))).status).toBe(403)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("accepts only a study identifier, never client-supplied slugs or transcripts", async () => {
    expect((await POST(request({ studyId: STUDY_ID, orgSlug: "attacker" }))).status).toBe(400)
    expect((await POST(request({}))).status).toBe(400)
    // ResearchStudy.id is @db.Uuid, so a malformed id is a 400 here rather than a
    // Prisma error surfacing as a 502.
    expect((await POST(request({ studyId: "not-a-uuid" }))).status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("refuses a study with no completed interviews instead of minting a doomed conversation", async () => {
    mocks.sessions.mockResolvedValue(0)
    const response = await POST(request({ studyId: STUDY_ID }))
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/No completed interviews/)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("is absent when research capture is disabled", async () => {
    mocks.enabled.mockReturnValue(false)
    expect((await POST(request({ studyId: STUDY_ID }))).status).toBe(404)
    expect(mocks.study).not.toHaveBeenCalled()
  })

  it("does not expose internal failure detail", async () => {
    mocks.create.mockRejectedValue(new Error("pg: password=hunter2"))
    const response = await POST(request({ studyId: STUDY_ID }))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("hunter2")
  })
})
