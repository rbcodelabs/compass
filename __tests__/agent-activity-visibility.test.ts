import { describe, expect, it } from "vitest";
import { ownerAgentActivityWhere } from "@/lib/agent-activity-visibility";
describe("owner agent activity visibility", () => {
  it("includes own unscoped attempts without exposing inaccessible workspace rows", () => {
    expect(ownerAgentActivityWhere("owner", ["own-agent"], ["accessible"])).toEqual({ userId: "owner", agentId: { in: ["own-agent"] }, OR: [{ workspaceId: null }, { workspaceId: { in: ["accessible"] } }] });
  });
  it("keeps unscoped attempts visible when the owner has no memberships", () => {
    expect(ownerAgentActivityWhere("owner", ["own-agent"], []).OR).toEqual([{ workspaceId: null }, { workspaceId: { in: [] } }]);
  });
});
