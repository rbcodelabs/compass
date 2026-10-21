/**
 * Geode doc sync step 2: the mutation endpoints, driven through the real REST adapter
 * (auth/scope -> registry -> execute -> doc-sync-mutations -> doc-fs -> document-service) against the
 * in-memory Prisma fake, and checked against the scan the plugin will read afterwards.
 */
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as syncFake from "./helpers/doc-sync-fake"
import { resetStore, store } from "./helpers/doc-sync-fake"

const { validateProgrammaticAuth } = vi.hoisted(() => ({ validateProgrammaticAuth: vi.fn() }))
vi.mock("@/lib/programmatic-auth", () => ({ validateProgrammaticAuth }))
vi.mock("@/lib/db", () => ({ default: () => syncFake.fake }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))

import { handleRestRequest } from "@/lib/rest/http"
import { createDocument } from "@/lib/document-service"
import { runWithMcpActor } from "@/lib/mcp-authz"
import { verifyDocSync } from "../scripts/verify-doc-sync"

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const BASE = `http://localhost/api/v1/workspaces/${WS}/sync/docs`
const SERVICE = { valid: true, userId: null, purpose: "SERVICE", scopeWorkspaceId: null }
const USER_WRITER = { valid: true, userId: "user-1", purpose: "USER", scopeWorkspaceId: null, scopes: ["api:write"] }
const USER_READER = { valid: true, userId: "user-1", purpose: "USER", scopeWorkspaceId: null, scopes: ["api:read"] }

