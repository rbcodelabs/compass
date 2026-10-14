/**
 * Followable subject display (lib/followable.ts, from the following/notifications feature) resolves which followed
 * objects belong to a workspace. Like the card sort loaders, that is a scoping decision, so it must use a Solution's and
 * Objective's own workspaceId (Assumption through its Solution, Key Result through its Objective) and must not list
 * NULL-workspaceId or other-workspace rows.
 */
import { describe, expect, it } from "vitest";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { getFollowable } from "@/lib/followable";

const CASES = [
  ["SOLUTION", ["sol-a", "sol-b", "sol-null"], "sol-a"],
  ["ASSUMPTION", ["asm-a", "asm-b", "asm-null"], "asm-a"],
  ["OBJECTIVE", ["obj-a", "obj-b", "obj-null"], "obj-a"],
  ["KEY_RESULT", ["kr-a", "kr-b", "kr-null"], "kr-a"],
] as const;

describe("followable resolveDisplay scopes Solution / Assumption / Objective / Key Result by the row's own workspace", () => {
  it.each(CASES)("%s: only the workspace's own row resolves; another workspace's and a NULL-workspaceId row do not", async (type, ids, own) => {
    const fake = createTenantFakePrisma();
    const display = await getFollowable(type)!.resolveDisplay(WS_A.id, [...ids], fake.client as never);
    expect([...display.keys()]).toEqual([own]);
  });

  it("a drifted Solution (own workspaceId is another workspace, its opportunity is A's) does not resolve in A", async () => {
    const fake = createTenantFakePrisma();
    fake.state.solutions.push({ id: "sol-drift", workspaceId: "ws-b", opportunityId: "opp-a", title: "drifted" });
    const display = await getFollowable("SOLUTION")!.resolveDisplay(WS_A.id, ["sol-a", "sol-drift"], fake.client as never);
    expect([...display.keys()]).toEqual(["sol-a"]);
  });

  it("a cycle-less Objective with its own workspaceId resolves (Phase 1)", async () => {
    const fake = createTenantFakePrisma();
    fake.state.objectives.push({ id: "obj-cycleless", workspaceId: WS_A.id, cycleId: null, title: "Persistent" });
    const display = await getFollowable("OBJECTIVE")!.resolveDisplay(WS_A.id, ["obj-cycleless"], fake.client as never);
    expect([...display.keys()]).toEqual(["obj-cycleless"]);
  });
});
