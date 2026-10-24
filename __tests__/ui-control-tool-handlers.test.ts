import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ userId: "u1" as string | null, run: vi.fn() }))

vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace: { findUnique: async () => ({ slug: "growth", organization: { slug: "acme" } }) },
  }),
}))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: state.userId }) }))
vi.mock("@/lib/ui-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ui-control")>()),
  runUiCommand: state.run,
}))

import { uiGetState, uiNavigate, uiScreenshot } from "@/lib/ui-control-tool-handlers"
import { UiControlError } from "@/lib/ui-control"

const workspaceId = "w1"

beforeEach(() => {
  state.userId = "u1"
  state.run.mockReset()
})

describe("ui_navigate", () => {
  it("sends a validated workspace path for the calling user", async () => {
    state.run.mockResolvedValue({ path: "/acme/growth/roadmap", title: "Roadmap" })
    const result = await uiNavigate({ workspaceId, path: "/acme/growth/roadmap" })
    expect(result.structuredContent.ok).toBe(true)
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", workspaceId, kind: "navigate", commandArgs: { path: "/acme/growth/roadmap" } }),
    )
  })

  it("refuses an off-workspace path without queuing anything", async () => {
    const result = await uiNavigate({ workspaceId, path: "/api/admin/migrate" })
    expect(result.structuredContent.ok).toBe(false)
    expect(state.run).not.toHaveBeenCalled()
  })

  it("turns a missing opt-in into a fail result, not a throw", async () => {
    state.run.mockRejectedValue(new UiControlError("The user has not enabled agent control.", "NO_SESSION"))
    const result = await uiNavigate({ workspaceId, path: "/acme/growth" })
    expect(result.structuredContent).toMatchObject({ ok: false, data: { code: "NO_SESSION" } })
  })

  it("refuses the shared service key, which has no browser", async () => {
    state.userId = null
    const result = await uiNavigate({ workspaceId, path: "/acme/growth" })
    expect(result.structuredContent.ok).toBe(false)
    expect(state.run).not.toHaveBeenCalled()
  })
})

describe("ui_get_state", () => {
  it("returns the tab's state", async () => {
    state.run.mockResolvedValue({ path: "/acme/growth", headings: ["OKRs"] })
    const result = await uiGetState({ workspaceId })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { headings: ["OKRs"] } })
  })
})

describe("ui_screenshot", () => {
  it("returns the PNG as an image content block, not inside structured data", async () => {
    state.run.mockResolvedValue({ pngBase64: "iVBORw0KGgo=", path: "/acme/growth", width: 10, height: 5 })
    const result = await uiScreenshot({ workspaceId })
    expect(result.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" })
    expect(JSON.stringify(result.structuredContent)).not.toContain("iVBORw0KGgo")
    expect(result.structuredContent.ok).toBe(true)
  })

  it.each([undefined, "not base64!!", "A".repeat(1_500_001)])("rejects an unusable capture (%#)", async (png) => {
    state.run.mockResolvedValue({ pngBase64: png })
    expect((await uiScreenshot({ workspaceId })).structuredContent.ok).toBe(false)
  })
})
