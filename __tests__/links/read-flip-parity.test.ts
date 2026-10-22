/**
 * Read-flip parity (PR B): every flipped reader, run with its family flag "off" and then "on" over the SAME seeded fake data (legacy tables
 * AND entity_links hold the same links), must return the same shape, ordering and filtering. Workspace scoping (workspace B rows, NULL-workspace
 * rows) and dangling / archived / non-tracked targets are seeded so a missing filter on either side shows up as a diff.
 *
 * Where "on" intentionally filters MORE than the legacy reader (dangling targets, non-TRACKED decisions: the caller applied those rules
 * itself), the cases are asserted explicitly in "documented differences" instead of being hidden in a loose comparison.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

import { getArtifactDecisions, getArtifactSolutionIds, getDecisionArtifacts, getSolutionArtifactIds } from "@/lib/artifacts";
import { getReadCompareCounters, resetReadCompareCounters } from "@/lib/links/read-compare";
import { LINK_READ_FLAG_NAMES } from "@/lib/links/read-mode";
import { getCanvasLinkRows, getLinkedKeyResultsBySolution, getLinkedObjectivesByOpportunity, getLinkedSolutionsByKeyResult, getOpportunityKeyResultPointers } from "@/lib/typed-links";
import type { AppTransactionClient } from "@/lib/db";

const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state as unknown as Record<string, Row[]>;
let clock = 0;
const at = () => new Date(10_000 + ++clock);

/** Run a reader with one family flag off and then on; the flag is always restored. */
async function offAndOn<T>(family: keyof typeof LINK_READ_FLAG_NAMES, read: () => Promise<T>): Promise<{ off: T; on: T }> {
  vi.stubEnv(LINK_READ_FLAG_NAMES[family], "off");
  const off = await read();
  vi.stubEnv(LINK_READ_FLAG_NAMES[family], "on");
  const on = await read();
  vi.unstubAllEnvs();
  return { off, on };
}
/** Maps compare as ordered entries so a key-order or per-key list-order difference fails, not just set equality. */
const entries = <V>(map: Map<string, V>) => [...map.entries()];

// ── seeding: each link is written to the legacy table AND entity_links with the same createdAt, like the dual-writing writers ───────────
const mirror = (linkType: string, fromType: string, fromId: string, toType: string, toId: string, createdAt: Date, extra: Row = {}, workspaceId: string = WS_A.id) =>
  state().entityLinks.push({ id: `el-${state().entityLinks.length + 1}`, workspaceId, linkType, fromType, fromId, toType, toId, origin: "DIRECT", source: "UI", createdById: null, createdAt, updatedAt: createdAt, ...extra });
