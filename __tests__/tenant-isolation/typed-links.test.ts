import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TypedLinkError,
  drainAfterParentDelete,
  drainLegacyLinksForOpportunities,
  drainLinksFor,
  assertSameWorkspacePair,
  deleteLinksFor,
  getLinkedKeyResultsBySolution,
  getLinkedObjectivesByOpportunity,
  linkOpportunityToObjective,
  linkSolutionToKeyResult,
  listLinks,
  setOpportunityKeyResult,
  unlinkOpportunityFromObjective,
  unlinkSolutionFromKeyResult,
} from "@/lib/typed-links";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const ctx = { source: "MCP" as const, createdById: null };

function setup() {
  const fake = createTenantFakePrisma();
  const tx = fake.client as never;
  // A second objective + key results in workspace A, so a legacy pointer can move between objectives.
  fake.state.objectives.push({ id: "obj-a2", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 2", status: "ON_TRACK", sortOrder: 1 });
  fake.state.keyResults.push({ id: "kr-a-sibling", objectiveId: "obj-a", title: "A sibling key result", target: 1, current: 0, sortOrder: 1 });
  fake.state.keyResults.push({ id: "kr-a2", objectiveId: "obj-a2", title: "A key result 2", target: 1, current: 0, sortOrder: 0 });
  const links = fake.state.opportunityObjectiveLinks;
  const krLinks = fake.state.solutionKeyResultLinks;
  const writesSince = (mark: number) => fake.state.writes.slice(mark);
  return { fake, tx, links, krLinks, writesSince };
}
const opp = (fake: ReturnType<typeof setup>["fake"], id: string) => fake.state.opportunities.find((o) => o.id === id)!;
const seedLink = (links: Record<string, unknown>[], row: Record<string, unknown>) =>
  links.push({ id: `seed-${links.length}`, source: "UI", createdById: null, createdAt: new Date(10 + links.length), ...row });

describe("assertSameWorkspacePair", () => {
  it("returns the shared workspace id", () => {
    expect(assertSameWorkspacePair({ workspaceId: "w" }, { workspaceId: "w" })).toBe("w");
  });
  it.each([
    [{ workspaceId: "a" }, { workspaceId: "b" }],
    [{ workspaceId: null }, { workspaceId: "b" }],
    [{ workspaceId: "a" }, { workspaceId: undefined }],
    [{ workspaceId: null }, { workspaceId: null }],
  ])("throws for %j / %j (mismatch or NULL fails closed)", (left, right) => {
    expect(() => assertSameWorkspacePair(left, right)).toThrow(TypedLinkError);
  });
});

describe("linkOpportunityToObjective", () => {
  it("creates a DIRECT link whose workspaceId comes from the opportunity, and ignores a forged workspaceId input", async () => {
    const { fake, tx, links } = setup();
    const result = await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx, workspaceId: WS_B.id } as never);
    expect(result.created).toBe(true);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT", source: "MCP" });
    expect(fake.state.writes.filter((w) => w.includes("Link"))).toHaveLength(1);
  });

  it("is idempotent: a repeat reports created:false and writes nothing", async () => {
    const { fake, tx, links } = setup();
    await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    const mark = fake.state.writes.length;
    const again = await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    expect(again.created).toBe(false);
    expect(links).toHaveLength(1);
    expect(fake.state.writes.slice(mark)).toEqual([]);
  });

  it.each([
    ["a foreign objective", "opp-a", "obj-b"],
    ["an objective whose workspaceId is NULL", "opp-a", "obj-null"],
    ["a missing objective", "opp-a", "nope"],
    ["a missing opportunity", "nope", "obj-a"],
    ["a foreign opportunity", "opp-b", "obj-a"],
  ])("denies %s and writes nothing", async (_label, opportunityId, objectiveId) => {
    const { fake, tx, links } = setup();
    const mark = fake.state.writes.length;
    await expect(linkOpportunityToObjective(tx, { opportunityId, objectiveId, ctx })).rejects.toBeInstanceOf(TypedLinkError);
    expect(links).toEqual([]);
    expect(fake.state.writes.slice(mark)).toEqual([]);
  });

  it("denies when the caller's declared workspace is not the opportunity's", async () => {
    const { tx, links } = setup();
    await expect(
      linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", expectedWorkspaceId: WS_B.id, ctx }),
    ).rejects.toBeInstanceOf(TypedLinkError);
    expect(links).toEqual([]);
  });

  it("adding a DIRECT link over an existing LEGACY pair flips its origin to DIRECT (no second row)", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" });
    const result = await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    expect(result).toMatchObject({ created: false, originFlipped: true });
    expect(links).toHaveLength(1);
    expect(links[0].origin).toBe("DIRECT");
  });

  it("repairs a drifted workspaceId on the existing pair instead of failing the unique index", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    expect(links).toHaveLength(1);
    expect(links[0].workspaceId).toBe(WS_A.id);
  });
});

