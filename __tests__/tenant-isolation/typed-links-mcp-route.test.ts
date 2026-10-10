/**
 * Tenant isolation and behaviour of the typed-link MCP tools and the legacy
 * pointer dual-write, driven through the real `register()` wrapper (gate first,
 * handler second) against the tenant fake Prisma.
 *
 * Pins down what the gate matrix in mcp-tool-gates.test.ts cannot: that the
 * rows the handlers WRITE carry the parent's workspaceId, that a denied call
 * writes nothing at all, and that what the read tools return never includes a
 * link that is wrong for the workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { runWithMcpActor } from "@/lib/mcp-authz";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

type ToolResult = { content: Array<{ text: string }>; structuredContent: { ok: boolean; data: Record<string, unknown> } };
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>;
const registeredTools: Record<string, ToolCallback> = {};
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, _meta, cb) { registeredTools[name] = cb; }, registerResource() {} });
    return () => new Response("ok");
  },
}));
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

await import("@/app/api/mcp/route");

const alice = { userId: USERS.alice, purpose: "USER" as const };
const bob = { userId: USERS.bob, purpose: "USER" as const };
const service = { userId: null, purpose: "SERVICE" as const };
const call = (name: string, args: Record<string, unknown>, actor: { userId: string | null; purpose: "USER" | "SERVICE" } = alice) => {
  const handler = registeredTools[name];
  if (!handler) throw new Error(`Tool "${name}" was not registered`);
  return runWithMcpActor(actor, () => handler(args));
};

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  // A second objective and key results in workspace A, so the legacy pointer can move between objectives.
  fake.current.state.objectives.push({ id: "obj-a2", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 2", status: "ON_TRACK", sortOrder: 1 });
  fake.current.state.keyResults.push({ id: "kr-a2", objectiveId: "obj-a2", title: "A key result 2", target: 1, current: 0, sortOrder: 0 });
});

const state = () => fake.current!.state;
const links = () => state().opportunityObjectiveLinks;
const linkWrites = () => state().writes.filter((w) => /Link\./.test(w));
const seed = (rows: Record<string, unknown>[], table: Record<string, unknown>[]) => rows.forEach((row) => table.push({ id: `seed-${table.length}`, createdAt: new Date(10 + table.length), ...row }));

describe("link_opportunity_to_objective", () => {
  it("creates a DIRECT link stamped with the opportunity's workspace, idempotently", async () => {
    const first = await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    expect(first.structuredContent.data).toMatchObject({ created: true, link: { origin: "DIRECT", source: "MCP", workspaceId: WS_A.id } });
    const again = await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    expect(again.structuredContent.data).toMatchObject({ created: false });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT", createdById: USERS.alice });
  });

  it.each([
    ["a foreign objective", { opportunityId: "opp-a", objectiveId: "obj-b" }, /access denied/],
    ["a foreign opportunity", { opportunityId: "opp-b", objectiveId: "obj-a" }, /access denied/],
    ["an objective with a NULL workspaceId", { opportunityId: "opp-a", objectiveId: "obj-null" }, /access denied/],
  ])("denies %s and writes nothing", async (_label, ids, message) => {
    await expect(call("link_opportunity_to_objective", { workspaceId: WS_A.id, ...ids })).rejects.toThrow(message);
    expect(state().writes).toEqual([]);
    expect(links()).toEqual([]);
  });

  it("a member of BOTH workspaces still cannot join A's opportunity to B's objective", async () => {
    fake.current!.addMember(WS_B.id, USERS.alice);
    await expect(call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b" })).rejects.toThrow(/does not belong to workspace/);
    await expect(call("link_opportunity_to_objective", { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-b" })).rejects.toThrow(/does not belong to workspace/);
    expect(state().writes).toEqual([]);
    expect(links()).toEqual([]);
  });

  it("denies a non-member of the declared workspace", async () => {
    await expect(call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" }, bob)).rejects.toThrow(/access denied/);
    expect(state().writes).toEqual([]);
  });

  it("ignores a forged workspaceId: it cannot move a link into another workspace", async () => {
    // Bob forges workspace B on A's entities. The gate refuses it, and nothing is written.
    await expect(call("link_opportunity_to_objective", { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a" }, bob)).rejects.toThrow();
    expect(state().writes).toEqual([]);
  });

  it("even the service key (which skips the gate) cannot cross-link: the stored workspace and both endpoints are re-verified", async () => {
    const result = await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b" }, service);
    expect(result.structuredContent.ok).toBe(false);
    expect(result.content[0].text).toMatch(/Objective not found in this workspace/);
    // A forged workspaceId from the service key still stamps the PARENT's workspace, and only if the objective is that workspace's.
    const forged = await call("link_opportunity_to_objective", { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a" }, service);
    expect(forged.structuredContent.ok).toBe(false);
    expect(links()).toEqual([]);
    expect(linkWrites()).toEqual([]);
  });
});

describe("unlink_opportunity_from_objective", () => {
  it("removes the link, then reports removed:0", async () => {
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    expect((await call("unlink_opportunity_from_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" })).structuredContent.data).toMatchObject({ removed: 1 });
    expect((await call("unlink_opportunity_from_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" })).structuredContent.data).toMatchObject({ removed: 0 });
    expect(links()).toEqual([]);
  });

  it("leaves workspace B's link for the same ids untouched", async () => {
    seed([{ workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" }], links());
    expect((await call("unlink_opportunity_from_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" })).structuredContent.data).toMatchObject({ removed: 0 });
    expect(links()).toHaveLength(1);
  });

  it("denies a foreign opportunity", async () => {
    await expect(call("unlink_opportunity_from_objective", { workspaceId: WS_A.id, opportunityId: "opp-b", objectiveId: "obj-b" })).rejects.toThrow(/access denied/);
  });
});

describe("link_solution_to_key_result / unlink_solution_from_key_result", () => {
  it("links with the solution's workspace, idempotently, and unlinks", async () => {
    const first = await call("link_solution_to_key_result", { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    const again = await call("link_solution_to_key_result", { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    expect([first.structuredContent.data.created, again.structuredContent.data.created]).toEqual([true, false]);
    expect(state().solutionKeyResultLinks).toEqual([expect.objectContaining({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a", source: "MCP" })]);
    expect((await call("unlink_solution_from_key_result", { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })).structuredContent.data).toMatchObject({ removed: 1 });
    expect((await call("unlink_solution_from_key_result", { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })).structuredContent.data).toMatchObject({ removed: 0 });
  });

  it.each([
    ["a foreign key result", { solutionId: "sol-a", keyResultId: "kr-b" }],
    ["a key result under an unbackfilled objective", { solutionId: "sol-a", keyResultId: "kr-null" }],
    ["a foreign solution", { solutionId: "sol-b", keyResultId: "kr-a" }],
    ["a solution whose workspaceId is NULL", { solutionId: "sol-null", keyResultId: "kr-a" }],
  ])("denies %s and writes nothing", async (_label, ids) => {
    await expect(call("link_solution_to_key_result", { workspaceId: WS_A.id, ...ids })).rejects.toThrow(/does not belong to workspace|access denied|not found/);
    expect(state().solutionKeyResultLinks).toEqual([]);
    expect(state().writes).toEqual([]);
  });

  it("does not change the solution's parent opportunity", async () => {
    await call("link_solution_to_key_result", { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    expect(state().solutions.find((s) => s.id === "sol-a")).toMatchObject({ opportunityId: "opp-a" });
  });
});

describe("list_links", () => {
  it("lists an opportunity's links with titles and origin, paged by cursor, and never a link with the wrong workspaceId", async () => {
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2" });
    // Stamped B although both endpoints are A's: not A's link, never returned to A.
    seed([{ workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT", source: "UI" }], links());

    const page1 = await call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 1 });
    expect(page1.structuredContent.data).toMatchObject({ count: 1, items: [{ objectiveId: "obj-a", objectiveTitle: "A objective", origin: "DIRECT" }] });
    const cursor = page1.structuredContent.data.nextCursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 1, cursor });
    expect(page2.structuredContent.data).toMatchObject({ count: 1, items: [{ objectiveId: "obj-a2" }], nextCursor: null });
    expect(JSON.stringify([page1, page2])).not.toContain("B objective");
  });

  it("denies a non-member and an entity outside the declared workspace", async () => {
    await expect(call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a" }, bob)).rejects.toThrow(/access denied/);
    await expect(call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-b" })).rejects.toThrow(/access denied/);
    await expect(call("list_links", { workspaceId: WS_A.id, keyResultId: "kr-b" })).rejects.toThrow(/access denied/);
  });

  it("returns a failed result for a bad cursor rather than throwing", async () => {
    const result = await call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a", cursor: "not-a-cursor" });
    expect(result.structuredContent.ok).toBe(false);
  });
});

describe("link_opportunity_to_kr dual-writes the legacy column and a LEGACY link", () => {
  it("set, change to another objective's key result, then clear: the LEGACY link follows and a DIRECT link survives", async () => {
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    await call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: "kr-a2" });
    expect(state().opportunities.find((o) => o.id === "opp-a")!.linkedKeyResultId).toBe("kr-a2");
    expect(links().map((l) => [l.objectiveId, l.origin]).sort()).toEqual([["obj-a", "DIRECT"], ["obj-a2", "LEGACY"]]);

    await call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: null });
    expect(state().opportunities.find((o) => o.id === "opp-a")!.linkedKeyResultId).toBeNull();
    expect(links().map((l) => [l.objectiveId, l.origin])).toEqual([["obj-a", "DIRECT"]]);
  });

  it("legacy tool then new tool: adding the DIRECT link over the LEGACY pair flips origin, so a later clear keeps it", async () => {
    await call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: "kr-a" });
    expect(links().map((l) => l.origin)).toEqual(["LEGACY"]);
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    expect(links().map((l) => l.origin)).toEqual(["DIRECT"]);
    await call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: null });
    expect(links().map((l) => [l.objectiveId, l.origin])).toEqual([["obj-a", "DIRECT"]]);
  });

  it("rejects a key result from another workspace even for a member of both, writing nothing", async () => {
    fake.current!.addMember(WS_B.id, USERS.alice);
    await expect(call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: "kr-b" })).rejects.toThrow(/same workspace/);
    expect(state().writes).toEqual([]);
    expect(state().opportunities.find((o) => o.id === "opp-a")!.linkedKeyResultId).toBeNull();
  });

  it("returns linkedKeyResultId only from the column, never inferred from a link", async () => {
    await call("link_opportunity_to_objective", { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" });
    const result = await call("link_opportunity_to_kr", { opportunityId: "opp-a", keyResultId: null });
    expect(result.structuredContent.data).toMatchObject({ linkedKeyResultId: null });
  });
});

describe("create_opportunity with a keyResultId writes both", () => {
  it("creates the opportunity with the column and the LEGACY link in the key result's workspace", async () => {
    const result = await call("create_opportunity", { workspaceId: WS_A.id, title: "New idea", keyResultId: "kr-a2" });
    const created = state().opportunities.find((o) => o.title === "New idea")!;
    expect(created).toMatchObject({ workspaceId: WS_A.id, linkedKeyResultId: "kr-a2" });
    expect(result.structuredContent.data).toMatchObject({ linkedKeyResultId: "kr-a2" });
    expect(links()).toEqual([expect.objectContaining({ workspaceId: WS_A.id, opportunityId: created.id, objectiveId: "obj-a2", origin: "LEGACY" })]);
  });

  it("denies a key result from another workspace without creating anything", async () => {
    await expect(call("create_opportunity", { workspaceId: WS_A.id, title: "Smuggled", keyResultId: "kr-b" })).rejects.toThrow(/access denied/);
    expect(state().opportunities.some((o) => o.title === "Smuggled")).toBe(false);
    expect(state().writes).toEqual([]);
  });

  it("without a keyResultId writes no link", async () => {
    await call("create_opportunity", { workspaceId: WS_A.id, title: "Plain" });
    expect(links()).toEqual([]);
  });
});

describe("reads: linkedObjectives are additive and never inferred into linkedKeyResult", () => {
  const stubOpportunity = (workspaceId = WS_A.id) => {
    const opportunity = { id: "opp-a", workspaceId, title: "Opp", status: "EXPLORING", description: null, squad: null, linkedKeyResult: null, solutions: [] };
    (fake.current!.client.opportunity as { findUnique: unknown }).findUnique = async () => opportunity;
  };

  it("get_opportunity returns linkedObjectives in created order, and links to hidden objectives are omitted", async () => {
    stubOpportunity();
    seed([
      { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "DIRECT", createdAt: new Date(1) },
      { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY", createdAt: new Date(2) },
      { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT", createdAt: new Date(3) },
      { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-null", origin: "DIRECT", createdAt: new Date(4) },
      { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT", createdAt: new Date(0) },
    ], links());
    const result = await call("get_opportunity", { opportunityId: "opp-a" });
    expect(result.structuredContent.data.linkedObjectives).toEqual([
      { id: "obj-a2", title: "A objective 2" },
      { id: "obj-a", title: "A objective" },
    ]);
    expect(result.structuredContent.data.linkedKeyResult).toBeNull();
    expect(result.content[0].text).toContain("Linked objectives: A objective 2");
    expect(result.content[0].text).not.toContain("Linked KR");
  });

  it("list_opportunities adds linkedObjectives per item from one batch, and linkedKeyResult stays legacy-only", async () => {
    seed([{ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" }], links());
    // list_opportunities includes relations the fake does not model; give it the shape it reads.
    (fake.current!.client.opportunity as { findMany: unknown }).findMany = async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      if (include) {
        return state().opportunities.filter((o) => o.workspaceId === where.workspaceId).map((o) => ({ ...o, description: null, squad: null, linkedKeyResult: null, _count: { solutions: 0 } }));
      }
      return state().opportunities.filter((o) => (where.id as { in: string[] }).in.includes(o.id) && o.workspaceId === where.workspaceId);
    };
    const result = await call("list_opportunities", { workspaceId: WS_A.id });
    expect(result.structuredContent.data.items).toEqual([expect.objectContaining({ id: "opp-a", linkedKeyResult: null, linkedObjectives: [{ id: "obj-a", title: "A objective" }] })]);
  });

  it("list_solutions adds linkedKeyResults", async () => {
    seed([{ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" }], state().solutionKeyResultLinks);
    (fake.current!.client.solution as { findMany: unknown }).findMany = async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      if (include) {
        return state().solutions.filter((s) => s.workspaceId === where.workspaceId).map((s) => ({ ...s, opportunity: { id: "opp-a", title: "A opportunity", status: "EXPLORING", squadId: null }, roadmapItems: [] }));
      }
      return state().solutions.filter((s) => (where.id as { in: string[] }).in.includes(s.id as string) && s.workspaceId === where.workspaceId);
    };
    const result = await call("list_solutions", { workspaceId: WS_A.id });
    expect(result.structuredContent.data.items).toEqual([expect.objectContaining({ id: "sol-a", linkedKeyResults: [{ id: "kr-a", title: "A key result", objectiveId: "obj-a" }] })]);
  });
});