const solutionKr = (solutionId: string, keyResultId: string, opts: { createdAt?: Date; id?: string; workspaceId?: string } = {}) => {
  const createdAt = opts.createdAt ?? at();
  state().solutionKeyResultLinks.push({ id: opts.id ?? `skr-${state().solutionKeyResultLinks.length + 1}`, workspaceId: opts.workspaceId ?? WS_A.id, solutionId, keyResultId, source: "UI", createdById: null, createdAt });
  mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", solutionId, "KEY_RESULT", keyResultId, createdAt, { id: `el-skr-${opts.id ?? state().entityLinks.length + 1}` }, opts.workspaceId ?? WS_A.id);
};
const oppObj = (opportunityId: string, objectiveId: string, origin: "DIRECT" | "LEGACY" = "DIRECT", opts: { createdAt?: Date; id?: string; workspaceId?: string } = {}) => {
  const createdAt = opts.createdAt ?? at();
  state().opportunityObjectiveLinks.push({ id: opts.id ?? `oo-${state().opportunityObjectiveLinks.length + 1}`, workspaceId: opts.workspaceId ?? WS_A.id, opportunityId, objectiveId, origin, source: "UI", createdById: null, createdAt });
  mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", opportunityId, "OBJECTIVE", objectiveId, createdAt, { origin, id: `el-oo-${opts.id ?? state().entityLinks.length + 1}` }, opts.workspaceId ?? WS_A.id);
};
const artifactLink = (artifactId: string, linkedType: "SOLUTION" | "REVIEW_REQUEST", linkedId: string, workspaceId: string = WS_A.id) => {
  const createdAt = at();
  state().artifactLinks.push({ id: `al-${state().artifactLinks.length + 1}`, workspaceId, artifactId, linkedType, linkedId, source: "UI", createdById: null, createdAt });
  mirror(linkedType === "SOLUTION" ? "ARTIFACT_ATTACHED_TO_SOLUTION" : "ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", artifactId, linkedType, linkedId, createdAt, {}, workspaceId);
};

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  resetReadCompareCounters();
  // Extra live workspace-A rows so ordering / multi-row cases are meaningful.
  state().solutions.push({ id: "sol-a2", workspaceId: WS_A.id, opportunityId: "opp-a", title: "A solution 2", status: "IDEA", sortOrder: 1, createdAt: new Date(2), updatedAt: new Date(2) });
  state().objectives.push(
    { id: "obj-a2", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 2", status: "ON_TRACK", sortOrder: 1 },
    { id: "obj-a3", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 3", status: "ON_TRACK", sortOrder: 2 },
  );
  state().keyResults.push(
    { id: "kr-a2", objectiveId: "obj-a2", title: "A key result 2", target: 10, current: 0, sortOrder: 1 },
    { id: "kr-a3", objectiveId: "obj-a3", title: "A key result 3", target: 10, current: 0, sortOrder: 2 },
  );
  state().opportunities.push({ id: "opp-a2", workspaceId: WS_A.id, title: "A opportunity 2", status: "EXPLORING", squadId: "squad-a", linkedKeyResultId: null, sortOrder: 1, createdAt: new Date(2) });
});
afterEach(() => vi.unstubAllEnvs());

