/**
 * Tenant-isolation matrix for Solution and Objective (ADR: "Thinking-model
 * presets and typed links", Phase 0).
 *
 * Solution and Objective now carry their own `workspaceId`, and every
 * authorization / scoping path reads that column instead of walking
 * `solution.opportunity.workspaceId` or `objective.cycle.workspaceId`.
 *
 * The fake Prisma (helpers/tenant-fake-prisma) honours `where` clauses for real,
 * so a path that forgets to scope shows up as a foreign row being read or
 * written, not as a mock that returns whatever the test told it to.
 *
 * Fixtures, per workspace: a Solution, an Objective, a Key Result (scoped via its
 * Objective), an Assumption and a SolutionComment. Plus three "-null" rows that
 * model data created before the backfill: workspaceId is NULL while the parent
 * chain still points at workspace A. Every path must DENY those, even for a
 * member of A — reading the parent chain would have allowed them.
 *
 * Entry points covered: MCP authz + tool gates, server actions, comments,
 * workspace search, discovery listing, scoring, artifacts, tasks, entity detail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma>, extra: {} as Record<string, unknown> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/db", () => ({
  default: () => ({ ...fake.current!.client, ...fake.extra }),
}));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: "T", email: "t@example.com" } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
// Workspace Updates capture is an unrelated feature flag; keep the mutation path simple.
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { McpAuthzError, assertEntityAccess, runWithMcpActor, type McpActor } from "@/lib/mcp-authz";
import { applyToolGate } from "@/lib/mcp-tool-gates";
import { resolveCommentTarget, createComment } from "@/lib/comments";
import { mirrorLegacySolutionComment } from "@/lib/comment-compat";
import { searchWorkspace } from "@/lib/workspace-search";
import { listSolutions } from "@/lib/discovery-query-tool-handlers";
import { scoreSolution } from "@/lib/scoring-tool-handlers";
import { linkArtifactToSolution } from "@/lib/artifacts";
import { validateTaskLink, taskLinkScope } from "@/lib/task-assignment";
import { entityScopeWhere, getEntityDetail } from "@/lib/entity-detail";
import { requireProductEntity } from "@/lib/product-action-auth";
import * as discoveryActions from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import * as okrActions from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

const alice: McpActor = { userId: USERS.alice, purpose: "USER" };
const service: McpActor = { userId: null, purpose: "SERVICE" };

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  fake.extra = {};
  session.userId = USERS.alice;
  vi.clearAllMocks();
});

const writes = () => fake.current!.state.writes;

/** [entity type, own id (workspace A), foreign id (workspace B), unbackfilled id (NULL workspaceId)] */
const ENTITIES = [
  ["solution", "sol-a", "sol-b", "sol-null"],
  ["objective", "obj-a", "obj-b", "obj-null"],
  ["keyResult", "kr-a", "kr-b", "kr-null"],
  ["assumption", "asm-a", "asm-b", "asm-null"],
  ["solutionComment", "scm-a", "scm-b", "scm-null"],
] as const;

describe("MCP authorization: assertEntityAccess reads the row's own workspaceId", () => {
  it.each(ENTITIES)("%s: a member of A resolves their own row to workspace A", async (type, own) => {
    await expect(assertEntityAccess(alice, type, own)).resolves.toEqual({ workspaceId: WS_A.id });
  });

  it.each(ENTITIES)("%s: a member of A cannot reach workspace B's row", async (type, _own, foreign) => {
    await expect(assertEntityAccess(alice, type, foreign)).rejects.toThrow(McpAuthzError);
    await expect(assertEntityAccess(alice, type, foreign)).rejects.toThrow(/not found or access denied/);
  });

  it.each(ENTITIES)("%s: a NULL workspaceId is denied for a user, even though the parent chain says workspace A", async (type, _own, _foreign, unbackfilled) => {
    await expect(assertEntityAccess(alice, type, unbackfilled)).rejects.toThrow(/not found or access denied/);
  });

  it.each(ENTITIES)("%s: a NULL workspaceId is denied even for the trusted service actor (fails closed, never skipped)", async (type, _own, _foreign, unbackfilled) => {
    await expect(assertEntityAccess(service, type, unbackfilled)).rejects.toThrow(/not found or access denied/);
  });
});

