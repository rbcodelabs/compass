import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), refresh: vi.fn(), update: vi.fn(), updateBinding: vi.fn(), getObservation: vi.fn() }))
vi.mock("@/lib/analytics/service", () => ({ createMetric: mocks.create, listMetrics: mocks.list, refreshBinding: mocks.refresh, updateMetric: mocks.update, updateBinding: mocks.updateBinding, getObservation: mocks.getObservation }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: "user", purpose: "USER" }) }))
import { handleAnalyticsTool } from "@/lib/analytics/tool-handlers"
import { AnalyticsError } from "@/lib/analytics/providers"
const workspaceId = "11111111-1111-4111-8111-111111111111"
const id = "22222222-2222-4222-8222-222222222222"
const definition = { name: "Results recorded", unit: "events", provider: "vercel", query: { metric: "event_count", eventName: "compass_activity", eventProperties: { action: "result_recorded" } } }
describe("analytics tool response and input contracts", () => {
  beforeEach(() => vi.clearAllMocks())
  it("sends only definition fields to strict service schemas and returns an ID", async () => {
    mocks.create.mockResolvedValue({ id, ...definition })
    const result = await handleAnalyticsTool("create_metric", { workspaceId, ...definition })
    expect(mocks.create).toHaveBeenCalledWith({ userId: "user", purpose: "USER" }, workspaceId, definition)
    expect(result.content[0].text).toContain("\nID: " + id)
    expect(result.structuredContent.ok).toBe(true)
  })
  it("returns the standard list envelope", async () => {
    mocks.list.mockResolvedValue([{ id }])
    expect((await handleAnalyticsTool("list_metrics", { workspaceId })).structuredContent.data).toEqual({ items: [{ id }], count: 1 })
  })
  it("preserves optimistic revision on update without leaking routing IDs into the definition", async () => {
    mocks.update.mockResolvedValue({ id })
    await handleAnalyticsTool("update_metric", { ...definition, workspaceId, metricId: id, expectedRevision: 2 })
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), workspaceId, id, { ...definition, expectedRevision: 2 })
  })
  it("reuses the caller refresh UUID and returns sanitized provider error codes", async () => {
    mocks.refresh.mockRejectedValue(new AnalyticsError("RATE_LIMITED"))
    const result = await handleAnalyticsTool("refresh_metric_binding", { workspaceId, bindingId: id, requestId: workspaceId })
    expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), workspaceId, id, workspaceId)
    expect(result.structuredContent).toEqual({ ok: false, message: "RATE_LIMITED", data: null })
  })
  it("rejects malformed windows/request identifiers before service calls", async () => {
    await expect(handleAnalyticsTool("refresh_metric_binding", { workspaceId, bindingId: id, requestId: "new" })).rejects.toThrow()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it("passes only partial replacement fields and permits explicitly clearing a binding target value", async () => {
    const replacementId = "33333333-3333-4333-8333-333333333333"
    mocks.updateBinding.mockResolvedValue({ id: replacementId, replacesBindingId: id })
    const result = await handleAnalyticsTool("update_metric_binding", { workspaceId, bindingId: id, followup: { since: "2026-02-01", until: "2026-02-07" }, target: null })
    expect(mocks.updateBinding).toHaveBeenCalledWith(expect.anything(), workspaceId, id, { followup: { since: "2026-02-01", until: "2026-02-07" }, target: null })
    expect(result.structuredContent.data).toMatchObject({ id: replacementId, replacesBindingId: id })
    expect(result.content[0].text).toContain(`ID: ${replacementId}`)
  })
  it("reads one observation by its stable ID", async () => {
    mocks.getObservation.mockResolvedValue({ id })
    await handleAnalyticsTool("get_metric_observation", { workspaceId, observationId: id })
    expect(mocks.getObservation).toHaveBeenCalledWith(expect.anything(), workspaceId, id)
  })
})
