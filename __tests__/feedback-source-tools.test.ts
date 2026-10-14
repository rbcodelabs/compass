/**
 * create_feedback_source / update_feedback_source handlers and the shared
 * embed-source service. Origin normalization, hashing and the compass-url
 * resolver stay real: the wiring between agent input and the stored allowlist
 * is the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  feedbackSource: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  feedbackSourceToken: { create: vi.fn() },
  embedVisitorSession: { updateMany: vi.fn() },
  artifact: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => mocks }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: "user-1", purpose: "USER" }) }))

import { createFeedbackSourceTool, updateFeedbackSourceTool } from "@/lib/feedback-source-tool-handlers"
import { buildEmbedSnippet } from "@/lib/embed-source-service"

const WS = "11111111-1111-4111-8111-111111111111"
const ART = "22222222-2222-4222-8222-222222222222"
const SRC = "33333333-3333-4333-8333-333333333333"

const createInput = { workspaceId: WS, artifactId: ART, name: "Checkout", allowedOrigins: ["https://proto.vercel.app"] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://compass.example.com")
  mocks.artifact.findFirst.mockResolvedValue({ id: ART })
  mocks.feedbackSource.create.mockResolvedValue({ id: SRC })
  mocks.feedbackSourceToken.create.mockResolvedValue({ id: "tok-1" })
  mocks.feedbackSource.findFirst.mockResolvedValue({
    id: SRC, name: "Checkout", allowedOrigins: ["https://proto.vercel.app"], enabled: true, authMode: "INTERNAL_SSO",
  })
  mocks.feedbackSource.update.mockResolvedValue({})
  mocks.embedVisitorSession.updateMany.mockResolvedValue({ count: 2 })
  mocks.$transaction.mockImplementation(async (callback: (tx: typeof mocks) => unknown) => callback(mocks))
})
afterEach(() => vi.unstubAllEnvs())

describe("create_feedback_source", () => {
  it("returns the token once, the ready-to-paste snippet, and the stored state", async () => {
    const result = await createFeedbackSourceTool(createInput)
    const data = result.structuredContent.data as Record<string, unknown>
    expect(result.structuredContent.ok).toBe(true)
    expect(data.token).toMatch(/^cmpfb_[0-9a-f]{32}$/)
    expect(data.sourceId).toBe(SRC)
    expect(data.tokenPrefix).toBe((data.token as string).slice(6, 14))
    expect(data.snippet).toBe(`<script src="https://compass.example.com/embed/widget.js" data-compass-token="${data.token}" defer></script>`)
    expect(data.allowedOrigins).toEqual(["https://proto.vercel.app"])
    expect(data.authMode).toBe("INTERNAL_SSO")
    expect(result.content[0].text).toContain(`ID: ${SRC}`)
    // Only the hash is persisted, never the raw token.
    const stored = mocks.feedbackSourceToken.create.mock.calls[0][0].data
    expect(JSON.stringify(stored)).not.toContain(data.token as string)
    expect(stored.createdById).toBe("user-1")
    expect(mocks.feedbackSource.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, artifactId: ART, authMode: "INTERNAL_SSO", enabled: true })
  })

  it("honours authMode PORTAL", async () => {
    await createFeedbackSourceTool({ ...createInput, authMode: "PORTAL" })
    expect(mocks.feedbackSource.create.mock.calls[0][0].data.authMode).toBe("PORTAL")
  })

  it("creates the source and one-time credential in one transaction", async () => {
    await createFeedbackSourceTool(createInput)

    expect(mocks.$transaction).toHaveBeenCalledOnce()
    expect(mocks.feedbackSource.create).toHaveBeenCalledOnce()
    expect(mocks.feedbackSourceToken.create).toHaveBeenCalledOnce()
  })

  it("does not return a credential when token persistence aborts creation", async () => {
    mocks.feedbackSourceToken.create.mockRejectedValue(new Error("token write failed"))

    await expect(createFeedbackSourceTool(createInput)).rejects.toThrow("token write failed")

    expect(mocks.$transaction).toHaveBeenCalledOnce()
  })

  it("returns token and script path separately, with a note, when the Compass URL is not configured", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    const result = await createFeedbackSourceTool(createInput)
    const data = result.structuredContent.data as Record<string, unknown>
    expect(result.structuredContent.ok).toBe(true)
    expect(data.snippet).toBeNull()
    expect(data.scriptUrl).toBeNull()
    expect(data.scriptPath).toBe("/embed/widget.js")
    expect(data.token).toMatch(/^cmpfb_/)
    expect(String(data.note)).toContain("NEXT_PUBLIC_APP_URL")
    expect(result.content[0].text).toContain("Snippet unavailable")
  })

  it("rejects an unsafe configured Compass URL before consuming the one-time credential", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://user:secret@compass.example.com")
    await expect(createFeedbackSourceTool(createInput)).rejects.toThrow()
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled()
    expect(mocks.feedbackSourceToken.create).not.toHaveBeenCalled()
  })

  it.each([
    ["a wildcard", ["https://*.vercel.app"]],
    ["an origin with a path", ["https://proto.example.com/app"]],
    ["embedded credentials", ["https://u:pw@proto.example.com"]],
    ["garbage", ["not a url"]],
  ])("rejects %s with a readable error and writes nothing", async (_label, allowedOrigins) => {
    const result = await createFeedbackSourceTool({ ...createInput, allowedOrigins })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text.length).toBeGreaterThan(10)
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled()
    expect(mocks.feedbackSourceToken.create).not.toHaveBeenCalled()
  })

  it("normalizes origins and permits an empty list (source exists before the deploy origin is known)", async () => {
    const normalized = await createFeedbackSourceTool({ ...createInput, allowedOrigins: ["HTTPS://Proto.Example.com/", "https://proto.example.com"] })
    expect((normalized.structuredContent.data as { allowedOrigins: string[] }).allowedOrigins).toEqual(["https://proto.example.com"])
    const empty = await createFeedbackSourceTool({ ...createInput, allowedOrigins: [] })
    expect(empty.structuredContent.ok).toBe(true)
  })

  it("rejects an artifact that is not active in the declared workspace", async () => {
    mocks.artifact.findFirst.mockResolvedValue(null)
    const result = await createFeedbackSourceTool(createInput)
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/no longer exists in this workspace/)
    expect(mocks.artifact.findFirst).toHaveBeenCalledWith({
      where: { id: ART, workspaceId: WS, status: "ACTIVE" },
      select: { id: true },
    })
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled()
  })

  it("rejects a blank name", async () => {
    const result = await createFeedbackSourceTool({ ...createInput, name: "   " })
    expect(result.structuredContent.ok).toBe(false)
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled()
  })

  it("rethrows unexpected errors instead of reporting them as input problems", async () => {
    mocks.feedbackSource.create.mockRejectedValue(new Error("db down"))
    await expect(createFeedbackSourceTool(createInput)).rejects.toThrow("db down")
  })
})

describe("update_feedback_source", () => {
  it("adds the real deploy origin and returns stored state without a token", async () => {
    const result = await updateFeedbackSourceTool({
      workspaceId: WS, sourceId: SRC, allowedOrigins: ["https://proto.vercel.app", "https://real.example.com"],
    })
    expect(result.structuredContent.data).toEqual({
      sourceId: SRC, name: "Checkout", enabled: true, authMode: "INTERNAL_SSO",
      allowedOrigins: ["https://proto.vercel.app", "https://real.example.com"],
    })
    expect(result.content[0].text).toContain(`ID: ${SRC}`)
    expect(result.content[0].text).not.toMatch(/cmpfb_/)
    expect(mocks.embedVisitorSession.updateMany).not.toHaveBeenCalled()
  })

  it("scopes the lookup by workspace so a cross-workspace sourceId fails", async () => {
    mocks.feedbackSource.findFirst.mockResolvedValue(null)
    const result = await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, enabled: false })
    expect(result.structuredContent.ok).toBe(false)
    expect(mocks.feedbackSource.findFirst.mock.calls[0][0].where).toEqual({ id: SRC, workspaceId: WS })
    expect(mocks.feedbackSource.update).not.toHaveBeenCalled()
  })

  it("revokes live visitor sessions when authMode actually changes", async () => {
    const result = await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, authMode: "PORTAL" })
    expect(result.structuredContent.ok).toBe(true)
    expect(mocks.feedbackSource.update.mock.calls[0][0].data.authMode).toBe("PORTAL")
    expect(mocks.embedVisitorSession.updateMany).toHaveBeenCalledWith({
      where: { feedbackSourceId: SRC, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it("fails the atomic mode change when visitor revocation fails", async () => {
    mocks.embedVisitorSession.updateMany.mockRejectedValueOnce(new Error("revoke failed"))
    await expect(updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, authMode: "PORTAL" })).rejects.toThrow("revoke failed")
    expect(mocks.$transaction).toHaveBeenCalledOnce()
  })

  it("does not revoke sessions when the submitted authMode equals the stored one, or when it is omitted", async () => {
    await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, authMode: "INTERNAL_SSO" })
    await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, enabled: false })
    expect(mocks.embedVisitorSession.updateMany).not.toHaveBeenCalled()
  })

  it("keeps a stored PORTAL mode when only toggling enabled", async () => {
    mocks.feedbackSource.findFirst.mockResolvedValue({ id: SRC, name: "x", allowedOrigins: [], enabled: true, authMode: "PORTAL" })
    await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, enabled: false })
    expect(mocks.feedbackSource.update.mock.calls[0][0].data).toMatchObject({ authMode: "PORTAL", enabled: false })
    expect(mocks.embedVisitorSession.updateMany).not.toHaveBeenCalled()
  })

  it("rejects bad origins and an empty update", async () => {
    const bad = await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC, allowedOrigins: ["https://*.example.com"] })
    expect(bad.structuredContent.ok).toBe(false)
    const empty = await updateFeedbackSourceTool({ workspaceId: WS, sourceId: SRC })
    expect(empty.structuredContent.ok).toBe(false)
    expect(mocks.feedbackSource.update).not.toHaveBeenCalled()
  })
})

describe("buildEmbedSnippet", () => {
  it("trims a trailing slash and returns no tag without a base URL", () => {
    expect(buildEmbedSnippet("https://c.example.com/", "cmpfb_x").snippet).toBe(
      '<script src="https://c.example.com/embed/widget.js" data-compass-token="cmpfb_x" defer></script>'
    )
    expect(buildEmbedSnippet(null, "cmpfb_x")).toEqual({ snippet: null, scriptPath: "/embed/widget.js", scriptUrl: null })
  })
})
