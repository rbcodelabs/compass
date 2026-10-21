import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const h = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof createTenantFakePrisma>, actor: {} as Record<string, unknown> }));
vi.mock("@/lib/analytics/activity", () => ({ getMcpActivityPrisma: () => h.fake!.client }));
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => h.actor }));

import { linkSummariesForCaller } from "@/lib/link-tool-handlers";

beforeEach(() => {
  h.fake = createTenantFakePrisma();
  h.fake.state.entityLinks.push({ id: "l1", workspaceId: WS_A.id, linkType: "EXPERIMENT_INFORMED_BY_STUDY", fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-a", createdAt: new Date(1), updatedAt: new Date(1) });
});

describe("linkSummariesForCaller", () => {
  it("returns the additive summary for ordinary user and service actors", async () => {
    for (const actor of [{ purpose: "USER" }, { purpose: "SERVICE" }]) {
      h.actor = actor;
      expect(Object.keys(await linkSummariesForCaller(WS_A.id, "EXPERIMENT", "exp-a"))).toEqual(["linkedStudies"]);
    }
  });
  it("gives participant, PM-interview and synthesis-claim contexts nothing", async () => {
    for (const actor of [{ purpose: "RESEARCH" }, { purpose: "USER", scopeConversationId: "c" }, { purpose: "USER", scopeClaimId: "k" }]) {
      h.actor = actor;
      expect(await linkSummariesForCaller(WS_A.id, "EXPERIMENT", "exp-a")).toEqual({});
    }
  });
});
