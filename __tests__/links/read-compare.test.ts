/**
 * Read-flip parity (PR A): seeds BOTH the legacy tables and entity_links, then diffs what the legacy readers return against what the
 * entity_links readers return, per family. The cases are the ones the flip must survive: a dangling endpoint, a cross-workspace row,
 * drift in either direction, origin drift (Opportunity-Objective), the DECISION <-> REVIEW_REQUEST alias, and COMMENT task links
 * (legacy-only, excluded). Nothing here is wired to a production read path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

import { getArtifactDecisions } from "@/lib/artifacts";
import {
  compareFamilyRead,
  compareLinks,
  getReadCompareCounters,
  legacyArtifactLinks,
  legacyOpportunityKeyResultPointers,
  legacyOpportunityObjectivePairs,
  legacySolutionKeyResultPairs,
  legacyTaskReferences,
  readEntityLinksArtifact,
  readEntityLinksOpportunityKeyResultPointer,
  readEntityLinksOpportunityObjective,
  readEntityLinksSolutionKeyResult,
  readEntityLinksTaskReferences,
  recordReadCompare,
  resetReadCompareCounters,
  retainLiveEndpoints,
  type ComparableLink,
} from "@/lib/links/read-compare";
import { getCanvasLinkRows, getLinkedKeyResultsBySolution, getLinkedSolutionsByKeyResult } from "@/lib/typed-links";
import type { AppTransactionClient } from "@/lib/db";

const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state as unknown as Record<string, Row[]>;
let clock = 0;
const at = () => new Date(10_000 + ++clock);

/** The tenant fake has no task or doc rows; a minimal delegate is enough for endpoint resolution. */
function addTasks() {
  const tasks: Row[] = [
    { id: "task-a", workspaceId: WS_A.id, title: "A task" },
    { id: "task-a2", workspaceId: WS_A.id, title: "A task 2" },
    { id: "task-b", workspaceId: WS_B.id, title: "B task" },
  ];
  const inList = (cond: unknown, value: unknown) => (cond && typeof cond === "object" && "in" in (cond as Row) ? ((cond as { in: unknown[] }).in).includes(value) : cond === undefined || cond === value);
  Object.assign(fake.current!.client, {
    task: { findMany: async ({ where }: { where: Row }) => tasks.filter((row) => inList(where.id, row.id) && inList(where.workspaceId, row.workspaceId)).map(({ id, title }) => ({ id, title })) },
  });
  return tasks;
}

const mirror = (linkType: string, fromType: string, fromId: string, toType: string, toId: string, extra: Row = {}, workspaceId: string = WS_A.id) =>
  state().entityLinks.push({ id: `el-${state().entityLinks.length + 1}`, workspaceId, linkType, fromType, fromId, toType, toId, origin: "DIRECT", source: "UI", createdById: null, createdAt: at(), updatedAt: at(), ...extra });
const legacySolutionKr = (solutionId: string, keyResultId: string, workspaceId: string = WS_A.id) =>
  state().solutionKeyResultLinks.push({ id: `skr-${state().solutionKeyResultLinks.length + 1}`, workspaceId, solutionId, keyResultId, source: "UI", createdById: null, createdAt: at() });
const legacyOppObj = (opportunityId: string, objectiveId: string, origin: "DIRECT" | "LEGACY" = "DIRECT", workspaceId: string = WS_A.id) =>
  state().opportunityObjectiveLinks.push({ id: `oo-${state().opportunityObjectiveLinks.length + 1}`, workspaceId, opportunityId, objectiveId, origin, source: "UI", createdById: null, createdAt: at() });
const legacyArtifact = (artifactId: string, linkedType: string, linkedId: string, workspaceId: string = WS_A.id) =>
  state().artifactLinks.push({ id: `al-${state().artifactLinks.length + 1}`, workspaceId, artifactId, linkedType, linkedId, source: "UI", createdById: null, createdAt: at() });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  resetReadCompareCounters();
});
afterEach(() => vi.unstubAllEnvs());

