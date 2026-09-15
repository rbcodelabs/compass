import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { assertPmInterviewKind, type ProcessingState } from "@/lib/pm-agent-processing"
import { gateInterviewTool, getPmInterviewTool, withInterviewMutation } from "@/lib/pm-agent-service"

/**
 * The PM-specific scoped paths must refuse to operate on a state belonging to
 * another handoff kind, so that when ADR-0012's RESEARCH_SYNTHESIS kind joins the
 * union it cannot silently inherit PM target/field logic.
 *
 * `parseProcessingState` already rejects an unknown `kind` at the boundary, which
 * means a non-PM state cannot be constructed through the real parser while the
 * union has one member. To exercise the guard that will matter once the union
 * grows, the parser is stubbed here — and only the parser. `assertPmInterviewKind`
 * and everything else in the module stay real, so what is under test is the
 * production guard, not a restatement of it.
 */
const stub = vi.hoisted(() => ({ state: null as ProcessingState | null }))

vi.mock("@/lib/pm-agent-processing", async importActual => {
  const actual = await importActual<typeof import("@/lib/pm-agent-processing")>()
  return { ...actual, parseProcessingState: (raw: string | null | undefined) => (raw ? stub.state : null) }
})

const db = vi.hoisted(() => ({ prisma: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => db.prisma }))

const WORKSPACE_ID = "workspace-1"
const USER_ID = "user-1"
const CONVERSATION_ID = "conversation-1"
const CLAIM_ID = "claim-1"
const INTERVIEW_ID = "interview-1"
const TARGET_ID = "opportunity-1"

const actor: McpActor = { purpose: "AGENT_TURN", userId: USER_ID, scopeWorkspaceId: WORKSPACE_ID, scopeConversationId: CONVERSATION_ID, scopeClaimId: CLAIM_ID }

function installPrisma() {
  const client = {
    workspaceMember: { findFirst: async () => ({ id: "member-1" }) },
    agentConversation: { findFirst: async () => ({ id: CONVERSATION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, interviewProcessingJson: "{}" }) },
    pMInterview: { findFirst: async () => ({ id: INTERVIEW_ID, workspaceId: WORKSPACE_ID, targetType: "OPPORTUNITY", targetId: TARGET_ID, initiatingUserId: USER_ID, agentConversationId: CONVERSATION_ID }) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  }
  db.prisma = client
}

const updateArgs = { opportunityId: TARGET_ID, title: "After" }
const updatePayloadHash = createHash("sha256").update(JSON.stringify(Object.entries(updateArgs).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")

/** A live production row: written before `kind` existed, so it has no `kind` key. */
const legacyRunning: ProcessingState = { status: "RUNNING", claimId: CLAIM_ID, interviewId: INTERVIEW_ID, deadline: Date.now() + 240_000, targetUrl: "/acme/product/opportunities/opportunity-1" }
/**
 * A state belonging to a kind the PM leaves must not serve.
 *
 * Until ADR-0012 step 4 this was `RESEARCH_SYNTHESIS`, cast through `unknown`
 * because the union had one member. That kind is now real and has its own
 * dispatch branch, so it no longer exercises the *guard* — it exercises the new
 * branch, which is covered in __tests__/lib/research-synthesis-scope.test.ts.
 * An unrecognized third kind takes its place here, keeping the original subject
 * of this file (the PM leaves refuse anything that is not a PM interview)
 * testable ahead of the next consumer, exactly as before.
 */
const foreignKind = { ...legacyRunning, kind: "SOME_FUTURE_KIND" } as unknown as ProcessingState
/** The real second kind, which must reach its own gate rather than PM logic. */
const researchKind = { ...legacyRunning, kind: "RESEARCH_SYNTHESIS", interviewId: undefined, studyId: "study-1" } as ProcessingState

beforeEach(() => {
  installPrisma()
})

describe("assertPmInterviewKind", () => {
  it("admits a legacy state with no kind and an explicit PM_INTERVIEW state", async () => {
    expect(() => assertPmInterviewKind(legacyRunning)).not.toThrow()
    expect(() => assertPmInterviewKind({ ...legacyRunning, kind: "PM_INTERVIEW" })).not.toThrow()
  })

  it("rejects a state belonging to another handoff kind", async () => {
    expect(() => assertPmInterviewKind(foreignKind)).toThrow(/not a PM interview handoff/)
  })
})

describe("gateInterviewTool", () => {
  it("still gates a legacy no-kind state exactly as before", async () => {
    stub.state = legacyRunning
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: INTERVIEW_ID })).resolves.toBeUndefined()
    await expect(gateInterviewTool(actor, "update_opportunity", updateArgs)).resolves.toBeUndefined()
    // Proves the gate is genuinely reached rather than short-circuiting.
    await expect(gateInterviewTool(actor, "update_opportunity", { opportunityId: "somebody-else" })).rejects.toThrow(/outside this interview/)
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: "another-interview" })).rejects.toThrow(/Interview not found or access denied/)
  })

  it("refuses a state belonging to an unrecognized handoff kind", async () => {
    stub.state = foreignKind
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: INTERVIEW_ID })).rejects.toThrow(/Unsupported handoff kind/)
    await expect(gateInterviewTool(actor, "update_opportunity", updateArgs)).rejects.toThrow(/Unsupported handoff kind/)
  })

  it("routes the research kind to its own gate instead of PM target logic", async () => {
    stub.state = researchKind
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: INTERVIEW_ID })).rejects.toThrow(/outside this research synthesis/)
    await expect(gateInterviewTool(actor, "update_opportunity", updateArgs)).rejects.toThrow(/outside this research synthesis/)
    await expect(gateInterviewTool(actor, "get_research_session", { studyId: "study-1", sessionId: "session-1" })).resolves.toBeUndefined()
  })
})

