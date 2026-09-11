import { beforeEach, expect, it, vi } from "vitest"
const calls = { create: vi.fn(), update: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ agentToolCall: calls }) }))
import { withAgentActivity } from "@/lib/agent-activity"
import { fail, ok } from "@/lib/mcp-output"
const actor = { purpose: "AGENT" as const, agentId: "agent", userId: "user", credentialId: "key" }
beforeEach(() => { vi.clearAllMocks(); calls.create.mockResolvedValue({ id: "call" }); calls.update.mockResolvedValue({}) })
it("records structured failures without isError as failed", async () => {
  await withAgentActivity(actor, "create_task", true, async () => {}, async () => fail("Invalid assignee"))
  expect(calls.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }))
})
it("never invokes the mutation when starting its activity fails", async () => {
  calls.create.mockRejectedValueOnce(new Error("database unavailable"))
  const operation = vi.fn()
  await expect(withAgentActivity(actor, "create_task", true, async () => {}, operation)).rejects.toThrow()
  expect(operation).not.toHaveBeenCalled()
})
it("preserves a successful result when final logging fails", async () => {
  calls.update.mockRejectedValueOnce(new Error("database unavailable"))
  const operation = vi.fn(async () => ok("Created", { id: "task" }))
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  await expect(withAgentActivity(actor, "create_task", true, async () => {}, operation)).resolves.toMatchObject({ structuredContent: { ok: true } })
  expect(operation).toHaveBeenCalledTimes(1)
  log.mockRestore()
})
