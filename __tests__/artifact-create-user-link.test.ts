import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const prisma = { workspace: { findUnique: vi.fn() } }
const createHtmlArtifact = vi.fn()
const createExternalArtifact = vi.fn()

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }))
vi.mock("@/lib/artifact-thumbnail", () => ({ scheduleArtifactThumbnailCapture: vi.fn(), captureAndStoreArtifactThumbnail: vi.fn() }))
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  createHtmlArtifact: (...args: unknown[]) => createHtmlArtifact(...args),
  createExternalArtifact: (...args: unknown[]) => createExternalArtifact(...args),
}))

import { createArtifact } from "@/lib/artifact-tool-handlers"

const PAGE = "https://compass.example.test/acme/compass/docs/artifacts/art-1"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("VERCEL_ENV", "production")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://compass.example.test")
  prisma.workspace.findUnique.mockResolvedValue({ slug: "compass", organization: { slug: "acme" } })
  createHtmlArtifact.mockResolvedValue({ id: "art-1", title: "Prototype", currentRevisionId: "rev-1" })
  createExternalArtifact.mockResolvedValue({ id: "art-1", title: "Prototype", currentRevisionId: "rev-1" })
})
afterEach(() => vi.unstubAllEnvs())

describe("create_artifact user link", () => {
  it("returns the clickable page URL for an HTML artifact", async () => {
    const result = await createArtifact({ workspaceId: "ws-1", title: "Prototype", sourceType: "HTML_UPLOAD", html: "<html><body>hi</body></html>" })
    expect(result.content[0].text).toBe(`Artifact created.\nID: art-1\nURL: ${PAGE}`)
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: "art-1", url: PAGE } })
  })

  it("returns the clickable page URL for an external-link artifact", async () => {
    const result = await createArtifact({ workspaceId: "ws-1", title: "Prototype", sourceType: "EXTERNAL_LINK", url: "https://example.com" })
    expect(result.content[0].text).toContain(`URL: ${PAGE}`)
    expect(result.structuredContent).toMatchObject({ data: { url: PAGE } })
  })

  it("still reports success, without a link, when the origin is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    const result = await createArtifact({ workspaceId: "ws-1", title: "Prototype", sourceType: "HTML_UPLOAD", html: "<html><body>hi</body></html>" })
    expect(result.content[0].text).toBe("Artifact created.\nID: art-1")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: "art-1", url: null } })
  })
})