describe("compareLinks", () => {
  const link = (fromId: string, toId: string, origin?: "DIRECT" | "LEGACY"): ComparableLink => ({ linkType: "T", fromType: "SOLUTION", fromId, toType: "KEY_RESULT", toId, origin });

  it("equal sets match regardless of order and duplicates", () => {
    const result = compareLinks("SOLUTION_KR", [link("a", "1"), link("b", "2"), link("a", "1")], [link("b", "2"), link("a", "1")]);
    expect(result).toMatchObject({ ok: true, matched: 2, onlyLegacy: 0, onlyEntityLinks: 0, originDrift: 0, legacyCount: 2, entityLinksCount: 2 });
  });

  it("reports each class with counts and capped pair ids only", () => {
    const legacy = Array.from({ length: 30 }, (_, i) => link(`l${i}`, "x"));
    const result = compareLinks("SOLUTION_KR", [...legacy, link("both", "y", "DIRECT")], [link("extra", "z"), link("both", "y", "LEGACY")]);
    expect(result).toMatchObject({ ok: false, onlyLegacy: 30, onlyEntityLinks: 1, originDrift: 1, matched: 0 });
    expect(result.ids.onlyLegacy).toHaveLength(20);
    expect(result.ids.onlyEntityLinks).toEqual(["extra>z"]);
    expect(result.ids.originDrift).toEqual(["both>y"]);
    expect(JSON.stringify(result)).not.toMatch(/title|content/i);
  });

  it("an origin is compared only when both sides carry one", () => {
    expect(compareLinks("OPPORTUNITY", [link("a", "1", "DIRECT")], [link("a", "1")]).ok).toBe(true);
  });
});

describe("Solution <-> Key Result parity", () => {
  const legacy = async (solutionIds: string[]) => legacySolutionKeyResultPairs([...(await getLinkedKeyResultsBySolution(tx(), WS_A.id, solutionIds)).entries()].flatMap(([solutionId, krs]) => krs.map((kr) => ({ solutionId, keyResultId: kr.id }))));

  it("matches when both tables hold the same live links, and dangling / cross-workspace rows are absent on both sides", async () => {
    legacySolutionKr("sol-a", "kr-a"); mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-a");
    legacySolutionKr("sol-a", "kr-gone"); mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-gone");
    legacySolutionKr("sol-a", "kr-b"); mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-b");
    legacySolutionKr("sol-a", "kr-null"); mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-null");
    const result = compareLinks("SOLUTION_KR", await legacy(["sol-a"]), await readEntityLinksSolutionKeyResult(tx(), WS_A.id, { solutionIds: ["sol-a"] }));
    expect(result).toMatchObject({ ok: true, matched: 1, legacyCount: 1, entityLinksCount: 1 });
  });

  it("drift: a legacy-only row and a mirror-only row are each reported", async () => {
    legacySolutionKr("sol-a", "kr-a"); // legacy row whose mirror row is missing
    const onlyLegacy = compareLinks("SOLUTION_KR", await legacy(["sol-a"]), await readEntityLinksSolutionKeyResult(tx(), WS_A.id, { solutionIds: ["sol-a"] }));
    expect(onlyLegacy).toMatchObject({ ok: false, onlyLegacy: 1, onlyEntityLinks: 0 });
    state().solutionKeyResultLinks.length = 0; // the legacy row is gone, a mirror row remains
    mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-a");
    mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-null", "KEY_RESULT", "kr-a"); // an unbackfilled (NULL workspace) Solution is never live
    const onlyMirror = compareLinks("SOLUTION_KR", await legacy(["sol-a"]), await readEntityLinksSolutionKeyResult(tx(), WS_A.id, { solutionIds: ["sol-a", "sol-null"] }));
    expect(onlyMirror).toMatchObject({ ok: false, onlyLegacy: 0, onlyEntityLinks: 1 });
    expect(onlyMirror.ids.onlyEntityLinks).toEqual(["sol-a>kr-a"]);
  });

  it("the Key Result side reads the same set", async () => {
    legacySolutionKr("sol-a", "kr-a"); mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-a", "KEY_RESULT", "kr-a");
    const rows = [...(await getLinkedSolutionsByKeyResult(tx(), WS_A.id, ["kr-a"])).entries()].flatMap(([keyResultId, sols]) => sols.map((s) => ({ solutionId: s.id, keyResultId })));
    expect(compareLinks("SOLUTION_KR", legacySolutionKeyResultPairs(rows), await readEntityLinksSolutionKeyResult(tx(), WS_A.id, { keyResultIds: ["kr-a"] })).ok).toBe(true);
  });

  it("a foreign workspace never leaks: the other workspace's mirror row is invisible", async () => {
    mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", "sol-b", "KEY_RESULT", "kr-b", {}, WS_B.id);
    expect(await readEntityLinksSolutionKeyResult(tx(), WS_A.id, { solutionIds: ["sol-b"] })).toEqual([]);
    expect(await readEntityLinksSolutionKeyResult(tx(), WS_B.id, { solutionIds: ["sol-b"] })).toHaveLength(1);
  });
});