async function call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const response = await handleRestRequest(new Request(`${BASE}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), method)
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}
const create = async (path: string, content = "# Hello\n", operationKey = `key-${path}`) => (await call("POST", "", { path, content, operationKey })).json
const scan = (cursor?: string) => call("GET", `/scan${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")

beforeEach(() => {
  resetStore()
  vi.stubEnv("DOCS_SYNC_ENABLED", "1")
  vi.stubEnv("DOCS_SYNC_EPOCH", "")
  validateProgrammaticAuth.mockResolvedValue(SERVICE)
})
afterEach(() => vi.unstubAllEnvs())

describe("flag off", () => {
  it("every sync endpoint is a 404, including the mutations", async () => {
    const doc = await create("A.md")
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    const id = doc.id
    const results = await Promise.all([
      call("GET", `/${id}`),
      call("POST", "", { path: "B.md", content: "x", operationKey: "k" }),
      call("PUT", `/${id}`, { content: "x", expectedRevision: doc.revision, operationKey: "k2" }),
      call("POST", `/${id}/move`, { path: "C.md", expectedRevision: doc.revision }),
      call("DELETE", `/${id}?expectedRevision=${doc.revision}`),
    ])
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
    expect(store.docs).toHaveLength(1)
  })
})

describe("authz", () => {
  it("rejects a missing token with 401", async () => {
    validateProgrammaticAuth.mockResolvedValue({ valid: false })
    expect((await call("POST", "", { path: "A.md", content: "x", operationKey: "k" })).status).toBe(401)
  })

  it("rejects a read-only token on every mutation but allows the read", async () => {
    const doc = await create("A.md")
    validateProgrammaticAuth.mockResolvedValue(USER_READER)
    const writes = await Promise.all([
      call("POST", "", { path: "B.md", content: "x", operationKey: "k" }),
      call("PUT", `/${doc.id}`, { content: "x", expectedRevision: doc.revision, operationKey: "k2" }),
      call("POST", `/${doc.id}/move`, { path: "C.md", expectedRevision: doc.revision }),
      call("DELETE", `/${doc.id}?expectedRevision=${doc.revision}`),
    ])
    expect(writes.map((r) => r.status)).toEqual([403, 403, 403, 403])
    expect(writes[0].json).toMatchObject({ code: "insufficient_scope" })
    expect((await call("GET", `/${doc.id}`)).status).toBe(200)
  })

  it("a user who is not a member of the workspace gets 404 and nothing is written", async () => {
    validateProgrammaticAuth.mockResolvedValue(USER_WRITER)
    store.denyWorkspace = true
    expect((await call("POST", "", { path: "A.md", content: "x", operationKey: "k" })).status).toBe(404)
    expect(store.docs).toHaveLength(0)
  })

  it("a member with a write token can mutate", async () => {
    validateProgrammaticAuth.mockResolvedValue(USER_WRITER)
    const created = await call("POST", "", { path: "A.md", content: "x", operationKey: "k" })
    expect(created.status).toBe(201)
  })
})

describe("create", () => {
  it("returns 201 with a scan-shaped entry and shows up in the next delta with the same revision", async () => {
    await create("Seed.md")
    const before = (await scan()).json
    const created = await call("POST", "", { path: "Folder/Note.md", content: "# Note\nbody\n", operationKey: "op-1" })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ path: "Folder/Note", kind: "file", operationKey: "op-1" })
    const delta = (await scan(before.cursor)).json
    expect(delta.mode).toBe("delta")
    const note = delta.entries.find((e: { id: string }) => e.id === created.json.id)
    expect(note).toMatchObject({ path: "Folder/Note", revision: created.json.revision, size: created.json.size, hash: created.json.hash })
    // The missing parent was created implicitly and is reported as a folder: no folder endpoints are needed.
    expect(delta.entries.find((e: { path: string }) => e.path === "Folder")).toMatchObject({ kind: "folder" })
  })

  it("is idempotent on operationKey: the same request replays, no duplicate doc or change", async () => {
    const first = await call("POST", "", { path: "A.md", content: "# A\n", operationKey: "same" })
    const changes = store.changes.length
    const second = await call("POST", "", { path: "A.md", content: "# A\n", operationKey: "same" })
    expect(second.status).toBe(201)
    expect(second.json).toEqual(first.json)
    expect(store.docs).toHaveLength(1)
    expect(store.changes).toHaveLength(changes)
  })

  it("the same operationKey with different content is 409 operation_conflict", async () => {
    await call("POST", "", { path: "A.md", content: "# A\n", operationKey: "same" })
    const clash = await call("POST", "", { path: "A.md", content: "# Different\n", operationKey: "same" })
    expect(clash).toMatchObject({ status: 409, json: { code: "operation_conflict" } })
  })

  it("rejects non-.md paths with 422 unsupported_extension", async () => {
    for (const path of ["notes.txt", "image.png", "Note", "dir/Note.markdown"]) {
      expect(await call("POST", "", { path, content: "x", operationKey: `k-${path}` })).toMatchObject({ status: 422, json: { code: "unsupported_extension" } })
    }
    expect(store.docs).toHaveLength(0)
  })

  it("rejects malformed paths with 422 invalid_path", async () => {
    for (const path of ["a//b.md", "/a.md", "../a.md", ".md"]) {
      expect(await call("POST", "", { path, content: "x", operationKey: `k-${path}` })).toMatchObject({ status: 422, json: { code: "invalid_path" } })
    }
  })

  it("an occupied path is 409 path_conflict", async () => {
    await create("A.md")
    expect(await call("POST", "", { path: "A.md", content: "other", operationKey: "different-key" })).toMatchObject({ status: 409, json: { code: "path_conflict" } })
  })

  it("will not create under a canvas or at a canvas's path (outside the sync scope)", async () => {
    await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => createDocument({ workspaceId: WS, title: "Board", docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) } as never, { authorName: "t" }))
    expect(await call("POST", "", { path: "Board/Child.md", content: "x", operationKey: "k1" })).toMatchObject({ status: 409, json: { code: "path_conflict" } })
    expect(await call("POST", "", { path: "Board.md", content: "x", operationKey: "k2" })).toMatchObject({ status: 409, json: { code: "path_conflict" } })
  })

  it("validates the body strictly", async () => {
    expect((await call("POST", "", { path: "A.md", content: "x" })).status).toBe(422) // operationKey required
    expect((await call("POST", "", { path: "A.md", content: "x", operationKey: "k", extra: 1 })).status).toBe(422)
  })
})