describe("unlinkOpportunityFromObjective", () => {
  it("removes the link once, then reports removed:0", async () => {
    const { tx, links } = setup();
    await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    expect(await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" })).toMatchObject({ removed: 1 });
    expect(links).toEqual([]);
    expect(await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" })).toMatchObject({ removed: 0 });
  });

  it("never touches another workspace's link for the same ids", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    expect(await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" })).toMatchObject({ removed: 0 });
    expect(links).toHaveLength(1);
  });

  it("denies a foreign opportunity", async () => {
    const { tx } = setup();
    await expect(unlinkOpportunityFromObjective(tx, { opportunityId: "opp-b", objectiveId: "obj-a", expectedWorkspaceId: WS_A.id })).rejects.toBeInstanceOf(TypedLinkError);
  });

  it("keeps the link while the legacy pointer still implies it (a legacy-derived pair cannot be unlinked, only its DIRECT claim dropped)", async () => {
    const { fake, tx, links } = setup();
    opp(fake, "opp-a").linkedKeyResultId = "kr-a";
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    const result = await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" });
    expect(result).toMatchObject({ removed: 0, stillLinkedViaKeyResult: true });
    expect(links).toHaveLength(1);
    expect(links[0].origin).toBe("LEGACY");
  });
});

describe("setOpportunityKeyResult (legacy pointer dual-write)", () => {
  it("set: writes the column and a LEGACY link to the key result's objective", async () => {
    const { fake, tx, links } = setup();
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx });
    expect(opp(fake, "opp-a").linkedKeyResultId).toBe("kr-a");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" });
  });

  it("change to a key result under another objective: deletes the old LEGACY link and creates the new one", async () => {
    const { tx, links } = setup();
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx });
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a2", ctx });
    expect(links.map((l) => [l.objectiveId, l.origin])).toEqual([["obj-a2", "LEGACY"]]);
  });

  it("change to a sibling key result under the same objective keeps the single link", async () => {
    const { tx, links } = setup();
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx });
    const before = links[0];
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a-sibling", ctx });
    expect(links).toEqual([before]);
  });

  it("clear: deletes the LEGACY link and nulls the column", async () => {
    const { fake, tx, links } = setup();
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx });
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: null, ctx });
    expect(opp(fake, "opp-a").linkedKeyResultId).toBeNull();
    expect(links).toEqual([]);
  });

  it("a DIRECT link survives a legacy clear and a legacy change away from its objective", async () => {
    const { tx, links } = setup();
    await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a2", ctx });
    expect(links.map((l) => [l.objectiveId, l.origin]).sort()).toEqual([["obj-a", "DIRECT"], ["obj-a2", "LEGACY"]]);
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: null, ctx });
    expect(links.map((l) => [l.objectiveId, l.origin])).toEqual([["obj-a", "DIRECT"]]);
  });

  it("a legacy set is not downgrading an existing DIRECT link to the same objective", async () => {
    const { tx, links } = setup();
    await linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx });
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx });
    expect(links).toHaveLength(1);
    expect(links[0].origin).toBe("DIRECT");
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: null, ctx });
    expect(links).toHaveLength(1);
  });

  it.each([
    ["a key result in another workspace", "kr-b"],
    ["a key result under an objective with a NULL workspaceId", "kr-null"],
    ["a missing key result", "nope"],
  ])("denies %s: no column write, no link write", async (_label, keyResultId) => {
    const { fake, tx, links } = setup();
    const mark = fake.state.writes.length;
    await expect(setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId, ctx })).rejects.toBeInstanceOf(TypedLinkError);
    expect(opp(fake, "opp-a").linkedKeyResultId).toBeNull();
    expect(links).toEqual([]);
    expect(fake.state.writes.slice(mark)).toEqual([]);
  });

  it("denies an opportunity outside the declared workspace", async () => {
    const { tx } = setup();
    await expect(setOpportunityKeyResult(tx, { opportunityId: "opp-b", keyResultId: "kr-b", expectedWorkspaceId: WS_A.id, ctx })).rejects.toBeInstanceOf(TypedLinkError);
  });
});

