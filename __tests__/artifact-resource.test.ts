import { beforeEach, describe, expect, it, vi } from "vitest"
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"

const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
const prisma = {
  workspace: { findMany: vi.fn(), findFirst: vi.fn() },
  artifact: { findMany: vi.fn(), findFirst: vi.fn() },
  artifactRevision: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))
vi.mock("@/lib/agent-access", async (orig) => ({ ...(await orig<typeof import("@/lib/agent-access")>()), agentWorkspaceWhere: async () => ({ members: { some: { userId: "user-1" } } }) }))

import { MAX_ARTIFACT_RESOURCE_BYTES, listArtifactResources, readArtifactResource } from "@/lib/artifact-resource"
import { McpAuthzError, type McpActor } from "@/lib/mcp-authz"

const actor: McpActor = { userId: "user-1", purpose: "USER" }
const ids = { workspaceId: "ws-1", artifactId: "art-1" }
const bytes = (s: string) => new TextEncoder().encode(s)

function revision(over: Record<string, unknown> = {}) {
  return { id: "rev-1", blobPathname: "private/key.html", mimeType: "text/html; charset=utf-8", filename: "p.html", byteSize: 10, sha256: "abc", externalUrl: null, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", kind: null, sourceType: "HTML_UPLOAD", currentRevisionId: "rev-1" })
  prisma.artifactRevision.findFirst.mockResolvedValue(revision())
})

describe("listArtifactResources", () => {
  it("lists non-archived artifacts in accessible workspaces", async () => {
    prisma.workspace.findMany.mockResolvedValue([{ id: "ws-1" }])
    prisma.artifact.findMany.mockResolvedValue([{ id: "art-1", workspaceId: "ws-1", title: "Proto", currentRevision: { mimeType: "text/html" } }])
    const result = await listArtifactResources(actor)
    expect(result.resources).toEqual([{ uri: "artifact://ws-1/art-1", name: "Proto", mimeType: "text/html" }])
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: { in: ["ws-1"] }, status: { not: "ARCHIVED" } }),
    }))
  })

  it("denies research actors", async () => {
    await expect(listArtifactResources({ userId: null, purpose: "RESEARCH" })).rejects.toBeInstanceOf(McpAuthzError)
  })
})

describe("readArtifactResource", () => {
  it("returns HTML as text with _meta and no blob pathname", async () => {
    storage.get.mockResolvedValue(bytes("<html>hi</html>"))
    const result = await readArtifactResource(actor, ids)
    expect(storage.get).toHaveBeenCalledWith("private/key.html")
    expect(result.contents[0]).toMatchObject({
      uri: "artifact://ws-1/art-1/rev-1", text: "<html>hi</html>", mimeType: "text/html; charset=utf-8",
      _meta: { artifactId: "art-1", revisionId: "rev-1", kind: "DOCUMENT", sha256: "abc" },
    })
    expect(JSON.stringify(result)).not.toContain("private/key.html")
  })

  it("reads a specific revision scoped to the artifact", async () => {
    storage.get.mockResolvedValue(bytes("x"))
    await readArtifactResource(actor, { ...ids, revisionId: "rev-0" })
    expect(prisma.artifactRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rev-0", artifactId: "art-1" } }))
  })

  it("returns non-text content as base64 blob", async () => {
    prisma.artifactRevision.findFirst.mockResolvedValue(revision({ mimeType: "application/pdf" }))
    storage.get.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const result = await readArtifactResource(actor, ids)
    expect(result.contents[0]).toMatchObject({ blob: "AQID", mimeType: "application/pdf" })
    expect(result.contents[0]).not.toHaveProperty("text")
  })

  it("returns the URL for an external link without touching storage", async () => {
    prisma.artifactRevision.findFirst.mockResolvedValue(revision({ blobPathname: null, mimeType: null, externalUrl: "https://example.com/x" }))
    const result = await readArtifactResource(actor, ids)
    expect(result.contents[0]).toMatchObject({ text: "https://example.com/x", mimeType: "text/uri-list" })
    expect(storage.get).not.toHaveBeenCalled()
  })

  it("denies a non-member before looking up the artifact", async () => {
    prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(readArtifactResource(actor, ids)).rejects.toBeInstanceOf(McpAuthzError)
    expect(prisma.artifact.findFirst).not.toHaveBeenCalled()
  })

  it("denies research actors", async () => {
    await expect(readArtifactResource({ userId: null, purpose: "RESEARCH", scopeWorkspaceId: "ws-1" }, ids)).rejects.toBeInstanceOf(McpAuthzError)
    expect(prisma.artifact.findFirst).not.toHaveBeenCalled()
  })

  it("scopes the artifact lookup to the URI workspace", async () => {
    prisma.artifact.findFirst.mockResolvedValue(null)
    await expect(readArtifactResource(actor, ids)).rejects.toThrow(/not found/)
    expect(prisma.artifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "art-1", workspaceId: "ws-1" } }))
  })

  it("rejects content over the cap by recorded size without reading storage", async () => {
    prisma.artifactRevision.findFirst.mockResolvedValue(revision({ byteSize: MAX_ARTIFACT_RESOURCE_BYTES + 1 }))
    await expect(readArtifactResource(actor, ids)).rejects.toThrow(/5 MiB/)
    expect(storage.get).not.toHaveBeenCalled()
  })

  it("rejects content over the cap by actual size", async () => {
    storage.get.mockResolvedValue(new Uint8Array(MAX_ARTIFACT_RESOURCE_BYTES + 1))
    await expect(readArtifactResource(actor, ids)).rejects.toThrow(/5 MiB/)
  })

  it("accepts an injected storage", async () => {
    const injected = { put: vi.fn(), del: vi.fn(), get: vi.fn().mockResolvedValue(bytes("inj")) }
    const result = await readArtifactResource(actor, ids, { storage: injected })
    expect(result.contents[0]).toMatchObject({ text: "inj" })
    expect(storage.get).not.toHaveBeenCalled()
  })
})

describe("artifact:// URI templates", () => {
  const latest = new UriTemplate("artifact://{workspaceId}/{artifactId}")
  const pinned = new UriTemplate("artifact://{workspaceId}/{artifactId}/{revisionId}")

  it("matches the latest-revision form only on the short template", () => {
    expect(latest.match("artifact://ws-1/art-1")).toEqual({ workspaceId: "ws-1", artifactId: "art-1" })
    expect(pinned.match("artifact://ws-1/art-1")).toBeNull()
  })

  it("matches the pinned-revision form on the long template", () => {
    expect(pinned.match("artifact://ws-1/art-1/rev-1")).toEqual({ workspaceId: "ws-1", artifactId: "art-1", revisionId: "rev-1" })
  })
})
