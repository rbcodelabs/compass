import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  evaluateSendMessageGuard,
  evaluateSquadDestinationAccess,
  evaluateThreadCoordinationAccess,
  resolveCallingThreadContext,
  type CallingThreadContext,
} from "./scope"
import { evaluateAndAdvanceEscalationState } from "./mcp-tools"
import {
  THREAD_ORCHESTRATOR_SKILL_MARKDOWN,
  getOrchestratorSkillAppendixForConversation,
} from "./skill"

const mockGetMcpActor = vi.fn()
const mockFindFirstRun = vi.fn()
const mockFindFirstConv = vi.fn()
const mockFindFirstOrch = vi.fn()

vi.mock("@/lib/mcp-authz", () => ({
  getMcpActor: () => mockGetMcpActor(),
}))

const mockPrisma = {
  agentRun: {
    findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
  },
  agentConversation: {
    findFirst: (...args: unknown[]) => mockFindFirstConv(...args),
  },
  agentOrchestrator: {
    findFirst: (...args: unknown[]) => mockFindFirstOrch(...args),
  },
}

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"
const SQUAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SQUAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const CONV_CALLER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const CONV_TARGET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

function makeCtx(overrides: Partial<CallingThreadContext>): CallingThreadContext {
  return {
    runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    conversationId: CONV_CALLER,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    agentId: null,
    squadId: null,
    orchestrator: null,
    ...overrides,
  }
}

describe("evaluateThreadCoordinationAccess", () => {
  it("allows an unassigned thread to read/write unassigned threads and blocks Squad threads or elevatedSquadId", () => {
    const caller = makeCtx({ squadId: null, orchestrator: null })
    expect(
      evaluateThreadCoordinationAccess({
        caller,
        target: { id: CONV_TARGET, squadId: null },
        operation: "read",
      }),
    ).toBe(true)
    expect(
      evaluateThreadCoordinationAccess({
        caller,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        operation: "read",
      }),
    ).toBe(false)
    expect(
      evaluateThreadCoordinationAccess({
        caller,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        elevatedSquadId: SQUAD_A,
        operation: "read",
      }),
    ).toBe(false)
  })

  it("allows a Squad thread or Squad Orchestrator to coordinate within its own Squad only", () => {
    const squadOrch = makeCtx({
      squadId: SQUAD_A,
      orchestrator: {
        id: "99999999-9999-4999-8999-999999999999",
        scopeType: "SQUAD",
        scopeKey: SQUAD_A,
        enabled: true,
      },
    })
    expect(
      evaluateThreadCoordinationAccess({
        caller: squadOrch,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        operation: "write",
      }),
    ).toBe(true)
    expect(
      evaluateThreadCoordinationAccess({
        caller: squadOrch,
        target: { id: CONV_TARGET, squadId: null },
        operation: "read",
      }),
    ).toBe(false)
    expect(
      evaluateThreadCoordinationAccess({
        caller: squadOrch,
        target: { id: CONV_TARGET, squadId: SQUAD_B },
        operation: "read",
      }),
    ).toBe(false)
  })

  it("requires explicit elevatedSquadId for Workspace Orchestrator cross-Squad reads/proposals and refuses cross-Squad notes", () => {
    const wsOrch = makeCtx({
      squadId: null,
      orchestrator: {
        id: "88888888-8888-4888-8888-888888888888",
        scopeType: "WORKSPACE",
        scopeKey: "workspace",
        enabled: true,
      },
    })
    expect(
      evaluateThreadCoordinationAccess({
        caller: wsOrch,
        target: { id: CONV_TARGET, squadId: null },
        operation: "read",
      }),
    ).toBe(true)
    expect(
      evaluateThreadCoordinationAccess({
        caller: wsOrch,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        operation: "read",
      }),
    ).toBe(false)
    expect(
      evaluateThreadCoordinationAccess({
        caller: wsOrch,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        elevatedSquadId: SQUAD_A,
        operation: "write",
      }),
    ).toBe(true)
    expect(
      evaluateThreadCoordinationAccess({
        caller: wsOrch,
        target: { id: CONV_TARGET, squadId: SQUAD_A },
        elevatedSquadId: SQUAD_A,
        operation: "notes",
      }),
    ).toBe(false)
  })
})