describe("Opportunity <-> Objective (with origin) and the Key Result pointer", () => {
  const canvas = async (origins: "ALL" | "DIRECT") => legacyOpportunityObjectivePairs((await getCanvasLinkRows(tx(), WS_A.id, { opportunityIds: ["opp-a"], solutionIds: [], origins })).opportunityObjective);

  it("matches including origin; dangling and cross-workspace objectives are absent on both sides", async () => {
    legacyOppObj("opp-a", "obj-a", "DIRECT"); mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-a", { origin: "DIRECT" });
    legacyOppObj("opp-a", "obj-gone", "LEGACY"); mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-gone", { origin: "LEGACY" });
    legacyOppObj("opp-a", "obj-b", "DIRECT"); mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-b", { origin: "DIRECT" });
    // The canvas legacy reader does not filter endpoints (the canvas draws edges between nodes it already holds), so it is passed through the
    // same liveness filter the workspace-filtered readers apply.
    const legacy = await retainLiveEndpoints(tx(), WS_A.id, await canvas("ALL"));
    const result = compareLinks("OPPORTUNITY", legacy, await readEntityLinksOpportunityObjective(tx(), WS_A.id, { opportunityIds: ["opp-a"] }));
    expect(result).toMatchObject({ ok: true, matched: 1 });
  });

  it("origin drift is reported with the pair id", async () => {
    legacyOppObj("opp-a", "obj-a", "DIRECT"); mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-a", { origin: "LEGACY" });
    const result = compareLinks("OPPORTUNITY", await canvas("ALL"), await readEntityLinksOpportunityObjective(tx(), WS_A.id, { opportunityIds: ["opp-a"] }));
    expect(result).toMatchObject({ ok: false, originDrift: 1, onlyLegacy: 0, onlyEntityLinks: 0 });
    expect(result.ids.originDrift).toEqual(["opp-a>obj-a"]);
  });

  it("the DIRECT-only canvas filter is honoured on both sides", async () => {
    legacyOppObj("opp-a", "obj-a", "LEGACY"); mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-a", { origin: "LEGACY" });
    const result = compareLinks("OPPORTUNITY", await canvas("DIRECT"), await readEntityLinksOpportunityObjective(tx(), WS_A.id, { opportunityIds: ["opp-a"], origins: "DIRECT" }));
    expect(result).toMatchObject({ ok: true, legacyCount: 0, entityLinksCount: 0 });
  });

  it("the Objective side reads the same set", async () => {
    mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", "opp-a", "OBJECTIVE", "obj-a", { origin: "DIRECT" });
    expect(await readEntityLinksOpportunityObjective(tx(), WS_A.id, { objectiveIds: ["obj-a"] })).toHaveLength(1);
  });

  it("pointer: the linked_key_result_id column vs OPPORTUNITY_TARGETS_KEY_RESULT, drift and a dangling pointer", async () => {
    const opportunity = state().opportunities.find((row) => row.id === "opp-a")!;
    const legacy = async () => legacyOpportunityKeyResultPointers([{ id: "opp-a", linkedKeyResultId: opportunity.linkedKeyResultId as string | null }]);
    const entity = () => readEntityLinksOpportunityKeyResultPointer(tx(), WS_A.id, { opportunityIds: ["opp-a"] });
    opportunity.linkedKeyResultId = "kr-a";
    mirror("OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", "opp-a", "KEY_RESULT", "kr-a", { origin: "LEGACY" });
    expect(compareLinks("OPPORTUNITY", await retainLiveEndpoints(tx(), WS_A.id, await legacy()), await entity()).ok).toBe(true);
    opportunity.linkedKeyResultId = "kr-gone"; // a dangling column value: not a link on the legacy side, and the mirror still points at kr-a
    expect(compareLinks("OPPORTUNITY", await retainLiveEndpoints(tx(), WS_A.id, await legacy()), await entity())).toMatchObject({ ok: false, onlyEntityLinks: 1 });
    opportunity.linkedKeyResultId = null;
    state().entityLinks.length = 0;
    expect(compareLinks("OPPORTUNITY", await legacy(), await entity())).toMatchObject({ ok: true, legacyCount: 0 });
  });
});

