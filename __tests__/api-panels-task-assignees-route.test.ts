/**
 * app/api/panels/task-assignees/route.ts — the GET read behind
 * useTaskAssignees. It replaced the getTaskAssigneeOptions server action so
 * that opening a task panel no longer queues a server action in the Next
 * router, where a navigation could let it commit the pre-navigation URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), eligible: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.workspace }));
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: mocks.eligible }));

import { GET } from "@/app/api/panels/task-assignees/route";

const request = (query: string) => new Request(`http://localhost/api/panels/task-assignees?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "human-user" } });
  mocks.workspace.mockResolvedValue({ id: "member-workspace" });
  mocks.eligible.mockResolvedValue([]);
});

describe("GET /api/panels/task-assignees", () => {
  it("requires a session", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request("orgSlug=org&workspaceSlug=ws"))).status).toBe(401);
    expect(mocks.eligible).not.toHaveBeenCalled();
  });

  it("requires both slugs", async () => {
    expect((await GET(request("orgSlug=org"))).status).toBe(400);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it("rejects a workspace outside session membership", async () => {
    mocks.workspace.mockResolvedValue(null);
    expect((await GET(request("orgSlug=org&workspaceSlug=foreign"))).status).toBe(404);
    expect(mocks.workspace).toHaveBeenCalledWith("org", "foreign", "human-user");
    expect(mocks.eligible).not.toHaveBeenCalled();
  });

  it("returns the eligible assignees for the member workspace", async () => {
    const options = [{ type: "USER", id: "u1", displayName: "Ada", available: true }];
    mocks.eligible.mockResolvedValue(options);
    const response = await GET(request("orgSlug=org&workspaceSlug=ws"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: options });
    expect(mocks.eligible).toHaveBeenCalledWith("member-workspace");
  });
});