describe("MCP tool gates (registered wrapper policy) for Solution and Objective tools", () => {
  const gated = (tool: string, args: Record<string, unknown>) => runWithMcpActor(alice, () => applyToolGate(tool, alice, args));

  const solutionTools = ["update_solution", "update_solution_status", "add_assumption", "add_solution_plan", "add_solution_comment", "list_solution_comments", "score_solution", "get_solution_score"];
  const objectiveTools = ["update_objective", "delete_objective", "add_key_result"];

  it.each([...solutionTools])("%s allows A's solution and denies B's and an unbackfilled one", async (tool) => {
    await expect(gated(tool, { solutionId: "sol-a" })).resolves.toBeUndefined();
    await expect(gated(tool, { solutionId: "sol-b" })).rejects.toThrow(McpAuthzError);
    await expect(gated(tool, { solutionId: "sol-null" })).rejects.toThrow(McpAuthzError);
  });

  it.each([...objectiveTools])("%s allows A's objective and denies B's and an unbackfilled one", async (tool) => {
    await expect(gated(tool, { objectiveId: "obj-a" })).resolves.toBeUndefined();
    await expect(gated(tool, { objectiveId: "obj-b" })).rejects.toThrow(McpAuthzError);
    await expect(gated(tool, { objectiveId: "obj-null" })).rejects.toThrow(McpAuthzError);
  });

  it("set_objective_parent_kr denies B's and an unbackfilled objective", async () => {
    await expect(gated("set_objective_parent_kr", { objectiveId: "obj-b", keyResultId: null })).rejects.toThrow(McpAuthzError);
    await expect(gated("set_objective_parent_kr", { objectiveId: "obj-null", keyResultId: null })).rejects.toThrow(McpAuthzError);
  });

  it("create_objective and add_solution cannot be aimed at another workspace's parent", async () => {
    await expect(gated("create_objective", { workspaceId: WS_B.id, cycleId: "cycle-b" })).rejects.toThrow(McpAuthzError);
    await expect(gated("add_solution", { opportunityId: "opp-b" })).rejects.toThrow(McpAuthzError);
    await expect(gated("add_solution", { opportunityId: "opp-a" })).resolves.toBeUndefined();
  });

  it("promote_to_roadmap rejects a declared workspace that does not own the solution, and an unbackfilled solution", async () => {
    await expect(gated("promote_to_roadmap", { solutionId: "sol-a", workspaceId: WS_B.id })).rejects.toThrow(McpAuthzError);
    await expect(gated("promote_to_roadmap", { solutionId: "sol-null", workspaceId: WS_A.id })).rejects.toThrow(McpAuthzError);
    await expect(gated("promote_to_roadmap", { solutionId: "sol-a", workspaceId: WS_A.id })).resolves.toBeUndefined();
  });
});

describe("server actions: product-action-auth", () => {
  it("requireProductEntity resolves A's rows and returns the row's own workspaceId", async () => {
    await expect(requireProductEntity("solution", "sol-a")).resolves.toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a" });
    await expect(requireProductEntity("objective", "obj-a")).resolves.toMatchObject({ workspaceId: WS_A.id });
    await expect(requireProductEntity("keyResult", "kr-a")).resolves.toMatchObject({ workspaceId: WS_A.id });
    await expect(requireProductEntity("okrCycle", "cycle-a")).resolves.toMatchObject({ workspaceId: WS_A.id });
  });

  it.each([
    ["solution", "sol-b"],
    ["objective", "obj-b"],
    ["keyResult", "kr-b"],
    ["okrCycle", "cycle-b"],
  ] as const)("a member of A is denied %s %s in workspace B", async (kind, id) => {
    await expect(requireProductEntity(kind, id)).rejects.toThrow("Entity not found or access denied");
  });

  it.each([
    ["solution", "sol-null"],
    ["objective", "obj-null"],
    ["keyResult", "kr-null"],
  ] as const)("a NULL workspaceId is denied for %s %s although its parent chain belongs to A", async (kind, id) => {
    await expect(requireProductEntity(kind, id)).rejects.toThrow("Entity not found or access denied");
  });

  it("an expected workspace that disagrees with the row's workspace is rejected", async () => {
    await expect(requireProductEntity("solution", "sol-a", WS_B.id)).rejects.toThrow("Entity not found or access denied");
    await expect(requireProductEntity("objective", "obj-a", WS_B.id)).rejects.toThrow("Entity not found or access denied");
  });

  it("an unauthenticated caller is rejected before any lookup", async () => {
    session.userId = null;
    await expect(requireProductEntity("solution", "sol-a")).rejects.toThrow("Unauthorized");
  });
});