describe("SOLUTION_KR: getLinkedKeyResultsBySolution / getLinkedSolutionsByKeyResult / canvas solution half", () => {
  beforeEach(() => {
    // Insert order differs from id order so an ordering bug (id-only, or unordered) shows up; kr-a3 and kr-a2 share a createdAt to exercise the id tie-break.
    const tie = new Date(5_000);
    solutionKr("sol-a", "kr-a3", { createdAt: tie, id: "skr-z" });
    solutionKr("sol-a", "kr-a2", { createdAt: tie, id: "skr-y" });
    solutionKr("sol-a", "kr-a"); // later createdAt
    solutionKr("sol-a2", "kr-a2");
    solutionKr("sol-a", "kr-gone"); // dangling target
    solutionKr("sol-a", "kr-b"); // cross-workspace target
    solutionKr("sol-a", "kr-null"); // KR under an unbackfilled (NULL workspace) objective
    solutionKr("sol-null", "kr-a"); // unbackfilled solution
    solutionKr("sol-b", "kr-b", { workspaceId: WS_B.id });
  });

  it("solution -> key results: same entries, same per-solution ordering, dangling / foreign / NULL-workspace targets excluded", async () => {
    const ids = ["sol-a", "sol-a2", "sol-null", "sol-b", "sol-missing"];
    const { off, on } = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_A.id, ids));
    expect(off.get("sol-a")!.length).toBeGreaterThan(1); // not vacuous
    expect(entries(on)).toEqual(entries(off));
    expect(on.get("sol-a")!.map((kr) => kr.id)).toEqual(["kr-a2", "kr-a3", "kr-a"]);
    expect(on.has("sol-b")).toBe(false); // other workspace's solution is absent, not empty
    expect(on.has("sol-null")).toBe(false);
  });

  it("preverified: same result with the verification query skipped", async () => {
    const { off, on } = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a", "sol-a2"], { preverified: true }));
    expect(entries(on)).toEqual(entries(off));
  });

  it("a solution with no links is present with an empty list in both modes", async () => {
    state().solutions.push({ id: "sol-a3", workspaceId: WS_A.id, opportunityId: "opp-a", title: "A solution 3", status: "IDEA", sortOrder: 2, createdAt: new Date(3), updatedAt: new Date(3) });
    const { off, on } = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a3"]));
    expect(entries(on)).toEqual(entries(off));
    expect(on.get("sol-a3")).toEqual([]);
  });

  it("empty and duplicate input ids", async () => {
    const empty = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_A.id, []));
    expect(entries(empty.on)).toEqual(entries(empty.off));
    const dup = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a", "sol-a"]));
    expect(entries(dup.on)).toEqual(entries(dup.off));
  });

  it("a workspace B caller never sees workspace A links, and vice versa", async () => {
    const { off, on } = await offAndOn("SOLUTION_KR", () => getLinkedKeyResultsBySolution(tx(), WS_B.id, ["sol-a", "sol-b"]));
    expect(entries(on)).toEqual(entries(off));
    expect(on.get("sol-b")!.map((kr) => kr.id)).toEqual(["kr-b"]);
    expect(on.has("sol-a")).toBe(false);
  });

  it("key result -> solutions: same entries and ordering, dangling / foreign / NULL-workspace solutions excluded", async () => {
    const { off, on } = await offAndOn("SOLUTION_KR", () => getLinkedSolutionsByKeyResult(tx(), WS_A.id, ["kr-a", "kr-a2", "kr-a3", "kr-b", "kr-null", "kr-gone"]));
    expect(off.get("kr-a2")!.length).toBe(2); // not vacuous
    expect(entries(on)).toEqual(entries(off));
    expect(on.has("kr-b")).toBe(false);
    expect(on.has("kr-null")).toBe(false);
  });

  it("canvas solution half: identical rows when only SOLUTION_KR is on (opportunity half stays legacy)", async () => {
    const input = { opportunityIds: ["opp-a"], solutionIds: ["sol-a", "sol-a2", "sol-b", "sol-null"], origins: "ALL" as const };
    const { off, on } = await offAndOn("SOLUTION_KR", () => getCanvasLinkRows(tx(), WS_A.id, input));
    // The legacy canvas reader returns raw rows (the canvas keeps an edge only when both endpoints are nodes it loaded); "on" is liveness-filtered.
    const liveSolutions = new Set(["sol-a", "sol-a2"]);
    const liveKeyResults = new Set(["kr-a", "kr-a2", "kr-a3"]);
    const canvasView = (rows: typeof off.solutionKeyResult) => rows.filter((r) => liveSolutions.has(r.solutionId) && liveKeyResults.has(r.keyResultId));
    expect(canvasView(off.solutionKeyResult).length).toBeGreaterThan(1);
    expect(canvasView(on.solutionKeyResult)).toEqual(canvasView(off.solutionKeyResult));
    expect(on.solutionKeyResult.every((r) => liveSolutions.has(r.solutionId) && liveKeyResults.has(r.keyResultId))).toBe(true);
    expect(on.opportunityObjective).toEqual(off.opportunityObjective);
  });
});

