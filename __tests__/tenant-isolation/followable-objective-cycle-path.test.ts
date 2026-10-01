/**
 * The follow link for an Objective (and its Key Results) is built from the Objective's cycle. A cycle-less
 * Objective (migration 070) has no cycle id, so the link must use the fixed persistent route instead of
 * producing `okrs/null`.
 */
import { describe, expect, it } from "vitest";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { getFollowable } from "@/lib/followable";
import { PERSISTENT_CYCLE_SLUG } from "@/lib/okr-cycle-scope";

async function paths(type: "OBJECTIVE" | "KEY_RESULT", ids: string[], seed?: (fake: ReturnType<typeof createTenantFakePrisma>) => void) {
  const fake = createTenantFakePrisma();
  seed?.(fake);
  const display = await getFollowable(type)!.resolveDisplay(WS_A.id, ids, fake.client as never);
  return Object.fromEntries([...display].map(([id, value]) => [id, value.path]));
}

describe("followable OKR paths", () => {
  it("OBJECTIVE: a cycle-bound Objective links to its cycle", async () => {
    await expect(paths("OBJECTIVE", ["obj-a"])).resolves.toEqual({ "obj-a": "okrs/cycle-a" });
  });

  it("OBJECTIVE: a cycle-less Objective links to the persistent route, never okrs/null", async () => {
    const result = await paths("OBJECTIVE", ["obj-cycleless"], (fake) => {
      fake.state.objectives.push({ id: "obj-cycleless", workspaceId: WS_A.id, cycleId: null, title: "Persistent" });
    });
    expect(result).toEqual({ "obj-cycleless": `okrs/${PERSISTENT_CYCLE_SLUG}` });
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("KEY_RESULT: a KR on a cycle-bound Objective links to the cycle", async () => {
    await expect(paths("KEY_RESULT", ["kr-a"])).resolves.toEqual({ "kr-a": "okrs/cycle-a" });
  });

  it("KEY_RESULT: a KR on a cycle-less Objective links to the persistent route", async () => {
    const result = await paths("KEY_RESULT", ["kr-cycleless"], (fake) => {
      fake.state.objectives.push({ id: "obj-cycleless", workspaceId: WS_A.id, cycleId: null, title: "Persistent" });
      fake.state.keyResults.push({ id: "kr-cycleless", objectiveId: "obj-cycleless", title: "KR", target: 1, current: 0, sortOrder: 0 });
    });
    expect(result).toEqual({ "kr-cycleless": `okrs/${PERSISTENT_CYCLE_SLUG}` });
  });
});