describe("Artifact parity (solution and decision)", () => {
  it("matches for both link types; a non-TRACKED decision, a dangling target and a cross-workspace target are absent", async () => {
    legacyArtifact("art-a", "SOLUTION", "sol-a"); mirror("ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", "art-a", "SOLUTION", "sol-a");
    legacyArtifact("art-a", "REVIEW_REQUEST", "rr-a"); mirror("ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", "art-a", "REVIEW_REQUEST", "rr-a");
    legacyArtifact("art-a", "REVIEW_REQUEST", "rr-a-system"); mirror("ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", "art-a", "REVIEW_REQUEST", "rr-a-system");
    legacyArtifact("art-a", "SOLUTION", "sol-gone"); mirror("ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", "art-a", "SOLUTION", "sol-gone");
    legacyArtifact("art-a", "SOLUTION", "sol-b"); mirror("ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", "art-a", "SOLUTION", "sol-b");
    const raw = (await tx().artifactLink.findMany({ where: { workspaceId: WS_A.id, artifactId: "art-a" } })) as Row[];
    const live = await retainLiveEndpoints(tx(), WS_A.id, legacyArtifactLinks(raw as never));
    // The legacy decision reader applies the TRACKED_DECISION rule itself; use it for the decision half so the rule is compared, not assumed.
    const decisions = (await getArtifactDecisions(WS_A.id, "art-a")).map((d) => d.id);
    const legacy = live.filter((l) => l.linkType === "ARTIFACT_ATTACHED_TO_SOLUTION" || decisions.includes(l.toId));
    const result = compareLinks("ARTIFACT", legacy, await readEntityLinksArtifact(tx(), WS_A.id, { artifactIds: ["art-a"] }));
    expect(result).toMatchObject({ ok: true, matched: 2 });
  });

  it("drift both ways, and the reciprocal (solution / decision) scopes", async () => {
    legacyArtifact("art-a", "SOLUTION", "sol-a"); // no mirror row
    mirror("ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", "art-a2", "REVIEW_REQUEST", "rr-a"); // no legacy row
    const legacyRows = legacyArtifactLinks((await tx().artifactLink.findMany({ where: { workspaceId: WS_A.id } })) as never);
    const bySolution = compareLinks("ARTIFACT", legacyRows.filter((l) => l.toId === "sol-a"), await readEntityLinksArtifact(tx(), WS_A.id, { solutionIds: ["sol-a"] }));
    expect(bySolution).toMatchObject({ ok: false, onlyLegacy: 1 });
    const byDecision = compareLinks("ARTIFACT", [], await readEntityLinksArtifact(tx(), WS_A.id, { decisionIds: ["rr-a"] }));
    expect(byDecision).toMatchObject({ ok: false, onlyEntityLinks: 1 });
  });
});

describe("Task references parity", () => {
  beforeEach(() => { addTasks(); });
  const legacyTaskLink = (taskId: string, linkedType: string, linkedId: string) => ({ taskId, linkedType, linkedId });

  it("DECISION (legacy) matches REVIEW_REQUEST (stored); every mirrored type compares equal", async () => {
    const rows = [legacyTaskLink("task-a", "DECISION", "rr-a"), legacyTaskLink("task-a", "OPPORTUNITY", "opp-a"), legacyTaskLink("task-a", "KEY_RESULT", "kr-a"), legacyTaskLink("task-a2", "OBJECTIVE", "obj-a")];
    mirror("TASK_REFERENCES", "TASK", "task-a", "REVIEW_REQUEST", "rr-a");
    mirror("TASK_REFERENCES", "TASK", "task-a", "OPPORTUNITY", "opp-a");
    mirror("TASK_REFERENCES", "TASK", "task-a", "KEY_RESULT", "kr-a");
    mirror("TASK_REFERENCES", "TASK", "task-a2", "OBJECTIVE", "obj-a");
    const result = compareLinks("TASK", await retainLiveEndpoints(tx(), WS_A.id, legacyTaskReferences(rows)), await readEntityLinksTaskReferences(tx(), WS_A.id, { taskIds: ["task-a", "task-a2"] }));
    expect(result).toMatchObject({ ok: true, matched: 4 });
  });

  it("COMMENT (and unknown) task links are legacy-only and excluded from the comparison", async () => {
    const rows = [legacyTaskLink("task-a", "COMMENT", "cmt-1"), legacyTaskLink("task-a", "SQUAD", "squad-a"), legacyTaskLink("task-a", "OPPORTUNITY", "opp-a")];
    mirror("TASK_REFERENCES", "TASK", "task-a", "OPPORTUNITY", "opp-a");
    expect(legacyTaskReferences(rows)).toHaveLength(1);
    expect(compareLinks("TASK", await retainLiveEndpoints(tx(), WS_A.id, legacyTaskReferences(rows)), await readEntityLinksTaskReferences(tx(), WS_A.id, { taskIds: ["task-a"] })).ok).toBe(true);
  });

  it("a legacy-dangling task link is the PR C prerequisite: an unfiltered legacy read disagrees, a live-filtered one agrees", async () => {
    const rows = [legacyTaskLink("task-a", "OPPORTUNITY", "opp-gone"), legacyTaskLink("task-a", "OPPORTUNITY", "opp-a")];
    mirror("TASK_REFERENCES", "TASK", "task-a", "OPPORTUNITY", "opp-a");
    const entity = await readEntityLinksTaskReferences(tx(), WS_A.id, { taskIds: ["task-a"] });
    const unfiltered = compareLinks("TASK", legacyTaskReferences(rows), entity);
    expect(unfiltered).toMatchObject({ ok: false, onlyLegacy: 1 });
    expect(unfiltered.ids.onlyLegacy).toEqual(["task-a>opp-gone"]);
    expect(compareLinks("TASK", await retainLiveEndpoints(tx(), WS_A.id, legacyTaskReferences(rows)), entity).ok).toBe(true);
  });

  it("cross-workspace: a task in workspace A pointing at workspace B's target is absent on the entity_links side", async () => {
    mirror("TASK_REFERENCES", "TASK", "task-a", "SOLUTION", "sol-b");
    mirror("TASK_REFERENCES", "TASK", "task-b", "OPPORTUNITY", "opp-b", {}, WS_B.id);
    expect(await readEntityLinksTaskReferences(tx(), WS_A.id, { taskIds: ["task-a", "task-b"] })).toEqual([]);
  });

  it("target scope: reads by target type, accepting the DECISION alias", async () => {
    mirror("TASK_REFERENCES", "TASK", "task-a", "REVIEW_REQUEST", "rr-a");
    expect(await readEntityLinksTaskReferences(tx(), WS_A.id, { target: { type: "DECISION", ids: ["rr-a"] } })).toHaveLength(1);
    expect(await readEntityLinksTaskReferences(tx(), WS_A.id, { target: { type: "COMMENT", ids: ["rr-a"] } })).toEqual([]);
  });
});