describe("OPPORTUNITY: getLinkedObjectivesByOpportunity / canvas opportunity half / getOpportunityKeyResultPointers", () => {
  beforeEach(() => {
    const tie = new Date(5_000);
    oppObj("opp-a", "obj-a3", "DIRECT", { createdAt: tie, id: "oo-z" });
    oppObj("opp-a", "obj-a2", "LEGACY", { createdAt: tie, id: "oo-y" });
    oppObj("opp-a", "obj-a", "DIRECT");
    oppObj("opp-a2", "obj-a2", "DIRECT");
    oppObj("opp-a", "obj-gone", "DIRECT"); // dangling
    oppObj("opp-a", "obj-b", "DIRECT"); // cross-workspace
    oppObj("opp-a", "obj-null", "LEGACY"); // NULL-workspace objective
    oppObj("opp-b", "obj-b", "DIRECT", { workspaceId: WS_B.id });
  });

  it("opportunity -> objectives: same entries and ordering; dangling / foreign / NULL-workspace objectives excluded", async () => {
    const ids = ["opp-a", "opp-a2", "opp-b", "opp-missing"];
    const { off, on } = await offAndOn("OPPORTUNITY", () => getLinkedObjectivesByOpportunity(tx(), WS_A.id, ids));
    expect(off.get("opp-a")!.length).toBeGreaterThan(1);
    expect(entries(on)).toEqual(entries(off));
    expect(on.get("opp-a")!.map((o) => o.id)).toEqual(["obj-a2", "obj-a3", "obj-a"]);
    expect(on.has("opp-b")).toBe(false);
  });

  it("preverified, empty input and a workspace B caller", async () => {
    for (const args of [
      [WS_A.id, ["opp-a"], { preverified: true }],
      [WS_A.id, [], {}],
      [WS_B.id, ["opp-a", "opp-b"], {}],
    ] as const) {
      const { off, on } = await offAndOn("OPPORTUNITY", () => getLinkedObjectivesByOpportunity(tx(), args[0], args[1], args[2]));
      expect(entries(on)).toEqual(entries(off));
    }
  });

  it.each(["ALL", "DIRECT"] as const)("canvas opportunity half with origins=%s: same rows including origin; dangling / foreign targets dropped", async (origins) => {
    // Legacy canvas reader returns the raw rows (the canvas drops unknown nodes itself); the on path is liveness-filtered, so compare after
    // the same node filter the canvas applies: both endpoints must be nodes it loaded.
    const input = { opportunityIds: ["opp-a", "opp-a2"], solutionIds: [], origins };
    const { off, on } = await offAndOn("OPPORTUNITY", () => getCanvasLinkRows(tx(), WS_A.id, input));
    const liveObjectives = new Set(["obj-a", "obj-a2", "obj-a3"]);
    const canvasView = (rows: typeof off.opportunityObjective) => rows.filter((r) => liveObjectives.has(r.objectiveId));
    expect(canvasView(off.opportunityObjective).length).toBeGreaterThan(0);
    expect(canvasView(on.opportunityObjective)).toEqual(canvasView(off.opportunityObjective));
    expect(on.opportunityObjective.every((r) => liveObjectives.has(r.objectiveId))).toBe(true);
    if (origins === "DIRECT") expect(on.opportunityObjective.every((r) => r.origin === "DIRECT")).toBe(true);
    expect(on.solutionKeyResult).toEqual(off.solutionKeyResult);
  });

  it("both families on: canvas returns each half from entity_links", async () => {
    solutionKr("sol-a", "kr-a");
    const input = { opportunityIds: ["opp-a"], solutionIds: ["sol-a"], origins: "ALL" as const };
    const off = await getCanvasLinkRows(tx(), WS_A.id, input);
    vi.stubEnv(LINK_READ_FLAG_NAMES.OPPORTUNITY, "on");
    vi.stubEnv(LINK_READ_FLAG_NAMES.SOLUTION_KR, "on");
    const on = await getCanvasLinkRows(tx(), WS_A.id, input);
    expect(on.solutionKeyResult).toEqual(off.solutionKeyResult);
    expect(on.opportunityObjective.map((r) => r.objectiveId)).toEqual(["obj-a2", "obj-a3", "obj-a"]);
  });

  describe("getOpportunityKeyResultPointers", () => {
    const ptr = (opportunityId: string, keyResultId: string, workspaceId: string = WS_A.id) => {
      const createdAt = at();
      const opp = state().opportunities.find((o) => o.id === opportunityId)!;
      opp.linkedKeyResultId = keyResultId;
      mirror("OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", opportunityId, "KEY_RESULT", keyResultId, createdAt, { origin: "LEGACY" }, workspaceId);
    };
    const rows = () => ["opp-a", "opp-a2", "opp-b"].map((id) => ({ id, linkedKeyResultId: (state().opportunities.find((o) => o.id === id)!.linkedKeyResultId as string | null) }));

    it("live pointers map identically (same key order, null for unset)", async () => {
      ptr("opp-a", "kr-a");
      const { off, on } = await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_A.id, rows().slice(0, 2)));
      expect(entries(off)).toEqual([["opp-a", "kr-a"], ["opp-a2", null]]);
      expect(entries(on)).toEqual(entries(off));
    });

    it("all unset: every opportunity maps to null in both modes", async () => {
      const { off, on } = await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_A.id, rows().slice(0, 2)));
      expect(entries(on)).toEqual(entries(off));
      expect([...on.values()]).toEqual([null, null]);
    });

    it("empty input", async () => {
      const { off, on } = await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_A.id, []));
      expect(entries(on)).toEqual(entries(off));
    });

    it("a pointer into another workspace or an unbackfilled objective's key result is not served on", async () => {
      ptr("opp-a", "kr-b");
      ptr("opp-a2", "kr-null");
      const on = (await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_A.id, rows().slice(0, 2)))).on;
      expect(entries(on)).toEqual([["opp-a", null], ["opp-a2", null]]);
    });

    it("a workspace A mirror row is invisible to a workspace B caller", async () => {
      ptr("opp-a", "kr-a");
      const { off, on } = await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_B.id, [{ id: "opp-b", linkedKeyResultId: null }]));
      expect(entries(on)).toEqual(entries(off));
    });
  });
});