describe("server actions: discovery", () => {
  it("addSolution under B's opportunity is denied and writes nothing", async () => {
    await expect(discoveryActions.addSolution("opp-b", { title: "Sneaky" }, "/p")).rejects.toThrow("Entity not found or access denied");
    expect(writes()).toEqual([]);
  });

  it("addSolution under A's opportunity stamps the opportunity's workspaceId, never client input", async () => {
    await discoveryActions.addSolution("opp-a", { title: "Legit" }, "/p");
    const created = fake.current!.state.solutions.find((s) => s.title === "Legit");
    expect(created).toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a" });
  });

  it.each(["sol-b", "sol-null"])("updateSolutionStatus on %s is denied and writes nothing", async (id) => {
    await expect(discoveryActions.updateSolutionStatus(id, "VALIDATED", "/p")).rejects.toThrow("Entity not found or access denied");
    expect(writes()).toEqual([]);
  });

  it("updateSolutionStatus on A's solution succeeds", async () => {
    await discoveryActions.updateSolutionStatus("sol-a", "VALIDATED", "/p");
    expect(fake.current!.state.solutions.find((s) => s.id === "sol-a")!.status).toBe("VALIDATED");
  });
});

describe("server actions: OKRs", () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };

  it("createObjective under B's cycle is rejected as a mismatched parent and writes nothing", async () => {
    await expect(okrActions.createObjective("cycle-b", WS_A.org, WS_A.slug, form({ title: "Sneaky" }))).rejects.toThrow("Entity not found or access denied");
    expect(writes()).toEqual([]);
  });

  it("createObjective under A's cycle stamps the cycle's workspaceId, never client input", async () => {
    await okrActions.createObjective("cycle-a", WS_A.org, WS_A.slug, form({ title: "Legit objective" }));
    const created = fake.current!.state.objectives.find((o) => o.title === "Legit objective");
    expect(created).toMatchObject({ workspaceId: WS_A.id, cycleId: "cycle-a" });
  });

  it("createCycle for a workspace the caller is not a member of is rejected", async () => {
    await expect(okrActions.createCycle(WS_B.id, WS_B.org, WS_B.slug, form({ title: "Q", startDate: "2026-01-01", endDate: "2026-03-31" }))).rejects.toThrow("Workspace not found or access denied");
    expect(writes()).toEqual([]);
  });

  const mutations: Array<[string, () => Promise<unknown>]> = [
    ["updateObjectiveStatus(B)", () => okrActions.updateObjectiveStatus("obj-b", "AT_RISK", WS_A.org, WS_A.slug)],
    ["updateObjectiveStatus(NULL)", () => okrActions.updateObjectiveStatus("obj-null", "AT_RISK", WS_A.org, WS_A.slug)],
    ["deleteObjective(B)", () => okrActions.deleteObjective("obj-b", "/p")],
    ["deleteObjective(NULL)", () => okrActions.deleteObjective("obj-null", "/p")],
    ["reorderObjective(B)", () => okrActions.reorderObjective("obj-b", 5, "/p")],
    ["reorderObjective(NULL)", () => okrActions.reorderObjective("obj-null", 5, "/p")],
    ["addKeyResult(B)", () => okrActions.addKeyResult("obj-b", WS_A.org, WS_A.slug, form({ title: "KR", target: "5" }))],
    ["addKeyResult(NULL)", () => okrActions.addKeyResult("obj-null", WS_A.org, WS_A.slug, form({ title: "KR", target: "5" }))],
    ["deleteKeyResult(B)", () => okrActions.deleteKeyResult("kr-b", "/p")],
    ["deleteKeyResult(NULL)", () => okrActions.deleteKeyResult("kr-null", "/p")],
    ["reorderKeyResult(B)", () => okrActions.reorderKeyResult("kr-b", 5, "/p")],
    ["logCheckIn(B)", () => okrActions.logCheckIn("kr-b", WS_A.org, WS_A.slug, form({ value: "3" }))],
    ["logCheckIn(NULL)", () => okrActions.logCheckIn("kr-null", WS_A.org, WS_A.slug, form({ value: "3" }))],
  ];
  it.each(mutations)("%s is denied and writes nothing", async (_name, run) => {
    await expect(run()).rejects.toThrow("Entity not found or access denied");
    expect(writes()).toEqual([]);
  });

  it("A's own objective can still be updated, reordered and deleted", async () => {
    await okrActions.updateObjectiveStatus("obj-a", "AT_RISK", WS_A.org, WS_A.slug);
    await okrActions.reorderObjective("obj-a", 7, "/p");
    expect(fake.current!.state.objectives.find((o) => o.id === "obj-a")).toMatchObject({ status: "AT_RISK", sortOrder: 7 });
    await okrActions.deleteObjective("obj-a", "/p");
    expect(fake.current!.state.objectives.some((o) => o.id === "obj-a")).toBe(false);
  });
});

