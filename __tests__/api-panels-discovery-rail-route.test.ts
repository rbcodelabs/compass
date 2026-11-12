/**
 * Unit tests for app/api/panels/discovery-rail/route.ts.
 *
 * Prisma and @/auth's auth() are both mocked, following the same pattern
 * used in __tests__/api-portal-feedback-route.test.ts, adapted for the
 * NextAuth session check this route uses instead of getPortalSession.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWorkspace = { findFirst: vi.fn() };
const mockOpportunity = { findMany: vi.fn() };
const mockSquad = { findMany: vi.fn() };
const mockOrgMember = { findFirst: vi.fn() };
const mockLinks = { findMany: vi.fn() };
const mockObjective = { findMany: vi.fn() };
// A Key Result is live when its id is asked for (the pointer reader's liveness check).
const mockKeyResult = { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, title: id }))) };

/** entity_links rows, by link type: Opportunity <-> Objective links and Opportunity -> Key Result pointers. */
const linkRows = { objectives: [] as Array<{ opportunityId: string; objectiveId: string }>, pointers: [] as Array<{ opportunityId: string; keyResultId: string }> };
const entityRow = (linkType: string, toType: string, fromId: string, toId: string, n: number) => ({
  id: `l${n}`, linkType, fromType: "OPPORTUNITY", fromId, toType, toId, origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(n),
});

const mockPrisma = {
  workspace: mockWorkspace,
  opportunity: mockOpportunity,
  entityLink: mockLinks,
  keyResult: mockKeyResult,
  objective: mockObjective,
  squad: mockSquad,
  organizationMember: mockOrgMember,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { auth } from "@/auth";
import { GET } from "@/app/api/panels/discovery-rail/route";

const mockAuth = vi.mocked(auth);

function makeRequest(query: string) {
  return new Request(`http://localhost/api/panels/discovery-rail${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgMember.findFirst.mockResolvedValue({ role: "MEMBER" });
  linkRows.objectives = [];
  linkRows.pointers = [];
  mockLinks.findMany.mockImplementation(async ({ where }: { where: { linkType: string } }) =>
    where.linkType === "OPPORTUNITY_TARGETS_OBJECTIVE"
      ? linkRows.objectives.map((l, i) => entityRow(where.linkType, "OBJECTIVE", l.opportunityId, l.objectiveId, i + 1))
      : linkRows.pointers.map((l, i) => entityRow(where.linkType, "KEY_RESULT", l.opportunityId, l.keyResultId, i + 1)),
  );
  mockObjective.findMany.mockResolvedValue([]);
});

describe("GET /api/panels/discovery-rail", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);

    const res = await GET(makeRequest("?orgSlug=acme&workspaceSlug=ws"));

    expect(res.status).toBe(401);
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
  });

  it("400s when orgSlug or workspaceSlug is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

    const res = await GET(makeRequest("?orgSlug=acme"));

    expect(res.status).toBe(400);
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the workspace doesn't exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockWorkspace.findFirst.mockResolvedValue(null);

    const res = await GET(makeRequest("?orgSlug=acme&workspaceSlug=ws"));

    expect(res.status).toBe(404);
    expect(mockOpportunity.findMany).not.toHaveBeenCalled();
  });

  it("returns opportunities grouped with their squad and workspaceId on success", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", slug: "ws", name: "WS" });
    mockOpportunity.findMany.mockResolvedValue([
      {
        id: "opp-1",
        title: "Improve onboarding",
        status: "EXPLORING",
        squadId: "squad-1",
      },
      {
        id: "opp-2",
        title: "No squad opportunity",
        status: "ACTIVE",
        squadId: null,
      },
    ]);
    mockSquad.findMany.mockResolvedValue([
      { id: "squad-1", name: "Growth", color: "#6366f1" },
    ]);

    // The same opportunity query serves the typed-link liveness read; the Key Result pointer comes from entity_links, not the row.
    linkRows.objectives = [{ opportunityId: "opp-1", objectiveId: "obj-1" }];
    linkRows.pointers = [{ opportunityId: "opp-1", keyResultId: "kr-1" }];
    mockObjective.findMany.mockResolvedValue([{ id: "obj-1", title: "Grow revenue" }]);

    const res = await GET(makeRequest("?orgSlug=acme&workspaceSlug=ws"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.workspaceId).toBe("ws-1");
    expect(data.opportunities).toEqual([
      {
        id: "opp-1",
        title: "Improve onboarding",
        status: "EXPLORING",
        squad: { id: "squad-1", name: "Growth", color: "#6366f1" },
        linkedKeyResultId: "kr-1",
        linkedObjectives: [{ id: "obj-1", title: "Grow revenue" }],
      },
      {
        id: "opp-2",
        title: "No squad opportunity",
        status: "ACTIVE",
        squad: null,
        linkedKeyResultId: null,
        linkedObjectives: [],
      },
    ]);
    // Links are read under the workspace, and their objectives are read under it too.
    expect(mockLinks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1", linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromId: { in: ["opp-1", "opp-2"] } }) }));
    expect(mockLinks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1", linkType: "OPPORTUNITY_TARGETS_KEY_RESULT", fromId: { in: ["opp-1", "opp-2"] } }) }));
    // The opportunity query no longer selects the (unused) linked_key_result_id column.
    expect(mockOpportunity.findMany.mock.calls[0][0].select).not.toHaveProperty("linkedKeyResultId");
    expect(mockObjective.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["obj-1"] }, workspaceId: "ws-1" } }));
    expect(data.squads).toEqual([{ id: "squad-1", name: "Growth", color: "#6366f1" }]);
  });
});
