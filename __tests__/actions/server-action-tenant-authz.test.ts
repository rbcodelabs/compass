/**
 * Cross-tenant matrix for server actions that used to act on a client-supplied
 * record id with no (or only a session) check, or that checked the caller against
 * their own workspace/organization and then wrote by id with no tenant filter.
 *
 * The caller (ALICE) belongs to workspace A / organization A only. Every record
 * of workspace B / organization B must be unreachable: the action is refused and
 * nothing is written. The fake honours `where` clauses (including relation
 * filters), so a missing tenant filter shows up as a foreign row being changed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const W_A = "ws-a";
const W_B = "ws-b";
const ORG_A = "org-a";
const ORG_B = "org-b";
const ALICE = "user-alice"; // member of A only; OWNER of org A

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof makeDb> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

function makeDb() {
  const tables: Record<string, Row[]> = {
    organization: [{ id: ORG_A, slug: "acme" }, { id: ORG_B, slug: "globex" }],
    organizationMember: [
      { id: "om-a", organizationId: ORG_A, userId: ALICE, role: "OWNER" },
      { id: "om-b", organizationId: ORG_B, userId: "user-bob", role: "OWNER" },
    ],
    workspace: [
      { id: W_A, slug: "alpha", organizationId: ORG_A, members: [ALICE] },
      { id: W_B, slug: "beta", organizationId: ORG_B, members: ["user-bob"] },
    ],
    opportunity: [{ id: "opp-a", workspaceId: W_A }, { id: "opp-b", workspaceId: W_B }],
    solution: [
      { id: "sol-a", workspaceId: W_A, opportunityId: "opp-a" },
      { id: "sol-b", workspaceId: W_B, opportunityId: "opp-b" },
    ],
    assumption: [
      { id: "asm-a", solutionId: "sol-a", workspaceId: W_A, status: "UNTESTED", sortOrder: 0 },
      { id: "asm-b", solutionId: "sol-b", workspaceId: W_B, status: "UNTESTED", sortOrder: 0 },
    ],
    evidence: [
      { id: "ev-a", workspaceId: W_A, opportunityId: null, solutionId: null, assumptionId: null },
      { id: "ev-b", workspaceId: W_B, opportunityId: null, solutionId: null, assumptionId: null },
    ],
    solutionComment: [
      { id: "cm-a", solutionId: "sol-a", commentType: "PLAN", body: "a", planStatus: "PENDING" },
      { id: "cm-b", solutionId: "sol-b", commentType: "PLAN", body: "b", planStatus: "PENDING" },
    ],
    customFieldDefinition: [
      { id: "fd-a", workspaceId: W_A, objectType: "OPPORTUNITY", name: "A field", required: false, sharedOptionSetId: null },
      { id: "fd-b", workspaceId: W_B, objectType: "OPPORTUNITY", name: "B field", required: false, sharedOptionSetId: null },
    ],
    customFieldValue: [{ id: "fv-b", fieldId: "fd-b", objectId: "opp-b", value: "keep" }],
    scoringModel: [
      { id: "sm-a", organizationId: ORG_A, name: "A model", description: "", status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1 },
      { id: "sm-b", organizationId: ORG_B, name: "B model", description: "", status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1 },
    ],
    scoringModelMetric: [
      { id: "mt-a", scoringModelId: "sm-a", key: "reach" },
      { id: "mt-b", scoringModelId: "sm-b", key: "reach" },
    ],
  };
  const relations: Record<string, Record<string, [string, string]>> = {
    workspace: { organization: ["organization", "organizationId"] },
    organizationMember: { organization: ["organization", "organizationId"] },
    opportunity: { workspace: ["workspace", "workspaceId"] },
    solution: { workspace: ["workspace", "workspaceId"] },
    assumption: { solution: ["solution", "solutionId"] },
    solutionComment: { solution: ["solution", "solutionId"] },
    customFieldDefinition: { workspace: ["workspace", "workspaceId"] },
  };
  const writes: string[] = [];
  const matches = (model: string, row: Row, where: Row = {}): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (model === "workspace" && key === "members") {
        if (!(row.members as string[]).includes((cond as { some: { userId: string } }).some.userId)) return false;
        continue;
      }
      const rel = relations[model]?.[key];
      if (rel) {
        const parent = tables[rel[0]].find((r) => r.id === row[rel[1]]);
        if (!parent || !matches(rel[0], parent, cond as Row)) return false;
        continue;
      }
      if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
        const op = cond as { in?: unknown[] };
        if (op.in) { if (!op.in.includes(row[key])) return false; continue; }
        // Compound unique selector such as { fieldId_objectId: { fieldId, objectId } }.
        if (key.includes("_")) { if (!matches(model, row, cond as Row)) return false; continue; }
      }
      if (!(key in row)) throw new Error(`fake: unsupported where key ${model}.${key}`);
      if (row[key] !== cond) return false;
    }
    return true;
  };
  const delegate = (model: string) => ({
    findFirst: async ({ where }: { where: Row }) => { const r = tables[model].find((x) => matches(model, x, where)); return r ? { ...r } : null; },
    findUnique: async ({ where }: { where: Row }) => { const r = tables[model].find((x) => matches(model, x, where)); return r ? { ...r } : null; },
    findMany: async ({ where }: { where: Row }) => tables[model].filter((r) => matches(model, r, where)).map((r) => ({ ...r })),
    count: async ({ where }: { where: Row }) => tables[model].filter((r) => matches(model, r, where)).length,
    create: async ({ data }: { data: Row }) => { const row = { id: `${model}-new`, ...data }; tables[model].push(row); writes.push(`${model}.create`); return row; },
    createMany: async ({ data }: { data: Row[] }) => { data.forEach((d, i) => tables[model].push({ id: `${model}-new-${i}`, ...d })); writes.push(`${model}.createMany`); return { count: data.length }; },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[model].find((r) => matches(model, r, where));
      if (!row) throw new Error("Record to update not found");
      Object.assign(row, data); writes.push(`${model}.update:${row.id}`); return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = tables[model].filter((r) => matches(model, r, where));
      rows.forEach((r) => { Object.assign(r, data); writes.push(`${model}.updateMany:${r.id}`); });
      return { count: rows.length };
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = tables[model].find((r) => matches(model, r, where));
      if (row) { Object.assign(row, update); writes.push(`${model}.upsert:${row.id}`); return { ...row }; }
      const made = { id: `${model}-new`, ...create }; tables[model].push(made); writes.push(`${model}.upsert:new`); return made;
    },
    delete: async ({ where }: { where: Row }) => {
      const i = tables[model].findIndex((r) => matches(model, r, where));
      if (i < 0) throw new Error("Record to delete does not exist");
      writes.push(`${model}.delete:${tables[model][i].id}`); tables[model].splice(i, 1); return {};
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const doomed = tables[model].filter((r) => matches(model, r, where));
      doomed.forEach((r) => { writes.push(`${model}.deleteMany:${r.id}`); tables[model].splice(tables[model].indexOf(r), 1); });
      return { count: doomed.length };
    },
  });
  const client: Record<string, unknown> = { $transaction: async (fn: (tx: unknown) => unknown) => fn(client) };
  for (const m of Object.keys(tables)) client[m] = delegate(m);
  return { client, tables, writes };
}

vi.mock("@/lib/db", () => ({ default: () => db.current!.client }));
vi.mock("@/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId, name: "Alice" } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/analytics/activity", () => ({ getHumanActivityPrisma: () => db.current!.client }));
// Capture bookkeeping (activity feed, following) is not under test; run the write itself.
vi.mock("@/lib/workspace-update-mutations", () => ({
  captureWorkspaceMutation: async (prisma: unknown, _m: string, _op: string, _src: string, _id: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
}));
vi.mock("@/lib/comment-compat", () => ({
  mirrorLegacySolutionComment: vi.fn(),
  updateMirroredComment: vi.fn(),
  deleteMirroredComment: vi.fn(),
  updateMirroredLegacyPlanStatus: vi.fn(),
}));
vi.mock("@/lib/roadmap/solution-sync", () => ({ syncRoadmapOnSolutionChange: vi.fn() }));

import * as discovery from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import * as settings from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import * as orgSettings from "@/app/[orgSlug]/settings/actions";

const P = "/p";
const DENIED = /access denied|not found|Not found/i;

beforeEach(() => {
  db.current = makeDb();
  session.userId = ALICE;
});

const row = (table: string, id: string) => db.current!.tables[table].find((r) => r.id === id);

describe("discovery actions refuse another workspace's records and write nothing", () => {
  const denied: Array<[string, () => Promise<unknown>]> = [
    ["updateAssumptionStatus", () => discovery.updateAssumptionStatus("asm-b", "VALIDATED", P)],
    ["deleteAssumption", () => discovery.deleteAssumption("asm-b", P)],
    ["reorderAssumption", () => discovery.reorderAssumption("asm-b", 9, P)],
    ["addEvidence (foreign workspace)", () => discovery.addEvidence({ workspaceId: W_B, sourceType: "interview", excerpt: "x", opportunityId: "opp-b" }, P)],
    ["addEvidence (own workspace, foreign target)", () => discovery.addEvidence({ workspaceId: W_A, sourceType: "interview", excerpt: "x", opportunityId: "opp-b" }, P)],
    ["deleteEvidence", () => discovery.deleteEvidence("ev-b", P)],
    ["linkEvidence (foreign evidence)", () => discovery.linkEvidence("ev-b", { opportunityId: "opp-a" }, P)],
    ["linkEvidence (own evidence, foreign target)", () => discovery.linkEvidence("ev-a", { opportunityId: "opp-b" }, P)],
    ["addSolutionComment", () => discovery.addSolutionComment("sol-b", { body: "hi" }, P)],
    ["updateSolutionComment", () => discovery.updateSolutionComment("cm-b", "pwned", P)],
    ["deleteSolutionComment", () => discovery.deleteSolutionComment("cm-b", P)],
    ["approveSolutionPlan", () => discovery.approveSolutionPlan("cm-b", P)],
    ["rejectSolutionPlan", () => discovery.rejectSolutionPlan("cm-b", P)],
  ];

  it.each(denied)("%s", async (_name, run) => {
    await expect(run()).rejects.toThrow(DENIED);
    expect(db.current!.writes).toEqual([]);
  });

  it("an unauthenticated caller is refused", async () => {
    session.userId = null;
    await expect(discovery.deleteAssumption("asm-a", P)).rejects.toThrow("Unauthorized");
    await expect(discovery.deleteEvidence("ev-a", P)).rejects.toThrow("Unauthorized");
    await expect(discovery.approveSolutionPlan("cm-a", P)).rejects.toThrow("Unauthorized");
    expect(db.current!.writes).toEqual([]);
  });

  it("the caller can still act on their own workspace's records", async () => {
    await discovery.updateAssumptionStatus("asm-a", "VALIDATED", P);
    expect(row("assumption", "asm-a")?.status).toBe("VALIDATED");
    await discovery.reorderAssumption("asm-a", 3, P);
    expect(row("assumption", "asm-a")?.sortOrder).toBe(3);
    await discovery.addEvidence({ workspaceId: W_A, sourceType: "interview", excerpt: "x", opportunityId: "opp-a" }, P);
    await discovery.linkEvidence("ev-a", { solutionId: "sol-a" }, P);
    expect(row("evidence", "ev-a")?.solutionId).toBe("sol-a");
    await discovery.addSolutionComment("sol-a", { body: "hi" }, P);
    await discovery.approveSolutionPlan("cm-a", P);
    expect(row("solutionComment", "cm-a")?.planStatus).toBe("APPROVED");
    await discovery.updateSolutionComment("cm-a", "edited", P);
    await discovery.deleteSolutionComment("cm-a", P);
    await discovery.deleteEvidence("ev-a", P);
    await discovery.deleteAssumption("asm-a", P);
    expect(row("assumption", "asm-a")).toBeUndefined();
    expect(row("evidence", "ev-a")).toBeUndefined();
    expect(row("solutionComment", "cm-a")).toBeUndefined();
  });
});

describe("workspace settings actions", () => {
  it.each([
    ["upsertFieldValue (foreign object and field)", () => settings.upsertFieldValue("opp-b", "fd-b", "pwned", P)],
    ["upsertFieldValue (own field, foreign object)", () => settings.upsertFieldValue("opp-b", "fd-a", "pwned", P)],
    ["upsertFieldValue (foreign field, own object)", () => settings.upsertFieldValue("opp-a", "fd-b", "pwned", P)],
    ["upsertFieldValue clear (foreign)", () => settings.upsertFieldValue("opp-b", "fd-b", null, P)],
    ["deleteFieldDefinition", () => settings.deleteFieldDefinition("acme", "alpha", "fd-b")],
    ["updateFieldDefinition (name)", () => settings.updateFieldDefinition("acme", "alpha", "fd-b", { name: "pwned" })],
    ["updateFieldDefinition (detach)", () => settings.updateFieldDefinition("acme", "alpha", "fd-b", { sharedOptionSetId: null })],
  ])("%s is refused and writes nothing", async (_name, run) => {
    await expect(run()).rejects.toThrow(DENIED);
    expect(db.current!.writes).toEqual([]);
    expect(row("customFieldDefinition", "fd-b")?.name).toBe("B field");
    expect(row("customFieldValue", "fv-b")?.value).toBe("keep");
  });

  it("upsertFieldValue rejects an unauthenticated caller", async () => {
    session.userId = null;
    await expect(settings.upsertFieldValue("opp-a", "fd-a", "v", P)).rejects.toThrow("Unauthorized");
  });

  it("the caller can still write and delete within their own workspace", async () => {
    await settings.upsertFieldValue("opp-a", "fd-a", "mine", P);
    expect(db.current!.tables.customFieldValue.find((r) => r.fieldId === "fd-a")?.value).toBe("mine");
    await settings.updateFieldDefinition("acme", "alpha", "fd-a", { name: "renamed", required: true });
    expect(row("customFieldDefinition", "fd-a")).toMatchObject({ name: "renamed", required: true });
    await settings.deleteFieldDefinition("acme", "alpha", "fd-a");
    expect(row("customFieldDefinition", "fd-a")).toBeUndefined();
    expect(db.current!.tables.customFieldValue.some((r) => r.fieldId === "fd-a")).toBe(false);
    expect(row("customFieldValue", "fv-b")).toBeDefined();
  });
});

describe("organization scoring-model actions", () => {
  const metric = { key: "k", label: "K", minValue: 1, maxValue: 5, weight: 1, direction: "HIGHER_IS_BETTER" as const };

  it.each([
    ["updateScoringModelDetails", () => orgSettings.updateScoringModelDetails("acme", "sm-b", { name: "pwned" })],
    ["updateScoringModelMetrics", () => orgSettings.updateScoringModelMetrics("acme", "sm-b", { metrics: [metric] })],
    ["archiveScoringModel", () => orgSettings.archiveScoringModel("acme", "sm-b")],
  ])("%s fails closed for another organization's model", async (_name, run) => {
    const result = (await run()) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(db.current!.writes).toEqual([]);
    expect(row("scoringModel", "sm-b")).toMatchObject({ name: "B model", status: "ACTIVE", version: 1 });
    expect(db.current!.tables.scoringModelMetric.filter((m) => m.scoringModelId === "sm-b")).toHaveLength(1);
  });

  it("the caller can still edit their own organization's model", async () => {
    expect(await orgSettings.updateScoringModelDetails("acme", "sm-a", { name: "renamed" })).toEqual({ ok: true });
    expect(row("scoringModel", "sm-a")?.name).toBe("renamed");
    expect(await orgSettings.updateScoringModelMetrics("acme", "sm-a", { metrics: [metric] })).toEqual({ ok: true });
    expect(row("scoringModel", "sm-a")?.version).toBe(2);
    expect(await orgSettings.archiveScoringModel("acme", "sm-a")).toEqual({ ok: true });
    expect(row("scoringModel", "sm-a")?.status).toBe("ARCHIVED");
  });
});
