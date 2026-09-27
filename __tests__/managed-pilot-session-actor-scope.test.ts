/**
 * Reproduces Finding A from PR #316's hosted-verification pass
 * (docs/testing/geode-pilot-required-evidence.md): in managed-pilot mode, the
 * Settings page (and every sibling route that builds the same plain session
 * actor) 500s for *any* authenticated session, including the pilot's own.
 *
 * Root cause: `{ userId, purpose: "USER" }` session actors never carry
 * `scopeWorkspaceId` (that field is an MCP-API-key-only concept — see
 * lib/mcp-auth.ts's `narrowed to the configured workspace` path). But
 * `assertActorWorkspaceScope`'s managed-mode branch in lib/mcp-authz.ts
 * requires `actor.scopeWorkspaceId === managed.workspaceId` unconditionally,
 * so it throws for every session actor, not just ones outside the pilot
 * workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PILOT_WORKSPACE_ID = "54a22b13-572b-4ee8-9328-41c4b5fe6cfd";

const state = vi.hoisted(() => ({
  db: {
    workspace: { findFirst: vi.fn() },
    analyticsConnection: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ default: () => state.db }));
vi.mock("@/lib/preview-automation/managed-context", () => ({
  getManagedPilotContext: () => ({
    workspaceId: PILOT_WORKSPACE_ID,
    runId: "11111111-1111-4111-8111-111111111111",
    deploymentId: "dpl_x",
    schema: "compass_pr_276_abc",
    pr: "276",
    sha: "a".repeat(40),
    origin: "https://x.vercel.app",
  }),
}));

import { listConnections } from "@/lib/analytics/service";

beforeEach(() => {
  vi.clearAllMocks();
  state.db.workspace.findFirst.mockResolvedValue({ id: PILOT_WORKSPACE_ID });
  state.db.analyticsConnection.findMany.mockResolvedValue([]);
});

describe("managed-pilot mode: session actor workspace scope (Finding A)", () => {
  it("rejects a plain session actor missing scopeWorkspaceId, even for the pilot's own workspace", async () => {
    const sessionActor = { userId: "human-user", purpose: "USER" as const };
    await expect(listConnections(sessionActor, PILOT_WORKSPACE_ID)).rejects.toThrow(
      /workspace not found or access denied/i
    );
  });

  it("allows the same session once it carries the pilot workspace's scopeWorkspaceId", async () => {
    const sessionActor = { userId: "human-user", purpose: "USER" as const, scopeWorkspaceId: PILOT_WORKSPACE_ID };
    await expect(listConnections(sessionActor, PILOT_WORKSPACE_ID)).resolves.toEqual([]);
  });

  it("still refuses a session actor scoped to a different workspace", async () => {
    const sessionActor = { userId: "human-user", purpose: "USER" as const, scopeWorkspaceId: "other-workspace" };
    await expect(listConnections(sessionActor, PILOT_WORKSPACE_ID)).rejects.toThrow(
      /workspace not found or access denied/i
    );
  });
});
