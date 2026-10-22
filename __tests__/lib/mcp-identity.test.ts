import { describe, expect, it } from "vitest"
import { currentIdentityPayload } from "@/lib/mcp-identity"

const agent = { id: "agent-shared", name: "Triage" }

describe("get_current_identity", () => {
  it("reports a cloud run as the agent, with the person only as invokedByUserId", () => {
    const payload = currentIdentityPayload({ purpose: "AGENT_TURN", userId: "invoker", agentId: agent.id }, agent, [])
    expect(payload).toEqual({ purpose: "AGENT_TURN", userId: null, invokedByUserId: "invoker", agent, workspaces: [] })
  })

  it.each([
    ["a person", { purpose: "USER" as const, userId: "u1" }, null],
    ["a personal agent key", { purpose: "AGENT" as const, userId: "owner", agentId: "a1" }, agent],
    ["the built-in assistant", { purpose: "AGENT_TURN" as const, userId: "u1", agentId: null }, null],
  ])("keeps the established shape for %s", (_label, actor, who) => {
    const payload = currentIdentityPayload(actor, who, [{ id: "w" }])
    expect(payload.userId).toBe(actor.userId)
    expect(payload).not.toHaveProperty("invokedByUserId")
    expect(payload.workspaces).toEqual([{ id: "w" }])
  })

  it("defaults the purpose to USER", () => {
    expect(currentIdentityPayload({ purpose: undefined, userId: "u1" }, null, []).purpose).toBe("USER")
  })
})
