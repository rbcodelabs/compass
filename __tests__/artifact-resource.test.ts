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

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  MAX_ARTIFACT_BLOB_WINDOW_BYTES,
  MAX_ARTIFACT_RESOURCE_BYTES,
  MAX_ARTIFACT_TEXT_WINDOW_CHARS,
  listArtifactResources,
  parseArtifactReadRange,
  parseArtifactResourceRequest,
  readArtifactResource,
  registerArtifactResources,
} from "@/lib/artifact-resource"
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

const read = (range: { offset?: number; length?: number }, ids2: typeof ids & { revisionId?: string } = ids) =>
  readArtifactResource(actor, ids2, { range }).then((r) => r.contents[0] as { text?: string; blob?: string; _meta: Record<string, unknown> })

async function pageAll(kind: "text" | "blob", length?: number) {
  const parts: string[] = []
  const metas: Array<Record<string, unknown>> = []
  let offset: number | null = 0
  while (offset !== null) {
    const c = await read({ offset, length })
    parts.push((kind === "text" ? c.text : c.blob) ?? "")
    metas.push(c._meta)
    offset = c._meta.nextOffset as number | null
  }
  return { parts, metas }
}

describe("ranged reads - text", () => {
  it("returns small content whole with finished paging meta", async () => {
    storage.get.mockResolvedValue(bytes("<html>hi</html>"))
    const c = await read({})
    expect(c.text).toBe("<html>hi</html>")
    expect(c._meta).toMatchObject({ totalLength: 15, offset: 0, length: 15, nextOffset: null, truncated: false, unit: "chars" })
    expect(c._meta).not.toHaveProperty("hint")
  })

  it("returns only the first window by default for large content, and says so", async () => {
    storage.get.mockResolvedValue(bytes("a".repeat(282_000)))
    const c = await read({})
    expect(c.text).toHaveLength(MAX_ARTIFACT_TEXT_WINDOW_CHARS)
    expect(c._meta).toMatchObject({ totalLength: 282_000, offset: 0, length: MAX_ARTIFACT_TEXT_WINDOW_CHARS, nextOffset: MAX_ARTIFACT_TEXT_WINDOW_CHARS, truncated: true, unit: "chars" })
    expect(c._meta.hint).toContain("?offset=90000")
    expect(c._meta.hint).toContain("artifact://ws-1/art-1/rev-1")
  })

  it("pages a body larger than the window and reassembles it exactly", async () => {
    const body = Array.from({ length: 282_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
    storage.get.mockResolvedValue(bytes(body))
    const { parts, metas } = await pageAll("text")
    expect(parts).toHaveLength(4)
    expect(parts.join("")).toBe(body)
    expect(metas.at(-1)).toMatchObject({ nextOffset: null, truncated: false })
  })

  it("clamps an oversized length to the window", async () => {
    storage.get.mockResolvedValue(bytes("a".repeat(200_000)))
    const c = await read({ offset: 10, length: 5_000_000 })
    expect(c.text).toHaveLength(MAX_ARTIFACT_TEXT_WINDOW_CHARS)
    expect(c._meta).toMatchObject({ offset: 10, nextOffset: 10 + MAX_ARTIFACT_TEXT_WINDOW_CHARS })
  })

  it("never splits a surrogate pair or multibyte char across pages", async () => {
    const body = "a😀é漢".repeat(500)
    storage.get.mockResolvedValue(bytes(body))
    for (const length of [1, 2, 3, 7, 10]) {
      const { parts } = await pageAll("text", length)
      for (const part of parts) {
        expect(part).not.toMatch(/(^[\udc00-\udfff])|([\ud800-\udbff]$)/)
        expect(part).not.toContain("\ufffd")
      }
      expect(parts.join("")).toBe(body)
    }
  })

  it("rejects an offset that lands inside a surrogate pair", async () => {
    storage.get.mockResolvedValue(bytes("a😀b"))
    await expect(read({ offset: 2 })).rejects.toThrow(/surrogate/)
  })

  it("offset == total returns empty with nextOffset null", async () => {
    storage.get.mockResolvedValue(bytes("abc"))
    const c = await read({ offset: 3 })
    expect(c.text).toBe("")
    expect(c._meta).toMatchObject({ totalLength: 3, offset: 3, length: 0, nextOffset: null, truncated: false })
  })

  it("rejects offset past the end", async () => {
    storage.get.mockResolvedValue(bytes("abc"))
    await expect(read({ offset: 4 })).rejects.toThrow(/past the end/)
  })

  it("works on the pinned-revision form and for external links", async () => {
    storage.get.mockResolvedValue(bytes("0123456789"))
    const c = await read({ offset: 2, length: 3 }, { ...ids, revisionId: "rev-0" })
    expect(c.text).toBe("234")
    expect(c._meta.nextOffset).toBe(5)
    prisma.artifactRevision.findFirst.mockResolvedValue(revision({ blobPathname: null, mimeType: null, externalUrl: "https://example.com/x" }))
    expect((await read({ offset: 17 })).text).toBe("om/x")
  })
})

describe("ranged reads - blob", () => {
  const raw = Uint8Array.from({ length: 150_001 }, (_, i) => (i * 31 + 7) % 256)

  beforeEach(() => {
    prisma.artifactRevision.findFirst.mockResolvedValue(revision({ mimeType: "application/pdf" }))
    storage.get.mockResolvedValue(raw)
  })

  it("pages by aligned bytes and the base64 chunks reassemble to the original bytes", async () => {
    const { parts, metas } = await pageAll("blob")
    expect(parts).toHaveLength(3)
    expect(metas[0]).toMatchObject({ unit: "bytes", totalLength: 150_001, length: MAX_ARTIFACT_BLOB_WINDOW_BYTES, nextOffset: MAX_ARTIFACT_BLOB_WINDOW_BYTES, truncated: true })
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, "base64")))).toEqual(Buffer.from(raw))
    // every chunk but the last is padding-free, so strings also concatenate cleanly
    expect(parts.slice(0, -1).every((p) => !p.includes("="))).toBe(true)
  })

  it("rounds odd lengths down to a multiple of 3 so nextOffset stays aligned", async () => {
    const c = await read({ offset: 0, length: 100 })
    expect(c._meta).toMatchObject({ length: 99, nextOffset: 99 })
  })

  it("rejects an unaligned offset", async () => {
    await expect(read({ offset: 4 })).rejects.toThrow(/multiple of 3/)
  })

  it("offset == total returns an empty blob", async () => {
    const c = await read({ offset: raw.byteLength })
    expect(c.blob).toBe("")
    expect(c._meta).toMatchObject({ length: 0, nextOffset: null, truncated: false })
  })

  it("keeps the 5 MiB total cap", async () => {
    storage.get.mockResolvedValue(new Uint8Array(MAX_ARTIFACT_RESOURCE_BYTES + 1))
    await expect(read({})).rejects.toThrow(/5 MiB/)
  })
})