describe("read", () => {
  it("returns frontmatter + body exactly as the scan's size and hash describe, and the scan is not captured as an id", async () => {
    const created = await create("A.md", "# A\nbody\n")
    const read = await call("GET", `/${created.id}`)
    expect(read.status).toBe(200)
    expect(read.json).toMatchObject({ id: created.id, path: "A", kind: "file", revision: created.revision })
    expect(read.json.content).toContain("compass_doc_id")
    expect(read.json.size).toBe(Buffer.byteLength(read.json.content, "utf8"))
    expect(read.json.hash).toBe(sha(read.json.content))
    const scanned = (await scan()).json.entries.find((e: { id: string }) => e.id === created.id)
    expect(scanned).toMatchObject({ size: read.json.size, hash: read.json.hash, revision: read.json.revision })
  })

  it("?revision= must match the current revision", async () => {
    const created = await create("A.md")
    expect((await call("GET", `/${created.id}?revision=${encodeURIComponent(created.revision)}`)).status).toBe(200)
    expect(await call("GET", `/${created.id}?revision=stale`)).toMatchObject({ status: 409, json: { code: "revision_conflict" } })
  })

  it("404s for unknown ids and for docs outside the sync scope", async () => {
    expect((await call("GET", "/99999999-9999-4999-8999-999999999999")).status).toBe(404)
    const canvas = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => createDocument({ workspaceId: WS, title: "Board", docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) } as never, { authorName: "t" }))
    const under = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => createDocument({ workspaceId: WS, title: "Under", parentId: canvas.id, content: "x" } as never, { authorName: "t" }))
    expect((await call("GET", `/${canvas.id}`)).status).toBe(404)
    expect((await call("GET", `/${under.id}`)).status).toBe(404)
  })
})

describe("update", () => {
  it("requires expectedRevision and operationKey", async () => {
    const doc = await create("A.md")
    expect((await call("PUT", `/${doc.id}`, { content: "x", operationKey: "k" })).status).toBe(422)
    expect((await call("PUT", `/${doc.id}`, { content: "x", expectedRevision: doc.revision })).status).toBe(422)
  })

  it("replaces the content, returns the new revision, and the delta agrees", async () => {
    const doc = await create("A.md")
    const cursor = (await scan()).json.cursor
    const updated = await call("PUT", `/${doc.id}`, { content: "# A2\nnew\n", expectedRevision: doc.revision, operationKey: "u1" })
    expect(updated.status).toBe(200)
    expect(updated.json.revision).not.toBe(doc.revision)
    expect(updated.json).toMatchObject({ id: doc.id, operationKey: "u1" })
    const delta = (await scan(cursor)).json
    expect(delta.entries).toMatchObject([{ id: doc.id, revision: updated.json.revision, hash: updated.json.hash, size: updated.json.size }])
    expect((await call("GET", `/${doc.id}`)).json.content).toContain("new")
  })

  it("a stale expectedRevision is 409 revision_conflict and changes nothing", async () => {
    const doc = await create("A.md", "# A\n")
    await call("PUT", `/${doc.id}`, { content: "# first\n", expectedRevision: doc.revision, operationKey: "u1" })
    const stale = await call("PUT", `/${doc.id}`, { content: "# lost\n", expectedRevision: doc.revision, operationKey: "u2" })
    expect(stale).toMatchObject({ status: 409, json: { code: "revision_conflict" } })
    expect((await call("GET", `/${doc.id}`)).json.content).toContain("first")
  })

  it("is idempotent on operationKey: a retry after success replays the first result", async () => {
    const doc = await create("A.md")
    const body = { content: "# A2\n", expectedRevision: doc.revision, operationKey: "u1" }
    const first = await call("PUT", `/${doc.id}`, body)
    const changes = store.changes.length
    const replay = await call("PUT", `/${doc.id}`, body)
    expect(replay.status).toBe(200)
    expect(replay.json).toEqual(first.json)
    expect(store.changes).toHaveLength(changes)
  })

  it("404s for out-of-scope or unknown docs", async () => {
    expect((await call("PUT", "/99999999-9999-4999-8999-999999999999", { content: "x", expectedRevision: "r", operationKey: "k" })).status).toBe(404)
  })
})