describe("Solution <-> Key Result", () => {
  it("links with the solution's workspaceId and is idempotent", async () => {
    const { tx, krLinks } = setup();
    const first = await linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx, workspaceId: WS_B.id } as never);
    const again = await linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx });
    expect([first.created, again.created]).toEqual([true, false]);
    expect(krLinks).toHaveLength(1);
    expect(krLinks[0]).toMatchObject({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a", source: "MCP" });
  });

  it.each([
    ["a foreign key result", "sol-a", "kr-b"],
    ["a key result under an unbackfilled objective", "sol-a", "kr-null"],
    ["a solution whose workspaceId is NULL", "sol-null", "kr-a"],
    ["a foreign solution", "sol-b", "kr-a"],
  ])("denies %s with no writes", async (_label, solutionId, keyResultId) => {
    const { fake, tx, krLinks } = setup();
    const mark = fake.state.writes.length;
    await expect(linkSolutionToKeyResult(tx, { solutionId, keyResultId, ctx })).rejects.toBeInstanceOf(TypedLinkError);
    expect(krLinks).toEqual([]);
    expect(fake.state.writes.slice(mark)).toEqual([]);
  });

  it("unlink removes once then reports 0, within the solution's workspace only", async () => {
    const { tx, krLinks } = setup();
    await linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx });
    seedLink(krLinks, { workspaceId: WS_B.id, solutionId: "sol-a", keyResultId: "kr-a-other", origin: undefined });
    expect(await unlinkSolutionFromKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a" })).toMatchObject({ removed: 1 });
    expect(await unlinkSolutionFromKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a" })).toMatchObject({ removed: 0 });
    expect(krLinks).toHaveLength(1);
  });

  it("does not change Solution.opportunityId", async () => {
    const { fake, tx } = setup();
    await linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx });
    expect(fake.state.solutions.find((s) => s.id === "sol-a")!.opportunityId).toBe("opp-a");
  });
});

describe("deleteLinksFor", () => {
  it("removes every link naming the deleted parent, of both origins, and leaves other rows", async () => {
    const { tx, links, krLinks } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "DIRECT" });
    seedLink(links, { workspaceId: WS_B.id, opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT" });
    seedLink(krLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    expect(await deleteLinksFor(tx, "objective", ["obj-a"])).toBe(1);
    expect(await deleteLinksFor(tx, "opportunity", ["opp-a"])).toBe(1);
    expect(await deleteLinksFor(tx, "keyResult", ["kr-a"])).toBe(1);
    expect(links.map((l) => l.opportunityId)).toEqual(["opp-b"]);
    expect(krLinks).toEqual([]);
  });

  it("is a no-op for an empty id list and chunks large lists", async () => {
    const { fake, tx, links } = setup();
    expect(await deleteLinksFor(tx, "solution", [])).toBe(0);
    for (let i = 0; i < 1_200; i += 1) seedLink(links, { workspaceId: WS_A.id, opportunityId: `o${i}`, objectiveId: "obj-a", origin: "LEGACY" });
    const spy = vi.spyOn(fake.client.opportunityObjectiveLink, "deleteMany");
    // Many parent ids in one call: 1,200 ids are split so no statement touches more than LINK_WRITE_CHUNK ids.
    const ids = Array.from({ length: 1_200 }, (_, i) => `o${i}`);
    expect(await deleteLinksFor(tx, "opportunity", ids)).toBe(1_200);
    expect(links).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [args] of spy.mock.calls) expect(((args as { where: { opportunityId: { in: string[] } } }).where.opportunityId.in).length).toBeLessThanOrEqual(500);
  });
});

