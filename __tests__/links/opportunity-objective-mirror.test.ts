/**
 * Phase 5: Opportunity <-> Objective (origin DIRECT/LEGACY preserved) and the Opportunity -> Key Result pointer.
 * opportunity_objective_links and opportunities.linked_key_result_id stay the source of truth; lib/typed-links.ts mirrors every write into
 * entity_links in the same transaction while COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR is on. Reads and the generic tools ignore both types.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import {
  deleteLegacyLinksForOpportunities,
  deleteLinksFor,
  drainLegacyLinksForOpportunities,
  drainLinksFor,
  linkOpportunityToObjective,
  setOpportunityKeyResult,
  syncLegacyLink,
  unlinkOpportunityFromObjective,
} from "@/lib/typed-links";
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { getLinkType, isLinkTypeEnabled, isOpportunityLinkMirrorEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppTransactionClient } from "@/lib/db";

const OBJ = "OPPORTUNITY_TARGETS_OBJECTIVE";
const KR = "OPPORTUNITY_TARGETS_KEY_RESULT";
const ctx = { source: "MCP" as const, createdById: "user-alice" };
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state;
const objectiveRows = (type = OBJ) => state().entityLinks.filter((row) => row.linkType === type);
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
afterEach(() => vi.unstubAllEnvs());

describe("flag", () => {
  it("is on outside production unless set to 0, and off in production unless set to 1", () => {
    expect(isOpportunityLinkMirrorEnabled()).toBe(true);
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "0");
    expect(isOpportunityLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "");
    expect(isOpportunityLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "true");
    expect(isOpportunityLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "1");
    expect(isOpportunityLinkMirrorEnabled()).toBe(true);
  });
});

describe("Opportunity <-> Objective mirrors origin", () => {
  it("a DIRECT link writes the legacy row first and a DIRECT mirror row with the same workspace, actor and source", async () => {
    expect((await direct()).created).toBe(true);
    expect(state().opportunityObjectiveLinks).toHaveLength(1);
    expect(objectiveRows()).toHaveLength(1);
    expect(objectiveRows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" });
  });

  it("a pointer write creates a LEGACY objective link plus the Key Result pointer row, both mirrored", async () => {
    await setPointer("kr-a");
    expect(state().opportunityObjectiveLinks.map((row) => row.origin)).toEqual(["LEGACY"]);
    expect(objectiveRows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "LEGACY"]]);
    expect(objectiveRows(KR).map((row) => [row.fromId, row.toId, row.toType, row.origin])).toEqual([["opp-a", "kr-a", "KEY_RESULT", "LEGACY"]]);
  });

  it("DIRECT over an existing LEGACY pair flips the mirror to DIRECT with the new actor, like the legacy row", async () => {
    await setPointer("kr-a");
    const result = await direct();
    expect(result.originFlipped).toBe(true);
    expect(state().opportunityObjectiveLinks[0].origin).toBe("DIRECT");
    expect(objectiveRows()).toHaveLength(1);
    expect(objectiveRows()[0]).toMatchObject({ origin: "DIRECT", source: "MCP", createdById: "user-alice" });
  });

  it("a LEGACY write never downgrades a DIRECT pair, in the legacy row or the mirror", async () => {
    await direct();
    await setPointer("kr-a");
    expect(state().opportunityObjectiveLinks.map((row) => row.origin)).toEqual(["DIRECT"]);
    expect(objectiveRows().map((row) => row.origin)).toEqual(["DIRECT"]);
  });

  it("is idempotent: repeating adds nothing to either table", async () => {
    await direct();
    expect((await direct()).created).toBe(false);
    await setPointer("kr-a");
    await setPointer("kr-a");
    expect(state().opportunityObjectiveLinks).toHaveLength(1);
    expect(objectiveRows()).toHaveLength(1);
    expect(objectiveRows(KR)).toHaveLength(1);
  });

  it("unlinking a DIRECT link that the pointer still implies downgrades it to LEGACY in both tables", async () => {
    await setPointer("kr-a");
    await direct();
    const result = await unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_A.id });
    expect(result).toEqual({ removed: 0, stillLinkedViaKeyResult: true });
    expect(state().opportunityObjectiveLinks.map((row) => row.origin)).toEqual(["LEGACY"]);
    expect(objectiveRows().map((row) => row.origin)).toEqual(["LEGACY"]);
  });

  it("unlinking a plain DIRECT link removes the mirror row, even when the flag has since been turned off", async () => {
    await direct();
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "0");
    expect((await unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_A.id })).removed).toBe(1);
    expect(state().opportunityObjectiveLinks).toHaveLength(0);
    expect(objectiveRows()).toHaveLength(0);
  });

  it("changing the pointer to another Objective drops the old LEGACY row and keeps DIRECT rows, in both tables", async () => {
    await direct("opp-a", "obj-a");
    await setPointer("kr-a3");
    expect(state().opportunityObjectiveLinks.map((row) => [row.objectiveId, row.origin]).sort()).toEqual([["obj-a", "DIRECT"], ["obj-a2", "LEGACY"]]);
    expect(objectiveRows().map((row) => [row.toId, row.origin]).sort()).toEqual([["obj-a", "DIRECT"], ["obj-a2", "LEGACY"]]);
    await setPointer("kr-a");
    expect(state().opportunityObjectiveLinks.map((row) => [row.objectiveId, row.origin]).sort()).toEqual([["obj-a", "DIRECT"]]);
    expect(objectiveRows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "DIRECT"]]);
  });

  it("writes no mirror row when the flag is off, and the legacy result is unchanged", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "0");
    expect((await direct()).created).toBe(true);
    await setPointer("kr-a2");
    expect(state().opportunityObjectiveLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("propagates a mirror failure to the caller, so the shared transaction rolls back (the fake does not model rollback)", async () => {
    const failing = vi.spyOn(fake.current!.client.entityLink, "create").mockRejectedValueOnce(new Error("boom"));
    await expect(direct()).rejects.toThrow("boom");
    failing.mockRestore();
  });
});

describe("Opportunity -> Key Result pointer", () => {
  it("replaces the row when the pointer moves to another Key Result, and removes it when the pointer is cleared", async () => {
    await setPointer("kr-a");
    await setPointer("kr-a2");
    expect(objectiveRows(KR).map((row) => row.toId)).toEqual(["kr-a2"]);
    await setPointer(null);
    expect(objectiveRows(KR)).toHaveLength(0);
    expect(state().opportunityObjectiveLinks).toHaveLength(0);
    expect(objectiveRows()).toHaveLength(0);
  });

  it("holds the Key Result granularity: two Key Results of one Objective give one Objective link and a distinct pointer row each time", async () => {
    await setPointer("kr-a");
    await setPointer("kr-a2");
    expect(objectiveRows()).toHaveLength(1);
    expect(objectiveRows(KR)[0]).toMatchObject({ toId: "kr-a2", origin: "LEGACY" });
  });

  it("with the flag off the pointer sync still removes stale rows but creates none", async () => {
    await setPointer("kr-a");
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "0");
    await setPointer("kr-a2");
    expect(objectiveRows(KR)).toHaveLength(0);
    await setPointer("kr-a3");
    expect(objectiveRows(KR)).toHaveLength(0);
    // the stale LEGACY objective row (obj-a) is gone too; the new one (obj-a2) is not created while the flag is off
    expect(objectiveRows()).toHaveLength(0);
  });

  it("a stale mirror row is not removed while its legacy row still exists as DIRECT", async () => {
    await direct("opp-a", "obj-a2");
    // drift: the mirror says LEGACY although the legacy row is DIRECT
    state().entityLinks.find((row) => row.toId === "obj-a2")!.origin = "LEGACY";
    await setPointer("kr-a");
    expect(objectiveRows().map((row) => row.toId).sort()).toEqual(["obj-a", "obj-a2"]);
  });

  it("a Key Result in another workspace is refused before either table is written", async () => {
    await expect(setPointer("kr-b")).rejects.toThrow();
    expect(state().entityLinks).toHaveLength(0);
    expect(state().opportunityObjectiveLinks).toHaveLength(0);
  });

  it("syncLegacyLink (the Key Result move and create paths) mirrors the pointer too", async () => {
    await syncLegacyLink(tx(), { opportunityId: "opp-a", workspaceId: WS_A.id, keyResultId: "kr-a", ctx });
    expect(objectiveRows(KR).map((row) => row.toId)).toEqual(["kr-a"]);
    expect(objectiveRows().map((row) => row.toId)).toEqual(["obj-a"]);
  });
});

describe("tenant isolation", () => {
  it("a cross-workspace pair is refused before either table is written", async () => {
    await expect(direct("opp-a", "obj-b")).rejects.toThrow();
    await expect(direct("opp-b", "obj-a")).rejects.toThrow();
    await expect(direct("opp-a", "obj-a", WS_B.id)).rejects.toThrow();
    expect(state().opportunityObjectiveLinks).toHaveLength(0);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("unlinking in the wrong workspace removes neither table's row", async () => {
    await direct();
    await expect(unlinkOpportunityFromObjective(tx(), { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_B.id })).rejects.toThrow();
    expect(state().opportunityObjectiveLinks).toHaveLength(1);
    expect(objectiveRows()).toHaveLength(1);
  });
});

describe("one writer: the generic surface cannot write or read these types", () => {
  it("linkEntities and unlinkEntities refuse both and point at the existing tool", async () => {
    await expect(linkEntities(tx(), { linkType: OBJ, fromId: "opp-a", toId: "obj-a", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_opportunity_to_objective/);
    await expect(linkEntities(tx(), { linkType: KR, fromId: "opp-a", toId: "kr-a", toType: "KEY_RESULT", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_opportunity_to_kr/);
    await expect(unlinkEntities(tx(), { linkType: OBJ, fromId: "opp-a", toId: "obj-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through/);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("reads hide them for every endpoint, flag on or off", async () => {
    await direct();
    await setPointer("kr-a");
    for (const type of ["OPPORTUNITY", "OBJECTIVE", "KEY_RESULT"] as const) {
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(OBJ);
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(KR);
    }
    for (const flag of ["1", "0"]) {
      vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", flag);
      expect((await listLinks(tx(), { workspaceId: WS_A.id, entityType: "OPPORTUNITY", entityId: "opp-a", limit: 10 })).items).toEqual([]);
      for (const linkType of [OBJ, KR]) {
        expect(await listLinks(tx(), { workspaceId: WS_A.id, entityType: "OPPORTUNITY", entityId: "opp-a", linkType, limit: 10 })).toEqual({ items: [], nextCursor: null });
      }
    }
  });

  it("the registry entries are legacy-mirrored, name the 095 backfill, origins and their compat tools", () => {
    const objective = getLinkType(OBJ)!;
    expect(objective.legacy).toEqual({ legacyModule: "lib/typed-links.ts", backfillMigration: "095_entity_links_backfill_opportunity", mode: "mirror" });
    expect(objective.origins).toEqual(["DIRECT", "LEGACY"]);
    expect(objective.cardinality).toEqual({ from: "many", to: "many" });
    const pointer = getLinkType(KR)!;
    expect(pointer.legacy?.backfillMigration).toBe("095_entity_links_backfill_opportunity");
    expect(pointer.origins).toEqual(["LEGACY"]);
    expect(pointer.cardinality).toEqual({ from: "one", to: "many" });
    expect(pointer.compat?.mcpTools).toEqual(["link_opportunity_to_kr"]);
    expect(isLinkTypeEnabled(objective) && isLinkTypeEnabled(pointer)).toBe(true);
  });
});

describe("delete and cascade", () => {
  it("deleteLinksFor sweeps legacy and mirror rows for a deleted opportunity or objective, even with the flag off", async () => {
    await direct();
    await setPointer("kr-a2");
    vi.stubEnv("COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR", "0");
    // legacy: 1 row (DIRECT + LEGACY share the pair); mirror: objective row + pointer row
    expect(await deleteLinksFor(tx(), "opportunity", ["opp-a"])).toBe(3);
    expect(state().opportunityObjectiveLinks).toHaveLength(0);
    expect(state().entityLinks).toHaveLength(0);
    vi.unstubAllEnvs();
    await direct("opp-a", "obj-a2");
    expect(await deleteLinksFor(tx(), "objective", ["obj-a2"])).toBe(2);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("drainLinksFor for a deleted Key Result removes the pointer rows that name it and leaves other links alone", async () => {
    await setPointer("kr-a");
    expect(objectiveRows(KR)).toHaveLength(1);
    await drainLinksFor(tx(), "keyResult", ["kr-a"]);
    expect(objectiveRows(KR)).toHaveLength(0);
    expect(objectiveRows()).toHaveLength(1);
  });

  it("drainLegacyLinksForOpportunities / deleteLegacyLinksForOpportunities drop the LEGACY mirror rows and keep DIRECT ones", async () => {
    await setPointer("kr-a3");
    await direct("opp-a", "obj-a");
    expect(await drainLegacyLinksForOpportunities(tx(), ["opp-a"], "obj-a2")).toBe(1);
    expect(state().opportunityObjectiveLinks.map((row) => row.objectiveId)).toEqual(["obj-a"]);
    expect(objectiveRows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "DIRECT"]]);

    await setPointer("kr-a2");
    expect(await deleteLegacyLinksForOpportunities(tx(), ["opp-a"])).toBe(0);
    expect(objectiveRows().map((row) => [row.toId, row.origin])).toEqual([["obj-a", "DIRECT"]]);
  });
});