describe("evaluateSquadDestinationAccess & evaluateSendMessageGuard", () => {
  it("permits unassigned self-assignment to a Squad via threads_set_squad while blocking moving other threads", () => {
    const unassignedCaller = makeCtx({ squadId: null, orchestrator: null })
    expect(
      evaluateSquadDestinationAccess({
        caller: unassignedCaller,
        targetConversationId: CONV_CALLER,
        destinationSquadId: SQUAD_A,
      }),
    ).toBe(true)

    expect(
      evaluateSquadDestinationAccess({
        caller: unassignedCaller,
        targetConversationId: CONV_TARGET,
        destinationSquadId: SQUAD_A,
      }),
    ).toBe(false)
  })

  it("blocks self-sends and blocks self-approving a pending PROPOSED_REPLY via threads_send_message", () => {
    const wsOrch = makeCtx({
      orchestrator: {
        id: "88888888-8888-4888-8888-888888888888",
        scopeType: "WORKSPACE",
        scopeKey: "workspace",
        enabled: true,
      },
    })

    expect(
      evaluateSendMessageGuard({
        caller: wsOrch,
        targetConversationId: CONV_CALLER,
        pendingProposedReply: null,
      }).allowed,
    ).toBe(false)

    expect(
      evaluateSendMessageGuard({
        caller: wsOrch,
        targetConversationId: CONV_TARGET,
        pendingProposedReply: {
          text: "Rebase onto main and run tests",
          authorOrchestratorId: wsOrch.orchestrator?.id,
        },
      }).allowed,
    ).toBe(false)

    expect(
      evaluateSendMessageGuard({
        caller: wsOrch,
        targetConversationId: CONV_TARGET,
        pendingProposedReply: null,
      }),
    ).toEqual({ allowed: true })
  })
})

describe("evaluateAndAdvanceEscalationState", () => {
  it("enforces 30-minute (kind, subject) dedup and 1 msg / 5m burst-3 token bucket", () => {
    const t0 = 1_700_000_000_000

    const r1 = evaluateAndAdvanceEscalationState(null, {
      kind: "blocked",
      subject: "Schema lock",
      nowMs: t0,
    })
    expect(r1.allowed).toBe(true)

    const dup = evaluateAndAdvanceEscalationState(r1.nextStateJson, {
      kind: "blocked",
      subject: "  schema   LOCK ",
      nowMs: t0 + 60_000,
    })
    expect(dup.allowed).toBe(false)
    if (!dup.allowed) {
      expect(dup.reason).toBe("duplicate")
    }

    const r2 = evaluateAndAdvanceEscalationState(r1.nextStateJson, {
      kind: "error",
      subject: "API contract",
      nowMs: t0 + 1_000,
    })
    expect(r2.allowed).toBe(true)

    const r3 = evaluateAndAdvanceEscalationState(r2.nextStateJson, {
      kind: "pr_ready",
      subject: "QA ready",
      nowMs: t0 + 2_000,
    })
    expect(r3.allowed).toBe(true)

    const exhausted = evaluateAndAdvanceEscalationState(r3.nextStateJson, {
      kind: "needs_you",
      subject: "Fourth in burst",
      nowMs: t0 + 3_000,
    })
    expect(exhausted.allowed).toBe(false)
    if (!exhausted.allowed) {
      expect(exhausted.reason).toBe("rate_limited")
    }

    const refilled = evaluateAndAdvanceEscalationState(r3.nextStateJson, {
      kind: "needs_you",
      subject: "After 5m refill",
      nowMs: t0 + 5 * 60_000 + 3_000,
    })
    expect(refilled.allowed).toBe(true)
  })
})

describe("resolveCallingThreadContext & getOrchestratorSkillAppendixForConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects calls outside an AGENT_TURN credential", async () => {
    mockGetMcpActor.mockReturnValue({ purpose: "PERSONAL", credentialId: "key-1" })
    await expect(resolveCallingThreadContext(mockPrisma as never)).rejects.toThrow(
      /only be called by an in-app agent during an active turn/,
    )
  })

  it("resolves WORKSPACE orchestrator role when the caller conversation matches an AgentOrchestrator", async () => {
    mockGetMcpActor.mockReturnValue({ purpose: "AGENT_TURN", credentialId: "key-1" })
    mockFindFirstRun.mockResolvedValue({
      id: "run-1",
      conversationId: CONV_CALLER,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      agentId: null,
    })
    mockFindFirstConv.mockResolvedValue({
      id: CONV_CALLER,
      squadId: null,
    })
    mockFindFirstOrch.mockResolvedValue({
      id: "orch-1",
      scopeType: "WORKSPACE",
      scopeKey: "workspace",
      enabled: true,
    })

    const ctx = await resolveCallingThreadContext(mockPrisma as never)
    expect(ctx.orchestrator?.scopeType).toBe("WORKSPACE")
    expect(ctx.orchestrator?.id).toBe("orch-1")
  })

  it("injects THREAD_ORCHESTRATOR_SKILL_MARKDOWN only for enabled orchestrator conversations", async () => {
    mockFindFirstOrch.mockResolvedValueOnce({
      id: "orch-1",
      scopeType: "WORKSPACE",
      scopeKey: "workspace",
      enabled: true,
    })
    const hit = await getOrchestratorSkillAppendixForConversation(mockPrisma as never, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      conversationId: CONV_CALLER,
    })
    expect(hit).toContain(THREAD_ORCHESTRATOR_SKILL_MARKDOWN)
    expect(THREAD_ORCHESTRATOR_SKILL_MARKDOWN).toContain("Intervention Gate")
    expect(THREAD_ORCHESTRATOR_SKILL_MARKDOWN).toContain("[[thread:")

    mockFindFirstOrch.mockResolvedValueOnce(null)
    const miss = await getOrchestratorSkillAppendixForConversation(mockPrisma as never, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      conversationId: CONV_TARGET,
    })
    expect(miss).toBeNull()
  })
})
