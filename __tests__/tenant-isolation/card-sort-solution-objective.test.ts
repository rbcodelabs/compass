/**
 * Card sort and the Solution / Objective / Key Result workspace scope (ADR Phase 0).
 *
 * lib/card-sort.ts OBJECT_LOADERS decide which objects a card sort may name, so they are AUTHORIZATION: the membership
 * check for proposals, and the rows of the board and the tally, are all derived from them. They must agree with
 * lib/mcp-authz.ts, i.e. scope Solutions and Objectives by their OWN workspaceId and Key Results through their Objective.
 *
 * The real card-sort code runs here against the where-honouring tenant fake, so a loader that walks the parent chain
 * (or forgets a filter) shows up as another tenant's or an un-backfilled row being listed, proposed on, or tallied.
 *
 * Operational consequence, stated plainly: a Solution or Objective whose workspaceId is still NULL (created by an old
 * instance after migration 068, before 069 / the repair action runs) disappears from card sort lists and a proposal naming
 * it is NOT_FOUND until the residual backfill completes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma>, extra: {} as Record<string, unknown> }));
vi.mock("@/lib/db", () => ({ default: () => ({ ...fake.current!.client, ...fake.extra }) }));

import { CardSortError, getCardSortTally, loadCardSortBoard, proposeCardSortMove, proposeCardSortMoves } from "@/lib/card-sort";

const OPTIONS = [{ label: "High", value: "high" }, { label: "Low", value: "low" }];
const ROUNDS = {
  SOLUTION: { open: "round-sol-open", revealed: "round-sol-rev", field: "field-sol" },
  OBJECTIVE: { open: "round-obj-open", revealed: "round-obj-rev", field: "field-obj" },
  KEY_RESULT: { open: "round-kr-open", revealed: "round-kr-rev", field: "field-kr" },
} as const;
/** [object type, own id (A), other workspace (B), NULL workspaceId] per the tenant fixtures. */
const CASES = [
  ["SOLUTION", "sol-a", "sol-b", "sol-null"],
  ["OBJECTIVE", "obj-a", "obj-b", "obj-null"],
  ["KEY_RESULT", "kr-a", "kr-b", "kr-null"],
] as const;

let proposals: Row[];
let upserts: Row[];

function installCardSort() {
  const fields: Row[] = Object.entries(ROUNDS).map(([objectType, r]) => ({ id: r.field, workspaceId: WS_A.id, name: `${objectType} priority`, fieldType: "SELECT", objectType, options: OPTIONS, sharedOptionSet: null }));
  const rounds: Row[] = Object.entries(ROUNDS).flatMap(([objectType, r]) =>
    (["open", "revealed"] as const).map((kind) => ({
      id: r[kind], workspaceId: WS_A.id, name: `${objectType} ${kind}`, objectType, fieldDefinitionId: r.field,
      state: kind === "open" ? "OPEN" : "REVEALED", createdById: USERS.alice, createdAt: new Date(1), revealedAt: kind === "open" ? null : new Date(2), closedAt: null,
      fieldDefinition: { name: `${objectType} priority` },
    })),
  );
  fake.extra = {
    customFieldDefinition: { findUnique: async ({ where }: { where: { id: string } }) => fields.find((f) => f.id === where.id) ?? null },
    cardSortRound: { findUnique: async ({ where }: { where: { id: string } }) => rounds.find((r) => r.id === where.id) ?? null },
    customFieldValue: { findUnique: async () => null, findMany: async () => [] },
    user: { findMany: async () => [] },
    cardSortProposal: {
      findMany: async ({ where }: { where: { roundId: string; userId?: string } }) => proposals.filter((p) => p.roundId === where.roundId && (where.userId === undefined || p.userId === where.userId)),
      count: async ({ where }: { where: { roundId: string } }) => proposals.filter((p) => p.roundId === where.roundId).length,
      upsert: async ({ create }: { create: Row }) => { upserts.push(create); proposals.push(create); return create; },
    },
  };
}

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  proposals = [];
  upserts = [];
  installCardSort();
});

const propose = (type: keyof typeof ROUNDS, objectId: string) =>
  proposeCardSortMove({ workspaceId: WS_A.id, roundId: ROUNDS[type].open, userId: USERS.alice, objectId, proposedValue: "high" });

