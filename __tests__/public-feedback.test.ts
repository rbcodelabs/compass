/**
 * The public feedback predicate and the surfaces that use it. The fake
 * feedbackItem store applies the `where` it is given (workspace, source
 * allow-list, status), so these tests fail if a surface stops filtering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = {
  id: string;
  workspaceId: string;
  source: string;
  status: string;
  title: string;
  voteCount: number;
  createdAt: Date;
  // Fields a public surface must never see:
  submitterEmail: string | null;
  createdById: string | null;
};

const rows: Row[] = [];

type Where = { id?: string; workspaceId: string; source?: { in: string[] }; status?: { not: string } };
function matches(row: Row, where: Where) {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (row.workspaceId !== where.workspaceId) return false;
  if (where.source && !where.source.in.includes(row.source)) return false;
  if (where.status && row.status === where.status.not) return false;
  return true;
}

const mockFeedbackItem = {
  findMany: vi.fn(async ({ where, select, take }: { where: Where; select: Record<string, unknown>; take?: number }) =>
    rows
      .filter((r) => matches(r, where))
      .slice(0, take)
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) {
          out[key] = key === "attachments" ? [] : (r as Record<string, unknown>)[key] ?? null;
        }
        return out;
      }),
  ),
  findFirst: vi.fn(async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null),
  update: vi.fn(async () => ({ voteCount: 1 })),
};
const mockFeedbackVote = { findFirst: vi.fn(async () => null), create: vi.fn() };
const mockWorkspace = {
  findFirst: vi.fn(async () => ({
    id: "ws-1",
    feedbackEnabled: true,
    roadmapPublic: false,
    portalAuthRequired: false,
  })),
};
const mockPrisma = { workspace: mockWorkspace, feedbackItem: mockFeedbackItem, feedbackVote: mockFeedbackVote };

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));
vi.mock("@/lib/portal-auth", () => ({ getPortalSession: vi.fn() }));

import { GET } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/feedback/route";
import { POST as VOTE } from "@/app/api/portal/[orgSlug]/[workspaceSlug]/vote/route";
import { resolveFeedbackCta } from "@/lib/portal-home/resolvers/feedback-cta";
import { PUBLIC_FEEDBACK_SOURCES, publicFeedbackItemWhere } from "@/lib/public-feedback";

const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "ws" });

function row(id: string, source: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: "ws-1",
    source,
    status: "OPEN",
    title: `title ${id}`,
    voteCount: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    submitterEmail: "someone@example.com",
    createdById: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  rows.push(
    row("portal-1", "PORTAL"),
    row("ui-1", "UI"),
    row("mcp-1", "MCP"),
    row("rest-1", "REST"),
    row("unknown-1", "SOMETHING_NEW"),
    row("portal-declined", "PORTAL", { status: "DECLINED" }),
    row("portal-other-ws", "PORTAL", { workspaceId: "ws-2" }),
  );
});

describe("publicFeedbackItemWhere", () => {
  it("is an allow-list of PORTAL, scoped to the workspace, excluding declined", () => {
    expect(PUBLIC_FEEDBACK_SOURCES).toEqual(["PORTAL"]);
    expect(publicFeedbackItemWhere("ws-1")).toEqual({
      workspaceId: "ws-1",
      source: { in: ["PORTAL"] },
      status: { not: "DECLINED" },
    });
  });
});

describe("GET portal feedback API", () => {
  it("returns portal items only, never internal-source items", async () => {
    const res = await GET(new NextRequest("http://localhost/api/portal/acme/ws/feedback"), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.map((i) => i.id)).toEqual(["portal-1"]);
  });

  it("uses the explicit safe select and exposes no email or actor columns", async () => {
    const res = await GET(new NextRequest("http://localhost/api/portal/acme/ws/feedback"), { params });
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const select = mockFeedbackItem.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("submitterEmail");
    expect(select).not.toHaveProperty("createdById");
    expect(body.items[0]).not.toHaveProperty("submitterEmail");
    expect(body.items[0]).not.toHaveProperty("createdById");
  });

  it("returns nothing when only internal items exist (fails closed)", async () => {
    rows.splice(0, rows.length, row("ui-1", "UI"), row("mcp-1", "MCP"));
    const res = await GET(new NextRequest("http://localhost/api/portal/acme/ws/feedback"), { params });
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe("portal vote route (feedback)", () => {
  const vote = (itemId: string) =>
    VOTE(
      new NextRequest("http://localhost/api/portal/acme/ws/vote", {
        method: "POST",
        body: JSON.stringify({ type: "feedback", itemId, voterEmail: "voter@example.com" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params },
    );

  it("rejects a vote on an internal-source item without recording anything", async () => {
    for (const id of ["ui-1", "mcp-1", "rest-1", "unknown-1"]) {
      const res = await vote(id);
      expect(res.status).toBe(404);
    }
    expect(mockFeedbackVote.create).not.toHaveBeenCalled();
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("accepts a vote on a portal item", async () => {
    const res = await vote("portal-1");
    expect(res.status).toBe(200);
    expect(mockFeedbackVote.create).toHaveBeenCalledTimes(1);
  });
});

describe("portal home feedback CTA", () => {
  const ctx = (audience: "customer" | "team") =>
    ({
      audience,
      prisma: mockPrisma,
      workspace: { id: "ws-1", orgSlug: "acme", workspaceSlug: "ws", roadmapPublic: false, feedbackEnabled: true },
    }) as unknown as Parameters<typeof resolveFeedbackCta>[0];

  it("shows customers only portal-sourced top ideas", async () => {
    const res = await resolveFeedbackCta(ctx("customer"), { showTopIdeas: true } as never);
    expect(res).toMatchObject({ available: true });
    const ids = (res as unknown as { data: { topIdeas: Array<{ id: string }> } }).data.topIdeas.map((i) => i.id);
    expect(ids).toEqual(["portal-1"]);
  });
});