describe("reads", () => {
  it("returns objectives per opportunity ordered by created_at then id, and never a link with the wrong workspaceId", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "DIRECT", createdAt: new Date(5) });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY", createdAt: new Date(5) });
    // Wrong workspaceId on the link row: both endpoints are workspace A's, but the row says B. Never returned to A.
    seedLink(links, { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT", createdAt: new Date(1) });
    const map = await getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"]);
    // Equal created_at ties break on the LINK id (seed-0 for obj-a2, seed-1 for obj-a), not on the objective id.
    expect(map.get("opp-a")!.map((o) => o.id)).toEqual(["obj-a2", "obj-a"]);
  });

  it("hides a link whose objective is NULL-workspace or in another workspace, even if the link row claims workspace A", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-null", origin: "DIRECT" });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT" });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "ghost", origin: "DIRECT" });
    const map = await getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"]);
    expect(map.get("opp-a")).toEqual([]);
  });

  it("does not return links for an opportunity that is not in the workspace", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-b", objectiveId: "obj-a", origin: "DIRECT" });
    const map = await getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-b"]);
    expect(map.get("opp-b")).toBeUndefined();
  });

  it("is a single batch per call: an empty id list does not query", async () => {
    const { tx } = setup();
    expect((await getLinkedObjectivesByOpportunity(tx, WS_A.id, [])).size).toBe(0);
  });

  it("returns key results per solution with the same workspace filtering", async () => {
    const { tx, krLinks } = setup();
    seedLink(krLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    seedLink(krLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-b" });
    seedLink(krLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-null" });
    seedLink(krLinks, { workspaceId: WS_B.id, solutionId: "sol-a", keyResultId: "kr-a2" });
    const map = await getLinkedKeyResultsBySolution(tx, WS_A.id, ["sol-a", "sol-null"]);
    expect(map.get("sol-a")!.map((k) => k.id)).toEqual(["kr-a"]);
    expect(map.get("sol-null")).toBeUndefined();
  });
});

describe("listLinks", () => {
  it("lists by opportunity with objective titles, paginates with a cursor, and is workspace filtered", async () => {
    const { tx, links } = setup();
    for (const objectiveId of ["obj-a", "obj-a2"]) seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId, origin: "DIRECT" });
    seedLink(links, { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT" });
    const page1 = await listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 1 });
    const objectiveIds = (items: { [k: string]: unknown }[]) => items.map((i) => i.objectiveId);
    expect(objectiveIds(page1.items)).toEqual(["obj-a"]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 1, cursor: page1.nextCursor! });
    expect(objectiveIds(page2.items)).toEqual(["obj-a2"]);
    expect(page2.nextCursor).toBeNull();
    expect(page1.items[0]).toMatchObject({ kind: "opportunity_objective", objectiveTitle: "A objective", origin: "DIRECT", opportunityTitle: "A opportunity" });
  });

  it("requires exactly one filter, rejects a bad cursor, and denies an entity outside the workspace", async () => {
    const { tx } = setup();
    await expect(listLinks(tx, { workspaceId: WS_A.id, limit: 10 } as never)).rejects.toBeInstanceOf(TypedLinkError);
    await expect(listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", limit: 10 } as never)).rejects.toBeInstanceOf(TypedLinkError);
    await expect(listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 10, cursor: "garbage" })).rejects.toBeInstanceOf(TypedLinkError);
    await expect(listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-b", limit: 10 })).rejects.toBeInstanceOf(TypedLinkError);
    await expect(listLinks(tx, { workspaceId: WS_A.id, keyResultId: "kr-b", limit: 10 })).rejects.toBeInstanceOf(TypedLinkError);
  });

  it("lists by objective, solution and key result", async () => {
    const { tx, links, krLinks } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" });
    seedLink(krLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    expect((await listLinks(tx, { workspaceId: WS_A.id, objectiveId: "obj-a", limit: 10 })).items[0]).toMatchObject({ opportunityId: "opp-a", origin: "LEGACY" });
    expect((await listLinks(tx, { workspaceId: WS_A.id, solutionId: "sol-a", limit: 10 })).items[0]).toMatchObject({ kind: "solution_key_result", keyResultId: "kr-a", keyResultTitle: "A key result" });
    expect((await listLinks(tx, { workspaceId: WS_A.id, keyResultId: "kr-a", limit: 10 })).items[0]).toMatchObject({ solutionId: "sol-a", solutionTitle: "A solution" });
  });
});