describe("parseArtifactReadRange", () => {
  it("parses offset and length", () => {
    expect(parseArtifactReadRange("?offset=10&length=20")).toEqual({ offset: 10, length: 20 })
    expect(parseArtifactReadRange("")).toEqual({})
  })
  it.each(["offset=-1", "offset=1.5", "offset=abc", "offset=", "length=0", "length=-5", "offset=1&offset=2", "limit=5", "offset=99999999999999999999"])(
    "rejects %s",
    (q) => expect(() => parseArtifactReadRange(q)).toThrow()
  )
})

describe("artifact:// URI templates with a query string", () => {
  const latest = new UriTemplate("artifact://{workspaceId}/{artifactId}")
  const pinned = new UriTemplate("artifact://{workspaceId}/{artifactId}/{revisionId}")

  it("the SDK matches but swallows the query into the last variable", () => {
    expect(latest.match("artifact://ws-1/art-1?offset=5&length=9")).toEqual({ workspaceId: "ws-1", artifactId: "art-1?offset=5&length=9" })
    expect(pinned.match("artifact://ws-1/art-1/rev-1?offset=5")).toEqual({ workspaceId: "ws-1", artifactId: "art-1", revisionId: "rev-1?offset=5" })
    expect(latest.match("artifact://ws-1/art-1/rev-1?offset=5")).toBeNull()
  })

  it("parseArtifactResourceRequest splits the query back out", () => {
    expect(parseArtifactResourceRequest({ workspaceId: "ws-1", artifactId: "art-1?offset=5&length=9" })).toEqual({
      ids: { workspaceId: "ws-1", artifactId: "art-1" },
      range: { offset: 5, length: 9 },
    })
    expect(parseArtifactResourceRequest({ workspaceId: "ws-1", artifactId: "art-1", revisionId: "rev-1?length=9" })).toEqual({
      ids: { workspaceId: "ws-1", artifactId: "art-1", revisionId: "rev-1" },
      range: { length: 9 },
    })
    expect(parseArtifactResourceRequest({ workspaceId: "ws-1", artifactId: "art-1" }).range).toEqual({})
  })
})

describe("registerArtifactResources against the real SDK server", () => {
  async function connect() {
    const server = new McpServer({ name: "t", version: "1" })
    registerArtifactResources(server, () => actor)
    const client = new Client({ name: "c", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }
  const body = "x".repeat(200_000)
  const readUri = async (client: Client, uri: string) => {
    const result = await client.readResource({ uri })
    return result.contents[0] as { text: string; _meta: Record<string, unknown> }
  }

  it("serves ?offset/length on the latest form and the pinned form, and reassembles", async () => {
    storage.get.mockResolvedValue(bytes(body))
    const client = await connect()
    for (const base of ["artifact://ws-1/art-1", "artifact://ws-1/art-1/rev-1"]) {
      const first = await readUri(client, base)
      expect(first.text).toHaveLength(MAX_ARTIFACT_TEXT_WINDOW_CHARS)
      const second = await readUri(client, `${base}?offset=${first._meta.nextOffset}&length=100000`)
      expect(second._meta).toMatchObject({ offset: MAX_ARTIFACT_TEXT_WINDOW_CHARS, length: MAX_ARTIFACT_TEXT_WINDOW_CHARS })
      const last = await readUri(client, `${base}?offset=180000`)
      expect(last).toMatchObject({ _meta: { nextOffset: null, length: 20_000 } })
    }
    // the ids reaching the DB are clean, never carrying the query
    expect(prisma.artifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "art-1", workspaceId: "ws-1" } }))
    expect(prisma.artifactRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rev-1", artifactId: "art-1" } }))
    await client.close()
  })

  it("surfaces invalid params as an error", async () => {
    storage.get.mockResolvedValue(bytes(body))
    const client = await connect()
    await expect(client.readResource({ uri: "artifact://ws-1/art-1?offset=-3" })).rejects.toThrow(/offset/)
    await expect(client.readResource({ uri: "artifact://ws-1/art-1?bogus=1" })).rejects.toThrow(/Unknown query parameter/)
    await client.close()
  })

  it("documents paging in the registered resource description", async () => {
    const client = await connect()
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.description).join(" ")).toMatch(/offset=N&length=M/)
    await client.close()
  })
})
