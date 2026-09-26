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
it("labels the audit row with the credential kind that produced the actor", async () => {
  // credential_id is polymorphic across api_keys.id and oauth_tokens.id (ADR
  // 0015), so a row without this discriminator cannot be joined back to
  // anything with confidence.
  await withAgentActivity({ ...actor, credentialType: "OAUTH" as const }, "create_task", true, async () => {}, async () => ok("Created", {}))
  expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ credentialType: "OAUTH" }) }))
})
it("falls back to API_KEY when an actor predates the discriminator", async () => {
  // Every row written before ADR 0015 was an API key, so that is what an
  // absent value means. A null would be a third value with no meaning.
  await withAgentActivity(actor, "create_task", true, async () => {}, async () => ok("Created", {}))
  expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ credentialType: "API_KEY" }) }))
})