describe("updatedAt: a key result edit is an edit (recency sort and the expectedUpdatedAt check depend on it)", () => {
  it("setOpportunityKeyResult bumps updatedAt, records updatedById for a human, and invalidates a stale expectedUpdatedAt", async () => {
    const { fake, tx } = setup();
    const row = opp(fake, "opp-a") as Record<string, unknown>;
    const before = new Date(1_000);
    row.updatedAt = before;
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx: { source: "UI", createdById: "user-alice" } });
    expect((row.updatedAt as Date).getTime()).toBeGreaterThan(before.getTime());
    expect(row.updatedById).toBe("user-alice");
    // The optimistic check updateOpportunity makes (where updatedAt = the value the caller read) now refuses the stale read.
    await expect(fake.client.opportunity.update({ where: { id: "opp-a", updatedAt: before }, data: { title: "stale write" } })).rejects.toThrow(/not found/i);
    await expect(fake.client.opportunity.update({ where: { id: "opp-a", updatedAt: row.updatedAt as Date }, data: { title: "fresh write" } })).resolves.toBeTruthy();
  });

  it("a clear bumps it too, and an agent (no createdById) does not write updatedById", async () => {
    const { fake, tx } = setup();
    const row = opp(fake, "opp-a") as Record<string, unknown>;
    row.updatedAt = new Date(1_000);
    await setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: null, ctx });
    expect((row.updatedAt as Date).getTime()).toBeGreaterThan(1_000);
    expect("updatedById" in row).toBe(false);
  });

  it("unlink touches the opportunity row (so its read of the pointer is in the write set) only when a link exists", async () => {
    const { fake, tx, links } = setup();
    const row = opp(fake, "opp-a") as Record<string, unknown>;
    row.updatedAt = new Date(1_000);
    await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" });
    expect((row.updatedAt as Date).getTime()).toBe(1_000);
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    await unlinkOpportunityFromObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a" });
    expect((row.updatedAt as Date).getTime()).toBeGreaterThan(1_000);
  });

  it("link/unlink of a solution touches neither the solution row nor its opportunity", async () => {
    const { fake, tx } = setup();
    const mark = fake.state.writes.length;
    await linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx });
    await unlinkSolutionFromKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a" });
    expect(fake.state.writes.slice(mark).filter((w) => /^(solution|opportunity)\./.test(w))).toEqual([]);
  });
});