describe("comments", () => {
  const targets = [
    ["SOLUTION", "sol-a", "sol-b", "sol-null"],
    ["OBJECTIVE", "obj-a", "obj-b", "obj-null"],
    ["KEY_RESULT", "kr-a", "kr-b", "kr-null"],
    ["ASSUMPTION", "asm-a", "asm-b", "asm-null"],
  ] as const;

  it.each(targets)("%s target resolves to the row's own workspace", async (type, own, foreign) => {
    await expect(resolveCommentTarget(type, own)).resolves.toEqual({ workspaceId: WS_A.id });
    await expect(resolveCommentTarget(type, foreign)).resolves.toEqual({ workspaceId: WS_B.id });
  });

  it.each(targets)("%s: a NULL workspaceId is not commentable", async (type, _own, _foreign, unbackfilled) => {
    await expect(resolveCommentTarget(type, unbackfilled)).resolves.toBeNull();
    await expect(createComment({ workspaceId: WS_A.id, targetType: type, targetId: unbackfilled, body: "hi", authorName: "Alice" })).rejects.toThrow(/not found or not commentable/);
  });

  it.each(targets)("%s: commenting on B's row while declaring workspace A is rejected", async (type, _own, foreign) => {
    await expect(createComment({ workspaceId: WS_A.id, targetType: type, targetId: foreign, body: "hi", authorName: "Alice" })).rejects.toThrow(/does not belong to the declared workspace/);
  });

  it("a legacy solution comment cannot be mirrored into an unscoped thread", async () => {
    await expect(mirrorLegacySolutionComment({ id: "c", solutionId: "sol-null", body: "x", authorName: "a", authorType: "HUMAN", source: "UI", commentType: "COMMENT", planStatus: "PENDING", createdAt: new Date(), updatedAt: new Date() } as never)).rejects.toThrow("Solution not found while mirroring comment.");
  });
});

describe("workspace search", () => {
  const emptyModels = Object.fromEntries(["experiment", "roadmapItem", "task", "feedbackItem", "doc"].map((m) => [m, { findMany: async () => [] }]));

  it("returns only the requested workspace's solutions and never an unbackfilled one", async () => {
    fake.extra = emptyModels;
    const a = await searchWorkspace({ workspaceId: WS_A.id, orgSlug: WS_A.org, workspaceSlug: WS_A.slug, query: "solution" });
    const b = await searchWorkspace({ workspaceId: WS_B.id, orgSlug: WS_B.org, workspaceSlug: WS_B.slug, query: "solution" });
    const ids = (r: Awaited<ReturnType<typeof searchWorkspace>>) => JSON.stringify(r);
    expect(ids(a)).toContain("sol-a");
    expect(ids(a)).not.toContain("sol-b");
    expect(ids(a)).not.toContain("sol-null");
    expect(ids(b)).toContain("sol-b");
    expect(ids(b)).not.toContain("sol-a");
  });
});

describe("discovery listing (MCP list_solutions)", () => {
  it("lists only the requested workspace's solutions", async () => {
    const result = await listSolutions({ workspaceId: WS_A.id });
    const text = JSON.stringify(result);
    expect(text).toContain("sol-a");
    expect(text).not.toContain("sol-b");
    expect(text).not.toContain("sol-null");
  });
});