describe("compareFamilyRead and the counters", () => {
  const one: ComparableLink = { linkType: "SOLUTION_TARGETS_KEY_RESULT", fromType: "SOLUTION", fromId: "s", toType: "KEY_RESULT", toId: "k" };

  it("mode off: does nothing and never calls the entity_links reader", async () => {
    const readEntityLinks = vi.fn(async () => [one]);
    expect(await compareFamilyRead("SOLUTION_KR", { legacy: [], readEntityLinks })).toBeNull();
    expect(readEntityLinks).not.toHaveBeenCalled();
    expect(getReadCompareCounters().SOLUTION_KR.compares).toBe(0);
  });

  it("shadow: compares, counts a mismatch, logs counts and ids only", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_READ", "shadow");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await compareFamilyRead("SOLUTION_KR", { legacy: [one], readEntityLinks: async () => [one] }))?.ok).toBe(true);
    expect((await compareFamilyRead("SOLUTION_KR", { legacy: [one], readEntityLinks: async () => [] }))?.ok).toBe(false);
    expect(getReadCompareCounters().SOLUTION_KR).toMatchObject({ compares: 2, mismatches: 1, onlyLegacy: 1, onlyEntityLinks: 0, errors: 0, lastMismatchIds: { onlyLegacy: ["s>k"] } });
    expect(getReadCompareCounters().TASK.compares).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toBe(JSON.stringify({ family: "SOLUTION_KR", legacy: 1, entityLinks: 0, onlyLegacy: 1, onlyEntityLinks: 0, originDrift: 0, ids: { onlyLegacy: ["s>k"], onlyEntityLinks: [], originDrift: [] } }));
    warn.mockRestore();
  });

  it("on: also compares; a throwing entity_links reader is swallowed and counted as an error", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_READ", "on");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await compareFamilyRead("TASK", { legacy: [], readEntityLinks: async () => { throw new Error("boom with a title") } })).toBeNull();
    expect(getReadCompareCounters().TASK).toMatchObject({ compares: 0, errors: 1 });
    expect(String(warn.mock.calls[0][1])).not.toContain("title");
    warn.mockRestore();
  });

  it("recordReadCompare accumulates and reset clears", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordReadCompare(compareLinks("ARTIFACT", [one], []));
    recordReadCompare(compareLinks("ARTIFACT", [], [one]));
    expect(getReadCompareCounters().ARTIFACT).toMatchObject({ compares: 2, mismatches: 2, onlyLegacy: 1, onlyEntityLinks: 1 });
    resetReadCompareCounters();
    expect(getReadCompareCounters().ARTIFACT.compares).toBe(0);
    warn.mockRestore();
  });
});
