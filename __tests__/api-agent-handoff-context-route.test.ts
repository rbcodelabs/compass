/**
 * Guard + happy-path tests for GET /api/agent/handoff-context
 * (app/api/agent/handoff-context/route.ts) — the endpoint the Geode bridge
 * picker (components/agent/send-to-agent-picker.tsx) fetches before posting
 * `agent.handoff` across the bridge. Pattern after
 * __tests__/api-agent-turn-route.test.ts: mock auth()/prisma/the resolver
 * rather than hitting a real DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockResolveAgentHandoffContext = vi.fn()
vi.mock("@/lib/agent-context", () => ({
  resolveAgentHandoffContext: (...args: unknown[]) => mockResolveAgentHandoffContext(...args),
}))

import { GET } from "@/app/api/agent/handoff-context/route"

const SESSION = { user: { id: "user-1" } }

function req(query: Record<string, string>): Request {
  const params = new URLSearchParams(query)
  return new Request(`https://compass.rbcodelabs.com/api/agent/handoff-context?${params.toString()}`)
}

const VALID_QUERY = {
  orgSlug: "acme",
  workspaceSlug: "product",
  entityType: "solutionPlan",
  entityId: "plan-1",
}

const HANDOFF = {
  label: "Approved plan · Redesigned onboarding",
  summary: "Ship a redesigned onboarding flow.",
  suggestedInstruction: "Help me move forward with the approved plan.",
  promptBlock: "Approved Solution Plan for \"Redesigned onboarding\":\n\n...",
  sourceUrl: "/acme/product/discovery/opp-1?detail=solution:sol-1",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue(SESSION)
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  mockResolveAgentHandoffContext.mockResolvedValue(HANDOFF)
})

describe("GET /api/agent/handoff-context", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const response = await GET(req(VALID_QUERY))
    expect(response.status).toBe(401)
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it("400s when a required param is missing", async () => {
    const { entityId: _entityId, ...rest } = VALID_QUERY
    const response = await GET(req(rest))
    expect(response.status).toBe(400)
  })

  it("400s on an unrecognized entityType", async () => {
    const response = await GET(req({ ...VALID_QUERY, entityType: "roadmapItem" }))
    expect(response.status).toBe(400)
  })

  it("404s when the workspace isn't found or the user isn't a member", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    const response = await GET(req(VALID_QUERY))
    expect(response.status).toBe(404)
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: "product",
          organization: { slug: "acme" },
          members: { some: { userId: "user-1" } },
        }),
      })
    )
  })

  it("404s when resolveAgentHandoffContext returns null (no approved context)", async () => {
    mockResolveAgentHandoffContext.mockResolvedValue(null)
    const response = await GET(req(VALID_QUERY))
    expect(response.status).toBe(404)
  })

  it("200s with the resolved context plus identifying fields on the happy path", async () => {
    const response = await GET(req(VALID_QUERY))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      entityType: "solutionPlan",
      entityId: "plan-1",
      orgSlug: "acme",
      workspaceSlug: "product",
      label: HANDOFF.label,
      summary: HANDOFF.summary,
      suggestedInstruction: HANDOFF.suggestedInstruction,
      promptBlock: HANDOFF.promptBlock,
      sourceUrl: HANDOFF.sourceUrl,
    })
    expect(mockResolveAgentHandoffContext).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      entityType: "solutionPlan",
      entityId: "plan-1",
    })
  })
})
