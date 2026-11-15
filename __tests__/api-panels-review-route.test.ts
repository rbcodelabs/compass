import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirst: vi.fn(),
  findAgent: vi.fn(),
  findUser: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    reviewRequest: { findFirst: mocks.findFirst },
    agent: { findUnique: mocks.findAgent },
    user: { findUnique: mocks.findUser },
  }),
}))

import { GET } from "@/app/api/panels/review/[id]/route"

const REQ_ID = "11111111-2222-4333-8444-555555555555"

describe("GET /api/panels/review/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.findAgent.mockResolvedValue(null)
    mocks.findUser.mockResolvedValue(null)
  })

  it("returns 401 when unauthenticated", async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await GET(new Request(`http://localhost/api/panels/review/${REQ_ID}?orgSlug=acme&workspaceSlug=product`), {
      params: Promise.resolve({ id: REQ_ID }),
    })
    expect(res.status).toBe(401)
  })

  it("enforces excludeToolApprovals on lookup and returns displayId, requester, sourcesCount, and resolved decider name", async () => {
    mocks.findAgent.mockResolvedValue({ id: "agent-7", name: "Discovery Lead" })
    mocks.findUser.mockResolvedValue({ name: "Alex Rivera", email: "alex@example.com" })
    mocks.findFirst.mockResolvedValue({
      id: REQ_ID,
      seqPrefix: "DEC",
      seqNumber: 42,
      workspaceId: "ws-1",
      state: "DECIDED",
      gateType: "TRACKED_DECISION",
      requestedByAgentId: "agent-7",
      requestedById: "user-1",
      currentRevision: {
        id: "rev-1",
        revisionNumber: 2,
        createdAt: new Date("2026-11-15T12:00:00Z"),
        title: "Adopt Inbox Triage?",
        summary: "Summary fallback",
        fingerprint: "fp-1",
        supersededAt: null,
        packetJson: JSON.stringify({
          schemaVersion: "tracked-decision/v2",
          question: "Adopt Inbox Triage?",
          context: "## Recommendation\n\nAdopt Inbox Triage.",
          entity: { type: "SOLUTION", id: "sol-1", title: "Decision redesign", updatedAt: "2026-11-15T10:00:00Z" },
          sources: [
            { type: "OPPORTUNITY", id: "opp-1", title: "Review friction", updatedAt: "2026-11-15T09:00:00Z" },
          ],
        }),
        options: [
          { id: "opt-rej", label: "Reject", outcomeClass: "REJECT", actionKey: "REJECT", description: null },
        ],
        decisions: [
          {
            actorUserId: "user-2",
            actorRole: "ADMIN",
            decidedAt: new Date("2026-11-15T13:00:00Z"),
            rationale: "Needs mobile responsive check.",
            answersJson: null,
            option: { label: "Reject", description: null, outcomeClass: "REJECT", actionKey: "REJECT" },
          },
        ],
      },
      workspace: {
        members: [{ role: "ADMIN" }],
        organization: { members: [] },
      },
    })

    const res = await GET(new Request(`http://localhost/api/panels/review/${REQ_ID}?orgSlug=acme&workspaceSlug=product`), {
      params: Promise.resolve({ id: REQ_ID }),
    })
    expect(res.status).toBe(200)
    // Verify excludeToolApprovals was included in the Prisma query predicate
    expect(mocks.findFirst.mock.calls[0][0].where).toMatchObject({
      id: REQ_ID,
      gateType: { not: "TOOL_APPROVAL" },
    })
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      id: REQ_ID,
      displayId: "DEC-42",
      revisionNumber: 2,
      sourcesCount: 1,
      requester: { type: "AGENT", id: "agent-7", name: "Discovery Lead" },
      linkedTo: { type: "SOLUTION", id: "sol-1", title: "Decision redesign" },
      decision: expect.objectContaining({
        label: "Reject",
        outcomeClass: "REJECT",
        decidedByName: "Alex Rivera",
      }),
    })
  })
})