describe("card sort proposals use the row's own workspaceId", () => {
  it.each(CASES)("%s: a proposal on the workspace's own row is accepted", async (type, own) => {
    await expect(propose(type, own)).resolves.toBeTruthy();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ objectId: own, proposedValue: "high" });
  });

  it.each(CASES)("%s: a proposal naming another workspace's row is NOT_FOUND and writes nothing", async (type, _own, foreign) => {
    await expect(propose(type, foreign)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(propose(type, foreign)).rejects.toBeInstanceOf(CardSortError);
    expect(upserts).toEqual([]);
  });

  it.each(CASES)("%s: a proposal naming a NULL-workspaceId row is NOT_FOUND even though its parent chain says workspace A", async (type, _own, _foreign, unbackfilled) => {
    await expect(propose(type, unbackfilled)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(upserts).toEqual([]);
  });

  it.each(CASES)("%s: a bulk proposal applies the own row and skips foreign and NULL rows as NOT_FOUND", async (type, own, foreign, unbackfilled) => {
    const result = await proposeCardSortMoves({ workspaceId: WS_A.id, roundId: ROUNDS[type].open, userId: USERS.alice, objectIds: [own, foreign, unbackfilled], proposedValue: "high" });
    expect(result.applied).toEqual([own]);
    expect(result.skipped.map((s) => [s.objectId, s.code])).toEqual([[foreign, "NOT_FOUND"], [unbackfilled, "NOT_FOUND"]]);
    expect(upserts.map((u) => u.objectId)).toEqual([own]);
  });

  it("a Solution that drifted (its own workspaceId names B, its opportunity is A's) is not proposable in A", async () => {
    fake.current!.state.solutions.push({ id: "sol-drift", workspaceId: WS_B.id, opportunityId: "opp-a", title: "drifted", status: "IDEA" });
    await expect(propose("SOLUTION", "sol-drift")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("card sort board lists only rows with the workspace's own workspaceId", () => {
  const board = (type: keyof typeof ROUNDS) => loadCardSortBoard({ workspaceId: WS_A.id, roundId: ROUNDS[type].revealed, userId: USERS.alice });

  it.each(CASES)("%s: the board has the own row and neither another workspace's nor a NULL-workspaceId row", async (type, own, foreign, unbackfilled) => {
    const rows = (await board(type)).rows.map((r) => r.objectId);
    expect(rows).toContain(own);
    expect(rows).not.toContain(foreign);
    expect(rows).not.toContain(unbackfilled);
  });

  it("a drifted Solution and a drifted Objective do not appear", async () => {
    fake.current!.state.solutions.push({ id: "sol-drift", workspaceId: WS_B.id, opportunityId: "opp-a", title: "drifted" });
    fake.current!.state.objectives.push({ id: "obj-drift", workspaceId: WS_B.id, cycleId: "cycle-a", title: "drifted" });
    expect((await board("SOLUTION")).rows.map((r) => r.objectId)).not.toContain("sol-drift");
    expect((await board("OBJECTIVE")).rows.map((r) => r.objectId)).not.toContain("obj-drift");
  });
});

describe("card sort tally ignores proposals on rows outside the workspace's scope", () => {
  it.each(CASES)("%s: proposals recorded on foreign and NULL-workspaceId ids never reach the tally", async (type, own, foreign, unbackfilled) => {
    // Rows smuggled in directly (as if written before the scope check existed, or by another path).
    for (const objectId of [own, foreign, unbackfilled]) {
      proposals.push({ roundId: ROUNDS[type].revealed, userId: "user-x", objectId, proposedValue: "high", fromValue: null, rationale: null });
    }
    const tally = await getCardSortTally({ workspaceId: WS_A.id, roundId: ROUNDS[type].revealed, userId: USERS.alice });
    expect(tally.objects.map((o) => o.objectId)).toEqual([own]);
    const text = JSON.stringify(tally);
    expect(text).not.toContain(foreign);
    expect(text).not.toContain(unbackfilled);
  });
});

describe("cycle-less Objectives (Phase 1, #332) appear in card sort once their workspaceId is set", () => {
  beforeEach(() => {
    const { objectives } = fake.current!.state;
    objectives.push({ id: "obj-cycleless", workspaceId: WS_A.id, cycleId: null, title: "Persistent outcome" });
    objectives.push({ id: "obj-cycleless-null", workspaceId: null, cycleId: null, title: "Cycle-less with no workspace" });
  });

  it("is listed on the board and accepts a proposal (the old cycle-chain loader would have dropped it: it has no cycle)", async () => {
    const rows = (await loadCardSortBoard({ workspaceId: WS_A.id, roundId: ROUNDS.OBJECTIVE.revealed, userId: USERS.alice })).rows.map((r) => r.objectId);
    expect(rows).toContain("obj-cycleless");
    await expect(propose("OBJECTIVE", "obj-cycleless")).resolves.toBeTruthy();
  });

  it("shows up in the tally once someone has proposed on it", async () => {
    proposals.push({ roundId: ROUNDS.OBJECTIVE.revealed, userId: "user-x", objectId: "obj-cycleless", proposedValue: "high", fromValue: null, rationale: null });
    const tally = await getCardSortTally({ workspaceId: WS_A.id, roundId: ROUNDS.OBJECTIVE.revealed, userId: USERS.alice });
    expect(tally.objects.map((o) => o.objectId)).toEqual(["obj-cycleless"]);
  });

  it("a cycle-less Objective with NO workspaceId has nothing to derive one from, so it is hidden and NOT_FOUND", async () => {
    const rows = (await loadCardSortBoard({ workspaceId: WS_A.id, roundId: ROUNDS.OBJECTIVE.revealed, userId: USERS.alice })).rows.map((r) => r.objectId);
    expect(rows).not.toContain("obj-cycleless-null");
    await expect(propose("OBJECTIVE", "obj-cycleless-null")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a cycle-less Objective in another workspace is still not reachable", async () => {
    fake.current!.state.objectives.push({ id: "obj-cycleless-b", workspaceId: WS_B.id, cycleId: null, title: "B persistent" });
    await expect(propose("OBJECTIVE", "obj-cycleless-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