describe("scoring", () => {
  it("scoreSolution treats an unbackfilled solution as not found", async () => {
    fake.extra = { workspaceScoringConfig: { findUnique: async () => null } };
    const result = await scoreSolution({ solutionId: "sol-null", rawValues: {} });
    expect(result.content[0].text).toContain('Solution "sol-null" not found.');
  });

  it("scoreSolution resolves the workspace from the solution's own column", async () => {
    const lookups: string[] = [];
    fake.extra = { workspaceScoringConfig: { findUnique: async ({ where }: { where: { workspaceId: string } }) => { lookups.push(where.workspaceId); return null; } } };
    await scoreSolution({ solutionId: "sol-a", rawValues: {} });
    await scoreSolution({ solutionId: "sol-b", rawValues: {} });
    expect(lookups).toEqual([WS_A.id, WS_B.id]);
  });
});

describe("artifacts", () => {
  const artifacts = () => ({
    artifact: { findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) => (where.id === "art-a" && where.workspaceId === WS_A.id ? { id: "art-a", workspaceId: WS_A.id } : null) },
    artifactLink: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "link-1", ...data }) },
  });

  it.each(["sol-b", "sol-null"])("linking A's artifact to %s is rejected", async (solutionId) => {
    fake.extra = artifacts();
    await expect(linkArtifactToSolution({ artifactId: "art-a", solutionId, workspaceId: WS_A.id })).rejects.toThrow("Artifact and Solution must exist in the same workspace");
  });

  it("linking within workspace A works", async () => {
    fake.extra = artifacts();
    await expect(linkArtifactToSolution({ artifactId: "art-a", solutionId: "sol-a", workspaceId: WS_A.id })).resolves.toMatchObject({ created: true, linkedId: "sol-a" });
  });
});

describe("tasks", () => {
  it.each([
    ["SOLUTION", "sol-a", "sol-b", "sol-null"],
    ["OBJECTIVE", "obj-a", "obj-b", "obj-null"],
    ["KEY_RESULT", "kr-a", "kr-b", "kr-null"],
  ] as const)("%s links resolve in workspace A only", async (type, own, foreign, unbackfilled) => {
    await expect(validateTaskLink(WS_A.id, type, own)).resolves.toBeTruthy();
    await expect(validateTaskLink(WS_A.id, type, foreign)).rejects.toThrow("different workspace or does not exist");
    await expect(validateTaskLink(WS_A.id, type, unbackfilled)).rejects.toThrow("different workspace or does not exist");
  });

  it("taskLinkScope filters solution, objective and key result links by the direct column", () => {
    expect(taskLinkScope(WS_A.id, "SOLUTION")).toEqual({ workspaceId: WS_A.id });
    expect(taskLinkScope(WS_A.id, "OBJECTIVE")).toEqual({ workspaceId: WS_A.id });
    expect(taskLinkScope(WS_A.id, "KEY_RESULT")).toEqual({ objective: { workspaceId: WS_A.id } });
  });
});

describe("entity detail", () => {
  const scoped = async (type: "solution" | "objective" | "keyResult" | "assumption", id: string, workspaceId: string) => {
    const model = { solution: "solution", objective: "objective", keyResult: "keyResult", assumption: "assumption" }[type] as "solution";
    return fake.current!.client[model].findFirst({ where: entityScopeWhere(type, id, workspaceId) } as never);
  };

  it.each([
    ["solution", "sol-a", "sol-b", "sol-null"],
    ["objective", "obj-a", "obj-b", "obj-null"],
    ["keyResult", "kr-a", "kr-b", "kr-null"],
    ["assumption", "asm-a", "asm-b", "asm-null"],
  ] as const)("%s: the shared scope filter admits A's row and excludes B's and an unbackfilled one", async (type, own, foreign, unbackfilled) => {
    expect(await scoped(type, own, WS_A.id)).not.toBeNull();
    expect(await scoped(type, foreign, WS_A.id)).toBeNull();
    expect(await scoped(type, unbackfilled, WS_A.id)).toBeNull();
  });

  it.each([
    ["solution", "sol-b"],
    ["solution", "sol-null"],
    ["objective", "obj-b"],
    ["objective", "obj-null"],
    ["keyResult", "kr-b"],
    ["keyResult", "kr-null"],
    ["assumption", "asm-b"],
    ["assumption", "asm-null"],
  ] as const)("getEntityDetail(%s, %s) in workspace A returns nothing", async (type, id) => {
    await expect(getEntityDetail(type, id, WS_A.id)).resolves.toBeNull();
  });
});