describe("ARTIFACT: getArtifactSolutionIds / getSolutionArtifactIds / getDecisionArtifacts / getArtifactDecisions", () => {
  beforeEach(() => {
    artifactLink("art-a", "SOLUTION", "sol-a2");
    artifactLink("art-a", "SOLUTION", "sol-a");
    artifactLink("art-a2", "SOLUTION", "sol-a");
    artifactLink("art-a-archived", "SOLUTION", "sol-a");
    artifactLink("art-b", "SOLUTION", "sol-b", WS_B.id);
    artifactLink("art-a", "REVIEW_REQUEST", "rr-a");
    artifactLink("art-a2", "REVIEW_REQUEST", "rr-a");
    artifactLink("art-a-archived", "REVIEW_REQUEST", "rr-a");
    artifactLink("art-b", "REVIEW_REQUEST", "rr-b", WS_B.id);
  });

  it("getArtifactSolutionIds: same ids in the same order; other workspace's links absent", async () => {
    const { off, on } = await offAndOn("ARTIFACT", () => getArtifactSolutionIds(tx(), WS_A.id, "art-a"));
    expect(off).toEqual(["sol-a2", "sol-a"]);
    expect(on).toEqual(off);
    const foreign = await offAndOn("ARTIFACT", () => getArtifactSolutionIds(tx(), WS_A.id, "art-b"));
    expect(foreign.off).toEqual([]);
    expect(foreign.on).toEqual([]);
  });

  it("getSolutionArtifactIds: same ids in the same order, archived artifacts included in both", async () => {
    const { off, on } = await offAndOn("ARTIFACT", () => getSolutionArtifactIds(tx(), WS_A.id, "sol-a"));
    expect(off).toEqual(["art-a", "art-a2", "art-a-archived"]);
    expect(on).toEqual(off);
    const foreign = await offAndOn("ARTIFACT", () => getSolutionArtifactIds(tx(), WS_A.id, "sol-b"));
    expect(foreign.on).toEqual(foreign.off);
    expect(foreign.on).toEqual([]);
  });

  it("getDecisionArtifacts: same rows and (title, id) ordering for a TRACKED decision", async () => {
    const { off, on } = await offAndOn("ARTIFACT", () => getDecisionArtifacts(WS_A.id, "rr-a"));
    expect(off.length).toBe(3);
    expect(on).toEqual(off);
    expect(on.map((a) => a.title)).toEqual([...on.map((a) => a.title)].sort());
  });

  it("getDecisionArtifacts: other workspace's decision yields nothing in both modes", async () => {
    const { off, on } = await offAndOn("ARTIFACT", () => getDecisionArtifacts(WS_A.id, "rr-b"));
    expect(off).toEqual([]);
    expect(on).toEqual([]);
  });

  it("getArtifactDecisions: same decisions, titles and states; non-TRACKED and foreign review requests excluded in both", async () => {
    artifactLink("art-a", "REVIEW_REQUEST", "rr-a-system"); // PRODUCT_LAUNCH gate: legacy reader excludes it via gateType too
    artifactLink("art-a", "REVIEW_REQUEST", "rr-gone"); // dangling
    const { off, on } = await offAndOn("ARTIFACT", () => getArtifactDecisions(WS_A.id, "art-a"));
    expect(off.map((d) => d.id)).toEqual(["rr-a"]);
    expect(on).toEqual(off);
  });

  it("getArtifactDecisions: an artifact with no decision links returns [] in both modes", async () => {
    const { off, on } = await offAndOn("ARTIFACT", () => getArtifactDecisions(WS_A.id, "art-b"));
    expect(off).toEqual([]);
    expect(on).toEqual([]);
  });

  it("ARTIFACT flag only affects the artifact family: SOLUTION_KR reads stay legacy", async () => {
    solutionKr("sol-a", "kr-a");
    state().entityLinks.length = 0; // entity_links empty; legacy has the link
    vi.stubEnv(LINK_READ_FLAG_NAMES.ARTIFACT, "on");
    expect((await getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a"])).get("sol-a")).toHaveLength(1);
  });
});

describe("documented differences: on is stricter than legacy where the caller already filtered", () => {
  it("getArtifactSolutionIds / getSolutionArtifactIds: dangling and foreign targets are legacy-only (callers resolve membership themselves)", async () => {
    artifactLink("art-a", "SOLUTION", "sol-a");
    artifactLink("art-a", "SOLUTION", "sol-gone");
    artifactLink("art-a", "SOLUTION", "sol-b");
    const { off, on } = await offAndOn("ARTIFACT", () => getArtifactSolutionIds(tx(), WS_A.id, "art-a"));
    expect(off).toEqual(["sol-a", "sol-gone", "sol-b"]);
    expect(on).toEqual(["sol-a"]);
  });

  it("getDecisionArtifacts: a non-TRACKED review request's artifacts are legacy-only (callers only ask for TRACKED_DECISION)", async () => {
    artifactLink("art-a", "REVIEW_REQUEST", "rr-a-system");
    const { off, on } = await offAndOn("ARTIFACT", () => getDecisionArtifacts(WS_A.id, "rr-a-system"));
    expect(off.map((a) => a.id)).toEqual(["art-a"]);
    expect(on).toEqual([]);
  });

  it("getOpportunityKeyResultPointers: a dangling column value is served by off, null on", async () => {
    (state().opportunities.find((o) => o.id === "opp-a")!).linkedKeyResultId = "kr-gone";
    state().entityLinks.push({ id: "el-x", workspaceId: WS_A.id, linkType: "OPPORTUNITY_TARGETS_KEY_RESULT", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "KEY_RESULT", toId: "kr-gone", origin: "LEGACY", source: "UI", createdById: null, createdAt: at(), updatedAt: at() });
    const { off, on } = await offAndOn("OPPORTUNITY", () => getOpportunityKeyResultPointers(tx(), WS_A.id, [{ id: "opp-a", linkedKeyResultId: "kr-gone" }]));
    expect(off.get("opp-a")).toBe("kr-gone");
    expect(on.get("opp-a")).toBeNull();
  });
});

describe("failure fallback through the real readers", () => {
  it("on + entity_links failing: the legacy result is served and the error counted", async () => {
    solutionKr("sol-a", "kr-a");
    vi.stubEnv(LINK_READ_FLAG_NAMES.SOLUTION_KR, "on");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fake.current!.client as unknown as { entityLink: { findMany: (...a: unknown[]) => Promise<unknown> } };
    const original = client.entityLink.findMany;
    client.entityLink.findMany = async () => { throw new Error("entity_links unavailable") };
    const result = await getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a"]);
    client.entityLink.findMany = original;
    expect(result.get("sol-a")!.map((kr) => kr.id)).toEqual(["kr-a"]);
    expect(getReadCompareCounters().SOLUTION_KR.errors).toBe(1);
    warn.mockRestore();
  });

  it("shadow: result equals off even when entity_links disagrees or throws", async () => {
    solutionKr("sol-a", "kr-a");
    state().entityLinks.length = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = await getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a"]);
    vi.stubEnv(LINK_READ_FLAG_NAMES.SOLUTION_KR, "shadow");
    const shadow = await getLinkedKeyResultsBySolution(tx(), WS_A.id, ["sol-a"]);
    expect(entries(shadow)).toEqual(entries(off));
    expect(getReadCompareCounters().SOLUTION_KR.mismatches).toBe(1);
    warn.mockRestore();
  });
});
