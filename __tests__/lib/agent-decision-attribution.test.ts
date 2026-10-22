import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A cloud run of a named agent is the AGENT acting. Decisions it requests or closes, and artifacts it links to a decision,
 * must not be recorded as the invoking person's, where the schema allows leaving the human column empty.
 */
const m = vi.hoisted(() => ({
  create: vi.fn(),
  noAction: vi.fn(),
  link: vi.fn(),
  release: vi.fn(),
  findAgent: vi.fn(),
  actor: { current: {} as Record<string, unknown> },
}))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => m.actor.current }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findUnique: vi.fn().mockResolvedValue(null) } }) }))
vi.mock("@/lib/tracked-decisions", () => ({
  createTrackedDecisionRequest: (...a: unknown[]) => m.create(...a),
  recordDecisionNoAction: (...a: unknown[]) => m.noAction(...a),
  TrackedDecisionError: class extends Error {},
}))
vi.mock("@/lib/release-authorization", () => ({ prepareReleaseRun: (...a: unknown[]) => m.release(...a), queueAuthorizedRelease: vi.fn(), unconfiguredReleaseSourceRevalidator: { revalidate: vi.fn() } }))
vi.mock("@/lib/artifacts", () => ({ linkArtifactToDecision: (...a: unknown[]) => m.link(...a), getDecisionArtifacts: vi.fn() }))
vi.mock("@/lib/agent-ownership", async (orig) => ({ ...(await orig<object>()), findAgentById: (...a: unknown[]) => m.findAgent(...a) }))

import { closeDecisionNoAction, requestDecision, requestReleaseAuthorization } from "@/lib/decision-tool-handlers"
import { linkArtifactDecision } from "@/lib/artifact-tool-handlers"

const request = { workspaceId: "ws", subjectType: "SOLUTION" as const, subjectId: "s", question: "q", context: "c", idempotencyKey: "k" }
const cloudRun = { purpose: "AGENT_TURN", userId: "invoker", agentId: "agent-shared", agentRunId: "run-1" }

beforeEach(() => {
  vi.clearAllMocks()
  m.create.mockResolvedValue({ requestId: "r1", id: "rev1" })
  m.noAction.mockResolvedValue({ id: "r1" })
  m.link.mockResolvedValue({ id: "link", created: true })
  m.findAgent.mockResolvedValue({ id: "agent-shared", name: "Triage" })
})

describe("request_decision", () => {
  it("records a cloud run's request as the agent's, with no human requester", async () => {
    m.actor.current = cloudRun
    await requestDecision(request)
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ requestedById: null, requestedByAgentId: "agent-shared" }))
  })

  it("keeps a personal agent key's established shape (owner and agent)", async () => {
    m.actor.current = { purpose: "AGENT", userId: "owner", agentId: "agent-personal" }
    await requestDecision(request)
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ requestedById: "owner", requestedByAgentId: "agent-personal" }))
  })

  it.each([
    ["a person", { purpose: "USER", userId: "u1" }],
    ["the built-in assistant (no agent id)", { purpose: "AGENT_TURN", userId: "u1", agentId: null }],
  ])("records %s as the requester with no agent", async (_label, actor) => {
    m.actor.current = actor
    await requestDecision(request)
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ requestedById: "u1", requestedByAgentId: null }))
  })
})

describe("close_decision_no_action", () => {
  it("does not name the invoker as the closer for a cloud run, and names the agent in the reason", async () => {
    m.actor.current = cloudRun
    await closeDecisionNoAction({ workspaceId: "ws", requestId: "r1", reason: "Superseded" })
    expect(m.noAction).toHaveBeenCalledWith({ workspaceId: "ws", requestId: "r1", reason: "Superseded", actorUserId: null, recordedPrefix: "[Closed by agent Triage (agent-shared)] " })
  })

  it("still records a person as the closer, with their reason untouched", async () => {
    m.actor.current = { purpose: "USER", userId: "u1" }
    await closeDecisionNoAction({ workspaceId: "ws", requestId: "r1", reason: "Superseded" })
    expect(m.noAction).toHaveBeenCalledWith({ workspaceId: "ws", requestId: "r1", reason: "Superseded", actorUserId: "u1" })
    expect(m.findAgent).not.toHaveBeenCalled()
  })

  it("passes the person's reason through untouched, so a 2,000-character reason is not pushed over its limit by the agent note", async () => {
    m.actor.current = cloudRun
    const long = "x".repeat(2000)
    await closeDecisionNoAction({ workspaceId: "ws", requestId: "r1", reason: long })
    expect(m.noAction.mock.calls[0][0].reason).toHaveLength(2000)
    expect(m.noAction.mock.calls[0][0].recordedPrefix).toContain("agent-shared")
  })
})

describe("request_release_authorization", () => {
  const scope = { workspaceId: "ws", provider: "GITHUB" as const, repositoryOwner: "o", repositoryName: "r", pullRequestNumber: 1, baseRef: "main", headSha: "a".repeat(40), targetEnvironment: "PRODUCTION" as const, releasePolicyId: "p", taskIds: [] }

  it.each([
    ["a cloud run", cloudRun, null],
    ["a person", { purpose: "USER", userId: "u1" }, "u1"],
    ["a personal agent key", { purpose: "AGENT", userId: "owner", agentId: "agent-personal" }, "owner"],
    ["the built-in assistant", { purpose: "AGENT_TURN", userId: "u1", agentId: null }, "u1"],
  ])("records the requester for %s", async (_label, actor, expected) => {
    m.actor.current = actor
    m.release.mockResolvedValue({ status: "BLOCKED", code: "X" })
    await requestReleaseAuthorization(scope)
    expect(m.release).toHaveBeenCalledWith(expect.objectContaining({ requestedById: expected }))
  })
})

describe("link_artifact_to_decision", () => {
  const input = { workspaceId: "ws", artifactId: "a", requestId: "r1" }

  it.each([
    ["a cloud run", cloudRun],
    ["a personal agent key", { purpose: "AGENT", userId: "owner", agentId: "agent-personal" }],
  ])("leaves createdById empty for %s instead of crediting a person", async (_label, actor) => {
    m.actor.current = actor
    await linkArtifactDecision(input)
    expect(m.link).toHaveBeenCalledWith(expect.objectContaining({ createdById: null, source: "MCP" }))
  })

  it("credits the person when a person links", async () => {
    m.actor.current = { purpose: "USER", userId: "u1" }
    await linkArtifactDecision(input)
    expect(m.link).toHaveBeenCalledWith(expect.objectContaining({ createdById: "u1" }))
  })
})