describe("withInterviewMutation", () => {
  it("still replays a legacy no-kind receipt exactly as before", async () => {
    stub.state = { ...legacyRunning, status: "SUCCEEDED", receipt: { changedFields: ["title"], targetUrl: "/acme/product/opportunities/opportunity-1", payloadHash: updatePayloadHash } }
    const handler = vi.fn()
    const result = await runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", updateArgs, handler))
    expect(handler).not.toHaveBeenCalled()
    expect((result as { structuredContent: { ok: boolean; message: string } }).structuredContent).toMatchObject({ ok: true, message: "Item already updated" })
  })

  it("refuses a state belonging to an unrecognized handoff kind before running the handler", async () => {
    stub.state = { ...foreignKind, status: "SUCCEEDED", receipt: { changedFields: ["title"], targetUrl: "/acme/product/opportunities/opportunity-1", payloadHash: updatePayloadHash } }
    const handler = vi.fn()
    await expect(runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", updateArgs, handler))).rejects.toThrow(/Unsupported handoff kind/)
    expect(handler).not.toHaveBeenCalled()
  })

  it("passes the research kind straight through without the PM receipt machinery", async () => {
    // ADR-0012 step 4: RESEARCH_SYNTHESIS has no target, no field allowlist and
    // no receipt diff, and gateInterviewTool has already bound the call to its
    // study — so no PM receipt may be written and no PM state may be read.
    stub.state = researchKind
    const handler = vi.fn(async () => "handled")
    await expect(runWithMcpActor(actor, () => withInterviewMutation("generate_research_synthesis", { studyId: "study-1" }, handler))).resolves.toBe("handled")
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("getPmInterviewTool", () => {
  it("refuses a scoped state belonging to another handoff kind", async () => {
    stub.state = foreignKind
    await expect(runWithMcpActor(actor, () => getPmInterviewTool({ interviewId: INTERVIEW_ID }))).rejects.toThrow(/not a PM interview handoff/)
  })
})
