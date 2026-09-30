/**
 * Tenant isolation for the MCP route handlers that create or mutate Solutions
 * and Objectives, driven through the real `register()` wrapper (gate first,
 * handler second) as a per-user actor against the tenant fake Prisma.
 *
 * What this pins down that the gate-only matrix in
 * solution-objective-isolation.test.ts cannot:
 *   - `add_solution` / `create_objective` stamp `workspaceId` from the authorized
 *     parent row (never from input), and
 *   - a mismatched parent/child pair (a workspace-A caller naming workspace B's
 *     cycle, or B's workspace) is rejected before any row is written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { runWithMcpActor } from "@/lib/mcp-authz";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
const registeredTools: Record<string, ToolCallback> = {};
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void }) => void) => {
    setup({ registerTool(name, _meta, cb) { registeredTools[name] = cb; } });
    return () => new Response("ok");
  },
}));
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

await import("@/app/api/mcp/route");

const alice = { userId: USERS.alice, purpose: "USER" as const };
const call = (name: string, args: Record<string, unknown>, actor: typeof alice = alice) => {
  const handler = registeredTools[name];
  if (!handler) throw new Error(`Tool "${name}" was not registered`);
  return runWithMcpActor(actor, () => handler(args));
};

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});

const state = () => fake.current!.state;

describe("create_objective", () => {
  it("stamps the cycle's workspaceId on the new Objective", async () => {
    const result = await call("create_objective", { workspaceId: WS_A.id, cycleId: "cycle-a", title: "Grow" });
    expect(result.content[0].text).toContain("Objective created");
    expect(state().objectives.find((o) => o.title === "Grow")).toMatchObject({ workspaceId: WS_A.id, cycleId: "cycle-a" });
  });

  it("rejects a cycle that belongs to another workspace (mismatched parent/child) without writing", async () => {
    // Alice is a member of A and legitimately names workspace A, but the cycle is B's.
    const result = await call("create_objective", { workspaceId: WS_A.id, cycleId: "cycle-b", title: "Smuggled" });
    expect(result.content[0].text).toContain('OKR cycle "cycle-b" not found in workspace.');
    expect(state().writes).toEqual([]);
    expect(state().objectives.some((o) => o.title === "Smuggled")).toBe(false);
  });

  it("rejects naming a workspace the caller is not a member of", async () => {
    await expect(call("create_objective", { workspaceId: WS_B.id, cycleId: "cycle-b", title: "Smuggled" })).rejects.toThrow(/access denied/);
    expect(state().writes).toEqual([]);
  });
});

describe("add_solution", () => {
  it("stamps the opportunity's workspaceId on the new Solution", async () => {
    const result = await call("add_solution", { opportunityId: "opp-a", title: "Idea" });
    expect(result.content[0].text).toContain("Solution created");
    expect(state().solutions.find((s) => s.title === "Idea")).toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a" });
  });

  it("rejects an opportunity in another workspace without writing", async () => {
    await expect(call("add_solution", { opportunityId: "opp-b", title: "Smuggled" })).rejects.toThrow(/not found or access denied/);
    expect(state().writes).toEqual([]);
  });
});

describe("Solution and Objective mutations are denied across tenants and for unbackfilled rows", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["update_solution", { solutionId: "sol-b", title: "x" }],
    ["update_solution", { solutionId: "sol-null", title: "x" }],
    ["update_solution_status", { solutionId: "sol-b", status: "VALIDATED" }],
    ["update_solution_status", { solutionId: "sol-null", status: "VALIDATED" }],
    ["update_objective", { objectiveId: "obj-b", title: "x" }],
    ["update_objective", { objectiveId: "obj-null", title: "x" }],
    ["delete_objective", { objectiveId: "obj-b" }],
    ["delete_objective", { objectiveId: "obj-null" }],
    ["add_key_result", { objectiveId: "obj-b", title: "KR", target: 5 }],
    ["add_key_result", { objectiveId: "obj-null", title: "KR", target: 5 }],
    ["set_objective_parent_kr", { objectiveId: "obj-b", keyResultId: null }],
    ["set_objective_parent_kr", { objectiveId: "obj-null", keyResultId: null }],
  ];

  it.each(cases)("%s %j is denied and writes nothing", async (tool, args) => {
    await expect(call(tool, args)).rejects.toThrow(/not found or access denied/);
    expect(state().writes).toEqual([]);
  });
});
