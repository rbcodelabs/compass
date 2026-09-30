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

describe("get_opportunity hides nested solutions that are not in the opportunity's workspace", () => {
  it("omits a NULL-workspace solution and a drifted one, keeps the consistent one", async () => {
    const solution = (id: string, workspaceId: string | null) => ({ id, workspaceId, title: id, status: "IDEA", comments: [], assumptions: [], _count: { comments: 0 } });
    const opportunity = { id: "opp-a", workspaceId: WS_A.id, title: "Opp", status: "EXPLORING", description: null, squad: null, linkedKeyResult: null, solutions: [solution("sol-ok", WS_A.id), solution("sol-null", null), solution("sol-drift", WS_B.id)] };
    (fake.current!.client.opportunity as { findUnique: unknown }).findUnique = async () => opportunity;
    const text = (await call("get_opportunity", { opportunityId: "opp-a" })).content[0].text;
    expect(text).toContain("sol-ok");
    expect(text).not.toContain("sol-null");
    expect(text).not.toContain("sol-drift");
  });
});

describe("get_okr_cycle hides nested objectives that are not in the cycle's workspace", () => {
  const kr = (id: string, supporting: Array<Record<string, unknown>> = []) => ({ id, title: id, current: 1, target: 10, unit: null, supportingObjectives: supporting });
  const objective = (id: string, workspaceId: string | null, extra: Record<string, unknown> = {}) => ({
    id, workspaceId, title: id, status: "ON_TRACK", squad: null, parentKeyResult: null, keyResults: [kr(`kr-of-${id}`)], ...extra,
  });
  const supporting = (id: string, workspaceId: string | null) => ({ id, workspaceId, title: id, status: "ON_TRACK", cycle: { id: "c", title: "Cycle" } });

  function stub(objectives: unknown[]) {
    const cycle = { id: "cycle-a", workspaceId: WS_A.id, title: "Q1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-03-31"), objectives };
    (fake.current!.client.oKRCycle as { findUnique: unknown }).findUnique = async () => cycle;
  }

  it("omits a NULL-workspace objective and a drifted one, with their key results, keeping the consistent one", async () => {
    stub([objective("obj-ok", WS_A.id), objective("obj-null", null), objective("obj-drift", WS_B.id)]);
    const result = await call("get_okr_cycle", { cycleId: "cycle-a" });
    const text = result.content[0].text;
    expect(text).toContain("obj-ok");
    expect(text).toContain("kr-of-obj-ok");
    for (const hidden of ["obj-null", "obj-drift", "kr-of-obj-null", "kr-of-obj-drift"]) expect(text).not.toContain(hidden);
    // The structured payload is filtered too, not just the rendered text.
    expect(JSON.stringify((result as unknown as { structuredContent: unknown }).structuredContent)).not.toContain("obj-null");
  });

  it("omits NULL / drifted supporting objectives under a visible key result", async () => {
    stub([objective("obj-ok", WS_A.id, { keyResults: [kr("kr-1", [supporting("sup-ok", WS_A.id), supporting("sup-null", null), supporting("sup-drift", WS_B.id)])] })]);
    const text = (await call("get_okr_cycle", { cycleId: "cycle-a" })).content[0].text;
    expect(text).toContain("sup-ok");
    expect(text).not.toContain("sup-null");
    expect(text).not.toContain("sup-drift");
  });

  it("drops a parent-KR link whose objective is in another workspace or has no workspaceId", async () => {
    const parent = (workspaceId: string | null) => ({ id: "pkr", title: "Parent KR", objective: { workspaceId, title: "Parent objective", cycle: { title: "Annual" } } });
    stub([objective("obj-a", WS_A.id, { parentKeyResult: parent(WS_A.id) }), objective("obj-b", WS_A.id, { parentKeyResult: parent(WS_B.id) }), objective("obj-c", WS_A.id, { parentKeyResult: parent(null) })]);
    const text = (await call("get_okr_cycle", { cycleId: "cycle-a" })).content[0].text;
    expect(text.match(/Supports:/g)).toHaveLength(1);
  });

  it("a cycle in another workspace is still denied by the gate", async () => {
    await expect(call("get_okr_cycle", { cycleId: "cycle-b" })).rejects.toThrow(/not found or access denied/);
  });
});

describe("list counts use the same workspace scope as their lists", () => {
  it("list_okr_cycles counts only objectives with the workspace's own workspaceId", async () => {
    const seen: unknown[] = [];
    (fake.current!.client.oKRCycle as { findMany: unknown }).findMany = async (args: unknown) => { seen.push(args); return [{ id: "cycle-a", title: "Q1", status: "ACTIVE", startDate: new Date(), endDate: new Date(), _count: { objectives: 1 } }]; };
    await call("list_okr_cycles", { workspaceId: WS_A.id });
    expect(JSON.stringify(seen[0])).toContain(`"_count":{"select":{"objectives":{"where":{"workspaceId":"${WS_A.id}"}}}}`);
  });

  it("list_opportunities counts only solutions with the workspace's own workspaceId", async () => {
    const seen: unknown[] = [];
    (fake.current!.client.opportunity as { findMany: unknown }).findMany = async (args: unknown) => { seen.push(args); return [{ id: "opp-a", title: "A", status: "EXPLORING", squad: null, linkedKeyResult: null, _count: { solutions: 1 } }]; };
    await call("list_opportunities", { workspaceId: WS_A.id });
    expect(JSON.stringify(seen[0])).toContain(`"_count":{"select":{"solutions":{"where":{"workspaceId":"${WS_A.id}"}}}}`);
  });
});

describe("assign_squad", () => {
  it("refuses a squad from a different workspace than the object, even for a member of both", async () => {
    // Alice is a member of BOTH workspaces, so she passes the object check and the squad check separately.
    fake.current!.addMember(WS_B.id, USERS.alice);
    await expect(call("assign_squad", { objectType: "opportunity", objectId: "opp-a", squadId: "squad-b" })).rejects.toThrow(/same workspace/);
    await expect(call("assign_squad", { objectType: "opportunity", objectId: "opp-b", squadId: "squad-a" })).rejects.toThrow(/same workspace/);
    expect(state().writes).toEqual([]);
  });

  it("allows a squad from the same workspace as the object", async () => {
    fake.current!.addMember(WS_B.id, USERS.alice);
    await expect(call("assign_squad", { objectType: "opportunity", objectId: "opp-a", squadId: "squad-a" })).resolves.toBeTruthy();
    expect(state().writes).toContain("opportunity.update:opp-a");
  });

  it("still denies a squad the caller is not a member of at all", async () => {
    await expect(call("assign_squad", { objectType: "opportunity", objectId: "opp-a", squadId: "squad-b" })).rejects.toThrow(/not found or access denied/);
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
