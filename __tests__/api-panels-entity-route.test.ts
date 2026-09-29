/**
 * Unit tests for app/api/panels/entity/[type]/[id]/route.ts.
 *
 * auth(), getWorkspace(), and getEntityDetail() are mocked (same mocking
 * pattern as api-panels-discovery-rail-route.test.ts). The security-critical
 * assertion: a caller who isn't a member of the workspace (getWorkspace →
 * null) gets a 404 and the entity is NEVER looked up — this is the guard that
 * closes the cross-workspace IDOR the old per-type panel routes had.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }));
vi.mock("@/lib/entity-detail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entity-detail")>(
    "@/lib/entity-detail"
  );
  return { ...actual, getEntityDetail: vi.fn() };
});

vi.mock("@/lib/entity-mutations", () => ({ updateEntityField: vi.fn() }));

import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { getEntityDetail } from "@/lib/entity-detail";
import { updateEntityField } from "@/lib/entity-mutations";
import { GET, PATCH } from "@/app/api/panels/entity/[type]/[id]/route";

const mockAuth = vi.mocked(auth);
const mockGetWorkspace = vi.mocked(getWorkspace);
const mockGetEntityDetail = vi.mocked(getEntityDetail);
const mockUpdateEntityField = vi.mocked(updateEntityField);

function call(type: string, id: string, query = "?orgSlug=acme&workspaceSlug=ws") {
  return GET(new Request(`http://localhost/api/panels/entity/${type}/${id}${query}`), {
    params: Promise.resolve({ type, id }),
  });
}

function patch(
  type: string,
  id: string,
  body: unknown,
  query = "?orgSlug=acme&workspaceSlug=ws"
) {
  return PATCH(
    new Request(`http://localhost/api/panels/entity/${type}/${id}${query}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ type, id }) }
  );
}

const signedIn = () => mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/panels/entity/[type]/[id]", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await call("opportunity", "opp-1");
    expect(res.status).toBe(401);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("400s on an unknown entity type", async () => {
    signedIn();
    const res = await call("user", "u-1");
    expect(res.status).toBe(400);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("400s when orgSlug/workspaceSlug are missing", async () => {
    signedIn();
    const res = await call("opportunity", "opp-1", "");
    expect(res.status).toBe(400);
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("404s and never looks up the entity when the user isn't a workspace member (IDOR guard)", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue(null); // not a member / no such workspace
    const res = await call("opportunity", "opp-in-another-workspace");
    expect(res.status).toBe(404);
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("404s when the entity doesn't resolve inside the workspace", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1" } as never);
    mockGetEntityDetail.mockResolvedValue(null);
    const res = await call("solution", "missing");
    expect(res.status).toBe(404);
    expect(mockGetEntityDetail).toHaveBeenCalledWith("solution", "missing", "ws-1");
  });

  it("returns the detail scoped to the member's workspace on success", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1" } as never);
    const detail = { type: "experiment" as const, data: { id: "exp-1", title: "T" } };
    mockGetEntityDetail.mockResolvedValue(detail as never);
    const res = await call("experiment", "exp-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(detail);
    // scoped to the workspace getWorkspace resolved, not anything client-supplied
    expect(mockGetEntityDetail).toHaveBeenCalledWith("experiment", "exp-1", "ws-1");
  });
});

describe("PATCH /api/panels/entity/[type]/[id]", () => {
  it("403s a read-only (org-wide fallback) context and never calls updateEntityField", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: true } as never);
    const res = await patch("opportunity", "opp-1", { field: "title", value: "New" });
    expect(res.status).toBe(403);
    expect(mockUpdateEntityField).not.toHaveBeenCalled();
  });

  it("succeeds for a real member (isReadOnly: false)", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockUpdateEntityField.mockResolvedValue({ ok: true } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "opportunity", data: { id: "opp-1" } } as never);
    const res = await patch("opportunity", "opp-1", { field: "title", value: "New" });
    expect(res.status).toBe(200);
    expect(mockUpdateEntityField).toHaveBeenCalledWith(
      "opportunity",
      "opp-1",
      "ws-1",
      "title",
      "New",
      { kind: "USER", id: "user-1" }
    );
  });
});