describe("move", () => {
  it("renames and reparents, creating missing folders; the delta shows the doc at its new path", async () => {
    const doc = await create("A.md")
    const cursor = (await scan()).json.cursor
    const moved = await call("POST", `/${doc.id}/move`, { path: "New/Dir/Renamed.md", expectedRevision: doc.revision })
    expect(moved.status).toBe(200)
    expect(moved.json).toMatchObject({ id: doc.id, path: "New/Dir/Renamed" })
    const delta = (await scan(cursor)).json
    expect(delta.entries.find((e: { id: string }) => e.id === doc.id)).toMatchObject({ path: "New/Dir/Renamed", revision: moved.json.revision })
    expect(delta.entries.filter((e: { kind: string }) => e.kind === "folder").map((e: { path: string }) => e.path).sort()).toEqual(["New", "New/Dir"])
  })

  it("requires expectedRevision; a stale one is 409 revision_conflict and creates no folders", async () => {
    const doc = await create("A.md")
    expect((await call("POST", `/${doc.id}/move`, { path: "X/B.md" })).status).toBe(422)
    const docs = store.docs.length
    expect(await call("POST", `/${doc.id}/move`, { path: "X/B.md", expectedRevision: "stale" })).toMatchObject({ status: 409, json: { code: "revision_conflict" } })
    expect(store.docs).toHaveLength(docs)
  })

  it("an occupied target is 409 path_conflict", async () => {
    const a = await create("A.md")
    await create("B.md")
    expect(await call("POST", `/${a.id}/move`, { path: "B.md", expectedRevision: a.revision })).toMatchObject({ status: 409, json: { code: "path_conflict" } })
  })

  it("moving to the current path is a 200 no-op; non-.md targets are 422", async () => {
    const a = await create("A.md")
    const same = await call("POST", `/${a.id}/move`, { path: "A.md", expectedRevision: a.revision })
    expect(same).toMatchObject({ status: 200, json: { revision: a.revision } })
    expect(await call("POST", `/${a.id}/move`, { path: "A.txt", expectedRevision: a.revision })).toMatchObject({ status: 422, json: { code: "unsupported_extension" } })
  })

  it("will not move into the sync scope's blind spot (under a canvas)", async () => {
    const a = await create("A.md")
    await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => createDocument({ workspaceId: WS, title: "Board", docType: "CANVAS", content: JSON.stringify({ nodes: [], edges: [] }) } as never, { authorName: "t" }))
    expect(await call("POST", `/${a.id}/move`, { path: "Board/A.md", expectedRevision: a.revision })).toMatchObject({ status: 409, json: { code: "path_conflict" } })
  })
})

