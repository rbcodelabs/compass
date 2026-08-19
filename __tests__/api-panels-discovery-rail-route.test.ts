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

const mockPrisma = {
  workspace: mockWorkspace,
  opportunity: mockOpportunity,
  squad: mockSquad,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { GET } from "@/app/api/panels/discovery-rail/route";

const mockAuth = vi.mocked(auth);

function makeRequest(query: string) {
  return new Request(`http://localhost/api/panels/discovery-rail${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
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
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" });
    mockOpportunity.findMany.mockResolvedValue([
      {
        id: "opp-1",
        title: "Improve onboarding",
        status: "EXPLORING",
        squadId: "squad-1",
        linkedKeyResultId: "kr-1",
      },
      {
        id: "opp-2",
        title: "No squad opportunity",
        status: "ACTIVE",
        squadId: null,
        linkedKeyResultId: null,
      },
    ]);
    mockSquad.findMany.mockResolvedValue([
      { id: "squad-1", name: "Growth", color: "#6366f1" },
    ]);

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
      },
      {
        id: "opp-2",
        title: "No squad opportunity",
        status: "ACTIVE",
        squad: null,
        linkedKeyResultId: null,
      },
    ]);
    expect(data.squads).toEqual([{ id: "squad-1", name: "Growth", color: "#6366f1" }]);
  });
});