describe("a missing link table FAILS LOUDLY: reads, writes, deletes and the tools all propagate the database error", () => {
  const missing = (code: string) => Object.assign(new Error('relation "opportunity_objective_links" does not exist'), { code });
  const withMissingTable = (error: unknown) => {
    const { fake, tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    for (const model of ["opportunityObjectiveLink", "solutionKeyResultLink"] as const) {
      const delegate = fake.client[model] as unknown as Record<string, () => Promise<never>>;
      for (const op of ["findMany", "findFirst", "create", "update", "deleteMany"]) delegate[op] = async () => { throw error };
    }
    return { fake, tx };
  };

  it.each([
    ["Prisma P2021", missing("P2021")],
    ["Postgres 42P01 on the error", missing("42P01")],
    ["Postgres 42P01 on the cause", Object.assign(new Error("query failed"), { cause: { originalCode: "42P01" } })],
    ["driver adapter metadata", Object.assign(new Error("query failed"), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "42P01" } } } })],
    ["a code-less 'relation does not exist' message", new Error('relation "solution_key_result_links" does not exist')],
  ])("both batch read helpers THROW the original error (%s), with no 'no links' fallback and no warning", async (_n, error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx } = withMissingTable(error);
    await expect(getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"])).rejects.toBe(error);
    await expect(getLinkedKeyResultsBySolution(tx, WS_A.id, ["sol-a"])).rejects.toBe(error);
    await expect(getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"], { preverified: true })).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("any other read error throws too", async () => {
    const { tx } = withMissingTable(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    await expect(getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"])).rejects.toThrow("connection reset");
    await expect(getLinkedKeyResultsBySolution(tx, WS_A.id, ["sol-a"])).rejects.toThrow("connection reset");
  });

  it("writes, deletes, the drain and list_links fail on a missing table as well", async () => {
    const { tx } = withMissingTable(missing("P2021"));
    await expect(linkOpportunityToObjective(tx, { opportunityId: "opp-a", objectiveId: "obj-a", ctx })).rejects.toThrow(/does not exist/);
    await expect(linkSolutionToKeyResult(tx, { solutionId: "sol-a", keyResultId: "kr-a", ctx })).rejects.toThrow(/does not exist/);
    await expect(setOpportunityKeyResult(tx, { opportunityId: "opp-a", keyResultId: "kr-a", ctx })).rejects.toThrow(/does not exist/);
    await expect(deleteLinksFor(tx, "objective", ["obj-a"])).rejects.toThrow(/does not exist/);
    await expect(drainLinksFor(tx, "objective", ["obj-a"])).rejects.toThrow(/does not exist/);
    await expect(listLinks(tx, { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 5 })).rejects.toThrow(/does not exist/);
  });

  it("the module has no tolerant-read machinery left", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/typed-links.ts"), "utf8");
    expect(source).not.toMatch(/tolerantLinkRead|isMissingLinkTable|read_degraded|resetMissingLinkTableWarning/);
  });

  it("preverified skips the workspace re-check query", async () => {
    const { fake, tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    const spy = vi.spyOn(fake.client.opportunity, "findMany");
    expect((await getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"], { preverified: true })).get("opp-a")).toEqual([{ id: "obj-a", title: "A objective" }]);
    expect(spy).not.toHaveBeenCalled();
    await getLinkedObjectivesByOpportunity(tx, WS_A.id, ["opp-a"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("draining a parent with many links", () => {
  it("drainLinksFor deletes by LINK id in passes of at most 500 links, however many one parent holds", async () => {
    const { fake, tx, links } = setup();
    for (let i = 0; i < 1_203; i += 1) seedLink(links, { workspaceId: WS_A.id, opportunityId: `o${i}`, objectiveId: "obj-a", origin: "LEGACY" });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "keep", objectiveId: "obj-a2", origin: "DIRECT" });
    const spy = vi.spyOn(fake.client.opportunityObjectiveLink, "deleteMany");
    expect(await drainLinksFor(tx, "objective", ["obj-a"])).toBe(1_203);
    expect(links.map((l) => l.opportunityId)).toEqual(["keep"]);
    expect(spy.mock.calls.map(([args]) => ((args as { where: { id: { in: string[] } } }).where.id.in).length)).toEqual([500, 500, 203]);
    expect(await drainLinksFor(tx, "objective", ["obj-a"])).toBe(0);
  });

  it("drainLegacyLinksForOpportunities drains only LEGACY links", async () => {
    const { tx, links } = setup();
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" });
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "DIRECT" });
    expect(await drainLegacyLinksForOpportunities(tx, ["opp-a"])).toBe(1);
    expect(links.map((l) => l.origin)).toEqual(["DIRECT"]);
  });
});

describe("drain robustness", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))

  it("a delete that removes nothing is re-checked: the loop ends when a FIND is empty (a concurrent drain took the rows), no spurious error", async () => {
    const { tx, fake } = setup()
    let finds = 0
    const delegate = fake.client.opportunityObjectiveLink as unknown as { findMany: unknown; deleteMany: unknown }
    delegate.findMany = async () => (finds++ === 0 ? ids(3) : [])
    delegate.deleteMany = async () => ({ count: 0 })
    await expect(drainLinksFor(tx, "objective", ["obj-a"])).resolves.toBe(0)
    expect(finds).toBe(2)
  })

  it("repeated stalls (rows keep appearing, none deletable) still end in an error rather than looping", async () => {
    const { tx, fake } = setup()
    const delegate = fake.client.opportunityObjectiveLink as unknown as { findMany: unknown; deleteMany: unknown }
    delegate.findMany = async () => ids(3)
    delegate.deleteMany = async () => ({ count: 0 })
    await expect(drainLinksFor(tx, "objective", ["obj-a"])).rejects.toThrow("Link delete made no progress")
  })

  it("a runaway drain stops at the pass cap", async () => {
    const { tx, fake } = setup()
    const delegate = fake.client.opportunityObjectiveLink as unknown as { findMany: unknown; deleteMany: unknown }
    delegate.findMany = async () => ids(1)
    delegate.deleteMany = async () => ({ count: 1 })
    await expect(drainLinksFor(tx, "objective", ["obj-a"])).rejects.toThrow("pass cap")
  })

  it("drainAfterParentDelete returns the count on success and swallows and logs a failure without row data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await drainAfterParentDelete("t", async () => 7)).toEqual({ removed: 7, failed: false })
    const failed = await drainAfterParentDelete("t", async () => { throw new Error("secret-id-123 broke") })
    expect(failed).toEqual({ removed: 0, failed: true })
    expect(String(log.mock.calls[0][0])).not.toContain("secret-id-123")
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "typed_links.cleanup_failed", surface: "t" })
    log.mockRestore()
  })

  it("the legacy drain with an objective id only takes the link the deleted key result implied", async () => {
    const { tx, links } = setup()
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" })
    seedLink(links, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "LEGACY" })
    expect(await drainLegacyLinksForOpportunities(tx, ["opp-a"], "obj-a")).toBe(1)
    expect(links.map((l) => l.objectiveId)).toEqual(["obj-a2"])
  })
})
