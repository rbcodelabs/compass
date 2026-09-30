/**
 * Objective.cycleId is optional (migration 069, ADR Phase 1).
 *
 * Authorization reads Objective.workspaceId, never the cycle, so a cycle-less
 * Objective must be exactly as reachable to its own workspace's members, and
 * exactly as unreachable to everyone else, as a cycled one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: "T", email: "t@example.com" } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { McpAuthzError, assertEntityAccess, runWithMcpActor, type McpActor } from "@/lib/mcp-authz";
import { applyToolGate } from "@/lib/mcp-tool-gates";
import { requireProductEntity } from "@/lib/product-action-auth";
import * as okrActions from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

const alice: McpActor = { userId: USERS.alice, purpose: "USER" };

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = USERS.alice;
  fake.current.state.objectives.push(
    { id: "obj-nocycle-a", workspaceId: WS_A.id, cycleId: null, title: "A persistent objective", status: "ON_TRACK", sortOrder: 1 },
    { id: "obj-nocycle-b", workspaceId: WS_B.id, cycleId: null, title: "B persistent objective", status: "ON_TRACK", sortOrder: 1 },
  );
  fake.current.state.keyResults.push(
    { id: "kr-nocycle-a", objectiveId: "obj-nocycle-a", title: "A persistent KR", target: 10, current: 0, sortOrder: 0 },
    { id: "kr-nocycle-b", objectiveId: "obj-nocycle-b", title: "B persistent KR", target: 10, current: 0, sortOrder: 0 },
  );
  vi.clearAllMocks();
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const writes = () => fake.current!.state.writes;

describe("createObjective with no cycle", () => {
  it("creates a cycle-less Objective stamped with the workspace resolved from the member's slugs", async () => {
    await okrActions.createObjective(null, WS_A.org, WS_A.slug, form({ title: "Persistent goal" }));
    const created = fake.current!.state.objectives.find((o) => o.title === "Persistent goal");
    expect(created).toMatchObject({ workspaceId: WS_A.id, cycleId: null });
  });

  it("rejects slugs of a workspace the caller is not a member of and writes nothing", async () => {
    await expect(okrActions.createObjective(null, WS_B.org, WS_B.slug, form({ title: "Sneaky" }))).rejects.toThrow("Workspace not found or access denied");
    expect(writes()).toEqual([]);
  });

  it("rejects an unauthenticated caller", async () => {
    session.userId = null;
    await expect(okrActions.createObjective(null, WS_A.org, WS_A.slug, form({ title: "Anon" }))).rejects.toThrow("Unauthorized");
    expect(writes()).toEqual([]);
  });

  it("still verifies the cycle when one is provided (B's cycle under A is denied)", async () => {
    await expect(okrActions.createObjective("cycle-b", WS_A.org, WS_A.slug, form({ title: "Sneaky" }))).rejects.toThrow("Entity not found or access denied");
    expect(writes()).toEqual([]);
  });
});

describe("authorization of cycle-less Objectives is workspace-scoped, not cycle-scoped", () => {
  it("a member of A reaches A's cycle-less Objective and its Key Result", async () => {
    await expect(assertEntityAccess(alice, "objective", "obj-nocycle-a")).resolves.toEqual({ workspaceId: WS_A.id });
    await expect(assertEntityAccess(alice, "keyResult", "kr-nocycle-a")).resolves.toEqual({ workspaceId: WS_A.id });
    await expect(requireProductEntity("objective", "obj-nocycle-a")).resolves.toMatchObject({ workspaceId: WS_A.id });
    await expect(requireProductEntity("keyResult", "kr-nocycle-a")).resolves.toMatchObject({ workspaceId: WS_A.id });
  });

  it("a member of A cannot reach B's cycle-less Objective or Key Result", async () => {
    await expect(assertEntityAccess(alice, "objective", "obj-nocycle-b")).rejects.toThrow(McpAuthzError);
    await expect(assertEntityAccess(alice, "keyResult", "kr-nocycle-b")).rejects.toThrow(McpAuthzError);
    await expect(requireProductEntity("objective", "obj-nocycle-b")).rejects.toThrow("Entity not found or access denied");
    await expect(requireProductEntity("keyResult", "kr-nocycle-b")).rejects.toThrow("Entity not found or access denied");
  });

  it("MCP tool gates allow A's cycle-less Objective and deny B's", async () => {
    const gated = (tool: string, args: Record<string, unknown>) => runWithMcpActor(alice, () => applyToolGate(tool, alice, args));
    for (const tool of ["update_objective", "delete_objective", "add_key_result"]) {
      await expect(gated(tool, { objectiveId: "obj-nocycle-a" })).resolves.toBeUndefined();
      await expect(gated(tool, { objectiveId: "obj-nocycle-b" })).rejects.toThrow(McpAuthzError);
    }
  });

  it("create_objective's gate needs only workspace membership (no cycle) and still denies B", async () => {
    const gated = (args: Record<string, unknown>) => runWithMcpActor(alice, () => applyToolGate("create_objective", alice, args));
    await expect(gated({ workspaceId: WS_A.id })).resolves.toBeUndefined();
    await expect(gated({ workspaceId: WS_B.id })).rejects.toThrow(McpAuthzError);
  });

  it("server actions on a cycle-less Objective: own workspace allowed, foreign denied", async () => {
    await okrActions.updateObjectiveStatus("obj-nocycle-a", "AT_RISK", WS_A.org, WS_A.slug);
    expect(fake.current!.state.objectives.find((o) => o.id === "obj-nocycle-a")!.status).toBe("AT_RISK");
    await expect(okrActions.updateObjectiveStatus("obj-nocycle-b", "AT_RISK", WS_A.org, WS_A.slug)).rejects.toThrow("Entity not found or access denied");
    expect(fake.current!.state.objectives.find((o) => o.id === "obj-nocycle-b")!.status).toBe("ON_TRACK");
  });
});
