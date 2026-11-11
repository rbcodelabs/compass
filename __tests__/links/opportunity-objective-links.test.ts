/**
 * Opportunity <-> Objective (origin DIRECT / LEGACY) and the Opportunity -> Key Result pointer. entity_links is the only store:
 * lib/typed-links.ts is the dedicated writer (the Key Result pointer is the OPPORTUNITY_TARGETS_KEY_RESULT link, not a column), and the
 * generic link tools refuse both types.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

import {
  deleteLegacyLinksForOpportunities,
  deleteLinksFor,
  drainLegacyLinksForOpportunities,
  drainLinksFor,
  getOpportunityKeyResultPointers,
  linkOpportunityToObjective,
  setKeyResultPointer,
  setOpportunityKeyResult,
  unlinkOpportunityFromObjective,
} from "@/lib/typed-links";
import { linkEntities, unlinkEntities } from "@/lib/links/service";
import { getLinkType, isLinkTypeEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppTransactionClient } from "@/lib/db";

const OBJ = "OPPORTUNITY_TARGETS_OBJECTIVE";
const KR = "OPPORTUNITY_TARGETS_KEY_RESULT";
const ctx = { source: "MCP" as const, createdById: "user-alice" };
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state;
const rows = (type = OBJ) => state().entityLinks.filter((row) => row.linkType === type);
const direct = (opportunityId = "opp-a", objectiveId = "obj-a", expectedWorkspaceId: string = WS_A.id) =>
  linkOpportunityToObjective(tx(), { opportunityId, objectiveId, expectedWorkspaceId, ctx });
const setPointer = (keyResultId: string | null, opportunityId = "opp-a", expectedWorkspaceId: string = WS_A.id) =>
  setOpportunityKeyResult(tx(), { opportunityId, keyResultId, expectedWorkspaceId, ctx });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  // A second Key Result under obj-a and a second Objective with a Key Result, both in workspace A.
  state().keyResults.push({ id: "kr-a2", objectiveId: "obj-a", title: "A2", target: 1, current: 0, sortOrder: 1 });
  state().objectives.push({ id: "obj-a2", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 2", status: "ON_TRACK", sortOrder: 1 });
  state().keyResults.push({ id: "kr-a3", objectiveId: "obj-a2", title: "A3", target: 1, current: 0, sortOrder: 2 });
});

describe("Opportunity <-> Objective keeps its origin", () => {
  it("a DIRECT link stores the workspace, actor and source of its writer", async () => {
    expect((await direct()).created).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" });
  });

  it("a pointer write creates a LEGACY objective link plus the Key Result pointer row", async () => {
    await setPointer("kr-a");
    expect(rows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "LEGACY"]]);
    expect(rows(KR).map((row) => [row.fromId, row.toId, row.toType, row.origin])).toEqual([["opp-a", "kr-a", "KEY_RESULT", "LEGACY"]]);
  });

  it("DIRECT over an existing LEGACY pair flips it to DIRECT with the new actor", async () => {
    await setPointer("kr-a");
    const result = await direct();
    expect(result.originFlipped).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ origin: "DIRECT", source: "MCP", createdById: "user-alice" });
  });

  it("a LEGACY write never downgrades a DIRECT pair", async () => {
    await direct();
    await setPointer("kr-a");
    expect(rows().map((row) => row.origin)).toEqual(["DIRECT"]);
  });

  it("is idempotent: repeating adds nothing", async () => {
    await direct();
    expect((await direct()).created).toBe(false);
    await setPointer("kr-a");
    await setPointer("kr-a");
    expect(rows()).toHaveLength(1);
    expect(rows(KR)).toHaveLength(1);
  });

  it("unlinking a DIRECT link that the pointer still implies downgrades it to LEGACY", async () => {
    await setPointer("kr-a");
    await direct();
    const result = await unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_A.id });
    expect(result).toEqual({ removed: 0, stillLinkedViaKeyResult: true });
    expect(rows().map((row) => row.origin)).toEqual(["LEGACY"]);
  });

  it("unlinking a plain DIRECT link removes the row", async () => {
    await direct();
    expect((await unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_A.id })).removed).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it("changing the pointer to another Objective drops the old LEGACY row and keeps DIRECT rows", async () => {
    await direct("opp-a", "obj-a");
    await setPointer("kr-a3");
    expect(rows().map((row) => [row.toId, row.origin]).sort()).toEqual([["obj-a", "DIRECT"], ["obj-a2", "LEGACY"]]);
    await setPointer("kr-a");
    expect(rows().map((row) => [row.toId, row.origin]).sort()).toEqual([["obj-a", "DIRECT"]]);
  });
});

describe("Opportunity -> Key Result pointer", () => {
  it("replaces the row when the pointer moves to another Key Result, and removes it when the pointer is cleared", async () => {
    await setPointer("kr-a");
    await setPointer("kr-a2");
    expect(rows(KR).map((row) => row.toId)).toEqual(["kr-a2"]);
    await setPointer(null);
    expect(rows(KR)).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("holds the Key Result granularity: two Key Results of one Objective give one Objective link and a distinct pointer row each time", async () => {
    await setPointer("kr-a");
    await setPointer("kr-a2");
    expect(rows()).toHaveLength(1);
    expect(rows(KR)[0]).toMatchObject({ toId: "kr-a2", origin: "LEGACY" });
  });

  it("setOpportunityKeyResult returns the opportunity with the pointer it just set (the column is never written)", async () => {
    expect(await setPointer("kr-a")).toMatchObject({ id: "opp-a", linkedKeyResultId: "kr-a" });
    expect(await setPointer(null)).toMatchObject({ id: "opp-a", linkedKeyResultId: null });
    expect(state().opportunities.find((row) => row.id === "opp-a")!.linkedKeyResultId).toBeNull();
  });

  it("getOpportunityKeyResultPointers reads the pointer from entity_links, ignoring the row's own column and other workspaces", async () => {
    await setPointer("kr-a");
    const pointers = await getOpportunityKeyResultPointers(tx(), WS_A.id, [{ id: "opp-a" }, { id: "opp-a2" }]);
    expect([...pointers]).toEqual([["opp-a", "kr-a"], ["opp-a2", null]]);
    // A pointer row stamped with another workspace's id (drift) is not served to that workspace.
    expect((await getOpportunityKeyResultPointers(tx(), WS_B.id, [{ id: "opp-a" }])).get("opp-a")).toBeNull();
  });

  it("a Key Result in another workspace is refused before anything is written", async () => {
    await expect(setPointer("kr-b")).rejects.toThrow();
    expect(state().entityLinks).toHaveLength(0);
  });

  it("setKeyResultPointer (the Key Result move and create paths) writes the pointer and the derived link", async () => {
    await setKeyResultPointer(tx(), { opportunityId: "opp-a", workspaceId: WS_A.id, keyResultId: "kr-a", ctx });
    expect(rows(KR).map((row) => row.toId)).toEqual(["kr-a"]);
    expect(rows().map((row) => row.toId)).toEqual(["obj-a"]);
  });
});

describe("tenant isolation", () => {
  it("a cross-workspace pair is refused before anything is written", async () => {
    await expect(direct("opp-a", "obj-b")).rejects.toThrow();
    await expect(direct("opp-b", "obj-a")).rejects.toThrow();
    await expect(direct("opp-a", "obj-a", WS_B.id)).rejects.toThrow();
    expect(state().entityLinks).toHaveLength(0);
  });

  it("unlinking in the wrong workspace removes nothing", async () => {
    await direct();
    await expect(unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_B.id })).rejects.toThrow();
    expect(rows()).toHaveLength(1);
  });
});

describe("one writer: the generic surface cannot write these types", () => {
  it("linkEntities and unlinkEntities refuse both and point at the existing tool", async () => {
    await expect(linkEntities(tx(), { linkType: OBJ, fromId: "opp-a", toId: "obj-a", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_opportunity_to_objective/);
    await expect(linkEntities(tx(), { linkType: KR, fromId: "opp-a", toId: "kr-a", toType: "KEY_RESULT", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_opportunity_to_kr/);
    await expect(unlinkEntities(tx(), { linkType: OBJ, fromId: "opp-a", toId: "obj-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through/);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("neither type is offered for any endpoint of the generic link tools", () => {
    for (const type of ["OPPORTUNITY", "OBJECTIVE", "KEY_RESULT"] as const) {
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(OBJ);
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(KR);
    }
  });

  it("the registry entries name their dedicated writer, origins, cardinality and compat tools", () => {
    const objective = getLinkType(OBJ)!;
    expect(objective.dedicatedWriter?.module).toBe("lib/typed-links.ts");
    expect(objective.origins).toEqual(["DIRECT", "LEGACY"]);
    expect(objective.cardinality).toEqual({ from: "many", to: "many" });
    const pointer = getLinkType(KR)!;
    expect(pointer.dedicatedWriter?.module).toBe("lib/typed-links.ts");
    expect(pointer.origins).toEqual(["LEGACY"]);
    expect(pointer.cardinality).toEqual({ from: "one", to: "many" });
    expect(pointer.compat?.mcpTools).toEqual(["link_opportunity_to_kr"]);
    expect(isLinkTypeEnabled(objective) && isLinkTypeEnabled(pointer)).toBe(true);
  });
});

describe("delete and cascade", () => {
  it("deleteLinksFor sweeps the objective link and the pointer row of a deleted opportunity, and the links to a deleted objective", async () => {
    await direct();
    await setPointer("kr-a2");
    // objective link (DIRECT, kept over the pointer's derived LEGACY one) + pointer row
    expect(await deleteLinksFor(tx(), "opportunity", ["opp-a"])).toBe(2);
    expect(state().entityLinks).toHaveLength(0);
    await direct("opp-a", "obj-a2");
    expect(await deleteLinksFor(tx(), "objective", ["obj-a2"])).toBe(1);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("drainLinksFor for a deleted Key Result removes the pointer rows that name it and leaves other links alone", async () => {
    await setPointer("kr-a");
    expect(rows(KR)).toHaveLength(1);
    await drainLinksFor(tx(), "keyResult", ["kr-a"]);
    expect(rows(KR)).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });

  it("drainLegacyLinksForOpportunities / deleteLegacyLinksForOpportunities drop the LEGACY rows and keep DIRECT ones", async () => {
    await setPointer("kr-a3");
    await direct("opp-a", "obj-a");
    expect(await drainLegacyLinksForOpportunities(tx(), ["opp-a"], "obj-a2")).toBe(1);
    expect(rows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "DIRECT"]]);

    await setPointer("kr-a2");
    expect(await deleteLegacyLinksForOpportunities(tx(), ["opp-a"])).toBe(0);
    expect(rows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "DIRECT"]]);
  });
});