describe("delete", () => {
  it("requires expectedRevision (query)", async () => {
    const doc = await create("A.md")
    expect((await call("DELETE", `/${doc.id}`)).status).toBe(422)
  })

  it("a stale expectedRevision is 409 revision_conflict", async () => {
    const doc = await create("A.md")
    expect(await call("DELETE", `/${doc.id}?expectedRevision=stale`)).toMatchObject({ status: 409, json: { code: "revision_conflict" } })
    expect(store.docs).toHaveLength(1)
  })

  it("deletes a leaf with 204 and the delta carries a tombstone with the last path", async () => {
    const doc = await create("Dir/Leaf.md")
    const cursor = (await scan()).json.cursor
    const response = await call("DELETE", `/${doc.id}?expectedRevision=${encodeURIComponent(doc.revision)}`)
    expect(response.status).toBe(204)
    const delta = (await scan(cursor)).json
    expect(delta.entries.find((e: { id: string }) => e.id === doc.id)).toMatchObject({ kind: "tombstone", path: "Dir/Leaf" })
    expect((await call("DELETE", `/${doc.id}?expectedRevision=${encodeURIComponent(doc.revision)}`)).status).toBe(404)
  })

  it("a doc with children is 409 has_children; deleting leaves first then the folder works", async () => {
    const leaf = await create("Dir/Leaf.md")
    const folder = (await scan()).json.entries.find((e: { path: string }) => e.path === "Dir")
    expect(await call("DELETE", `/${folder.id}?expectedRevision=${encodeURIComponent(folder.revision)}`)).toMatchObject({ status: 409, json: { code: "has_children" } })
    expect((await call("DELETE", `/${leaf.id}?expectedRevision=${encodeURIComponent(leaf.revision)}`)).status).toBe(204)
    const folderNow = (await scan()).json.entries.find((e: { path: string }) => e.path === "Dir")
    expect((await call("DELETE", `/${folder.id}?expectedRevision=${encodeURIComponent(folderNow.revision)}`)).status).toBe(204)
    expect(store.docs).toHaveLength(0)
  })
})

describe("end to end like the plugin", () => {
  it("scan -> create -> update -> conflict -> move -> delete -> delta", async () => {
    const start = (await scan()).json
    const created = await call("POST", "", { path: "Notes/Plan.md", content: "# Plan\n", operationKey: "e2e-1" })
    const updated = await call("PUT", `/${created.json.id}`, { content: "# Plan v2\n", expectedRevision: created.json.revision, operationKey: "e2e-2" })
    expect((await call("PUT", `/${created.json.id}`, { content: "# stale\n", expectedRevision: created.json.revision, operationKey: "e2e-3" })).status).toBe(409)
    const moved = await call("POST", `/${created.json.id}/move`, { path: "Archive/Plan.md", expectedRevision: updated.json.revision })
    const mid = (await scan(start.cursor)).json
    expect(mid.entries.find((e: { id: string }) => e.id === created.json.id)).toMatchObject({ path: "Archive/Plan", revision: moved.json.revision, hash: moved.json.hash })
    await call("DELETE", `/${created.json.id}?expectedRevision=${encodeURIComponent(moved.json.revision)}`)
    const end = (await scan(mid.cursor)).json
    expect(end.entries).toContainEqual(expect.objectContaining({ id: created.json.id, kind: "tombstone", path: "Archive/Plan" }))
  })
})

describe("scripts/verify-doc-sync.ts", () => {
  const inProcess = (async (url: string | URL | Request, init?: RequestInit) =>
    handleRestRequest(new Request(url as string, init), (init?.method ?? "GET") as "GET")) as typeof fetch
  const config = { baseUrl: "https://preview.example.vercel.app", token: "cmp_x", workspaceId: WS, fetchImpl: inProcess, log: () => undefined }

  it("passes end to end against the real handlers and cleans up after itself", async () => {
    await create("Existing.md")
    const checks = await verifyDocSync(config)
    expect(checks).toBeGreaterThanOrEqual(9)
    expect(store.docs.map((d) => d.title)).toEqual(["Existing"]) // the throwaway folder is gone
  })

  it("throws (so the CLI exits nonzero) when the surface is not enabled", async () => {
    vi.stubEnv("DOCS_SYNC_ENABLED", "")
    await expect(verifyDocSync(config)).rejects.toThrow()
  })

  it("refuses production and missing configuration", async () => {
    await expect(verifyDocSync({ baseUrl: "https://compass.rbcodelabs.com", token: "t", workspaceId: WS })).rejects.toThrow(/production/)
    await expect(verifyDocSync({ baseUrl: "", token: "", workspaceId: "" })).rejects.toThrow(/required/)
  })
})
