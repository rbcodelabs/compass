/**
 * ArtifactLink (Artifact -> Solution, Artifact -> Decision). entity_links is the only store: lib/artifacts.ts is the dedicated writer
 * (ARTIFACT_ATTACHED_TO_SOLUTION, ARTIFACT_SUPPORTS_DECISION) and lib/links/readers.ts the reader. A Decision link is live supporting
 * material (ADR-0010) and TRACKED_DECISION-only.
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
  getArtifactDecisions,
  getArtifactSolutionIds,
  getDecisionArtifacts,
  getSolutionArtifactIds,
  getSolutionsArtifactIds,
  linkArtifactToDecision,
  linkArtifactToSolution,
  unlinkArtifactFromDecision,
  unlinkArtifactFromSolution,
} from "@/lib/artifacts";
import { deleteLinksForEntity, linkEntities } from "@/lib/links/service";
import { countEntityLinksByArtifact } from "@/lib/links/readers";
import { getLinkType, isLinkTypeEnabled } from "@/lib/links/registry";
import type { AppTransactionClient } from "@/lib/db";

const SOLUTION = "ARTIFACT_ATTACHED_TO_SOLUTION";
const DECISION = "ARTIFACT_SUPPORTS_DECISION";
const state = () => fake.current!.state;
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const stored = (type?: string) => state().entityLinks.filter((row) => (type ? row.linkType === type : row.linkType === SOLUTION || row.linkType === DECISION));
const solutionInput = (artifactId = "art-a", solutionId = "sol-a") => ({ artifactId, solutionId, workspaceId: WS_A.id, createdById: "user-alice", source: "MCP" as const });
const decisionInput = (artifactId = "art-a", requestId = "rr-a") => ({ artifactId, requestId, workspaceId: WS_A.id, createdById: "user-alice", source: "UI" as const });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});

describe("Artifact -> Solution", () => {
  it("writes one entity_links row with the workspace, actor and source ", async () => {
    expect(await linkArtifactToSolution(solutionInput())).toMatchObject({ created: true, artifactId: "art-a", linkedType: "SOLUTION", linkedId: "sol-a", source: "MCP", createdById: "user-alice" });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ linkType: SOLUTION, workspaceId: WS_A.id, fromType: "ARTIFACT", fromId: "art-a", toType: "SOLUTION", toId: "sol-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" });
  });

  it("is idempotent: a repeat reports created:false, keeps the original actor and writes nothing new", async () => {
    await linkArtifactToSolution(solutionInput());
    const writes = state().writes.length;
    expect(await linkArtifactToSolution({ ...solutionInput(), createdById: "user-bob", source: "UI" })).toMatchObject({ created: false, createdById: "user-alice", source: "MCP" });
    expect(state().writes.length).toBe(writes);
    expect(stored()).toHaveLength(1);
  });

  it("refuses a Solution or Artifact from another workspace and writes nothing", async () => {
    await expect(linkArtifactToSolution(solutionInput("art-a", "sol-b"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    await expect(linkArtifactToSolution(solutionInput("art-b", "sol-a"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    await expect(linkArtifactToSolution(solutionInput("art-a", "sol-null"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    expect(stored()).toHaveLength(0);
  });

  it("an archived Artifact can still be attached to a Solution", async () => {
    expect((await linkArtifactToSolution(solutionInput("art-a-archived"))).created).toBe(true);
    expect(stored()).toHaveLength(1);
  });

  it("unlink removes the row; an unknown pair is removed:false", async () => {
    await linkArtifactToSolution(solutionInput());
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: true });
    expect(stored()).toHaveLength(0);
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: false });
  });

  it("an unlink from another workspace's Artifact removes nothing", async () => {
    await linkArtifactToSolution(solutionInput());
    await expect(unlinkArtifactFromSolution({ ...solutionInput("art-b") })).rejects.toThrow("Artifact not found");
    expect(stored()).toHaveLength(1);
  });
});

describe("Artifact -> Decision (TRACKED_DECISION only, live supporting material)", () => {
  it("links the request itself (never a revision) with source and actor", async () => {
    expect(await linkArtifactToDecision(decisionInput())).toMatchObject({ created: true, linkedType: "REVIEW_REQUEST", linkedId: "rr-a" });
    expect(stored(DECISION)).toHaveLength(1);
    expect(stored(DECISION)[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "ARTIFACT", fromId: "art-a", toType: "REVIEW_REQUEST", toId: "rr-a", origin: "DIRECT", source: "UI", createdById: "user-alice" });
    expect(JSON.stringify(stored(DECISION))).not.toContain("rev-a");
  });

  it("refuses a non-TRACKED_DECISION request, a foreign request and a foreign Artifact; no row is written", async () => {
    await expect(linkArtifactToDecision(decisionInput("art-a", "rr-a-system"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    await expect(linkArtifactToDecision(decisionInput("art-a", "rr-b"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    await expect(linkArtifactToDecision(decisionInput("art-b", "rr-a"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    expect(stored()).toHaveLength(0);
  });

  it("the registry itself refuses a non-TRACKED_DECISION request", async () => {
    await expect(
      linkEntities(tx(), { linkType: DECISION, fromId: "art-a", toId: "rr-a-system", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" }, viaDedicatedWriter: true }),
    ).rejects.toThrow("Review request not found in this workspace.");
    expect(stored()).toHaveLength(0);
  });

  it("an archived Artifact takes no NEW link, but an existing link replays", async () => {
    await expect(linkArtifactToDecision(decisionInput("art-a-archived"))).rejects.toThrow(/archived/i);
    expect(stored()).toHaveLength(0);
    await linkEntities(tx(), { linkType: DECISION, fromId: "art-a-archived", toId: "rr-a", expectedWorkspaceId: WS_A.id, ctx: { source: "UI" }, viaDedicatedWriter: true });
    expect(await linkArtifactToDecision(decisionInput("art-a-archived"))).toMatchObject({ created: false });
    expect(stored(DECISION)).toHaveLength(1);
  });

  it("unlink works for an archived Artifact; an unknown pair is removed:false", async () => {
    await linkArtifactToDecision(decisionInput());
    expect(await unlinkArtifactFromDecision(decisionInput("art-a"))).toEqual({ removed: true });
    expect(stored()).toHaveLength(0);
    expect(await unlinkArtifactFromDecision(decisionInput())).toEqual({ removed: false });
  });

  it("one Artifact can support a Solution and a Decision at once; the two types do not interfere", async () => {
    await linkArtifactToSolution(solutionInput());
    await linkArtifactToDecision(decisionInput());
    expect(stored(SOLUTION)).toHaveLength(1);
    expect(stored(DECISION)).toHaveLength(1);
    await unlinkArtifactFromDecision(decisionInput());
    expect(stored(SOLUTION)).toHaveLength(1);
    expect(stored(DECISION)).toHaveLength(0);
  });
});

describe("readers", () => {
  it("read both families from entity_links, in creation order, within the workspace", async () => {
    await linkArtifactToSolution(solutionInput("art-a", "sol-a"));
    await linkArtifactToSolution(solutionInput("art-a2", "sol-a"));
    await linkArtifactToDecision(decisionInput("art-a", "rr-a"));
    // A foreign-workspace link row never shows in workspace A.
    state().entityLinks.push({ ...stored(SOLUTION)[0], id: "foreign", workspaceId: WS_B.id, fromId: "art-b", toId: "sol-b" });
    expect(await getArtifactSolutionIds(tx(), WS_A.id, "art-a")).toEqual(["sol-a"]);
    expect(await getSolutionArtifactIds(tx(), WS_A.id, "sol-a")).toEqual(["art-a", "art-a2"]);
    expect([...(await getSolutionsArtifactIds(tx(), WS_A.id, ["sol-a", "sol-b"])).entries()]).toEqual([["sol-a", ["art-a", "art-a2"]]]);
    expect((await getArtifactDecisions(WS_A.id, "art-a")).map((d) => d.id)).toEqual(["rr-a"]);
    expect((await getDecisionArtifacts(WS_A.id, "rr-a")).map((a) => a.id)).toEqual(["art-a"]);
    expect(await getArtifactSolutionIds(tx(), WS_B.id, "art-a")).toEqual([]);
  });

  it("drop a Decision link whose request is not a TRACKED_DECISION", async () => {
    await linkArtifactToDecision(decisionInput());
    state().entityLinks.push({ ...stored(DECISION)[0], id: "system-gate", toId: "rr-a-system" });
    expect((await getArtifactDecisions(WS_A.id, "art-a")).map((d) => d.id)).toEqual(["rr-a"]);
    expect(await countEntityLinksByArtifact(tx(), WS_A.id, ["art-a"])).toEqual(new Map([["art-a", 1]]));
  });

  it("countEntityLinksByArtifact counts Solution and Decision links per Artifact and omits an Artifact with none", async () => {
    await linkArtifactToSolution(solutionInput("art-a", "sol-a"));
    await linkArtifactToDecision(decisionInput("art-a", "rr-a"));
    await linkArtifactToSolution(solutionInput("art-a2", "sol-a"));
    expect(await countEntityLinksByArtifact(tx(), WS_A.id, ["art-a", "art-a2", "art-a-archived"])).toEqual(new Map([["art-a", 2], ["art-a2", 1]]));
    expect(await countEntityLinksByArtifact(tx(), WS_A.id, [])).toEqual(new Map());
  });
});

describe("registry and writer guard", () => {
  it("the generic link service refuses both types unless the dedicated writer passes viaDedicatedWriter", async () => {
    await expect(linkEntities(tx(), { linkType: SOLUTION, fromId: "art-a", toId: "sol-a", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/link_artifact_to_solution/);
    await expect(linkEntities(tx(), { linkType: DECISION, fromId: "art-a", toId: "rr-a", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/link_artifact_to_decision/);
  });

  it("registers both types with lib/artifacts.ts as their dedicated writer", () => {
    for (const key of [SOLUTION, DECISION]) {
      const def = getLinkType(key)!;
      expect(def.dedicatedWriter?.module).toBe("lib/artifacts.ts");
      expect(isLinkTypeEnabled(def)).toBe(true);
      expect(def.cardinality).toEqual({ from: "many", to: "many" });
    }
  });
});

describe("delete sweeps", () => {
  it("deleting an Artifact, a Solution or a Review request removes the link rows at that end", async () => {
    for (const [type, id] of [["ARTIFACT", "art-a"], ["SOLUTION", "sol-a"], ["REVIEW_REQUEST", "rr-a"]] as const) {
      await linkArtifactToSolution(solutionInput());
      await linkArtifactToDecision(decisionInput());
      expect(stored()).toHaveLength(2);
      await deleteLinksForEntity(tx(), type, [id]);
      expect(stored().filter((row) => row.fromId === id || row.toId === id)).toHaveLength(0);
      // Only the rows at that endpoint go: an Artifact sweep takes both, a Solution or Review request sweep takes its own type.
      expect(stored()).toHaveLength(type === "ARTIFACT" ? 0 : 1);
      state().entityLinks.splice(0);
    }
  });
});
