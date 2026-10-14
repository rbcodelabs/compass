/**
 * Worker doc-tree reconciliation callback (lib/agent-docs-callback.ts, ADR 0019).
 *
 * Same trust boundary as the session upload: bearer-shaped worker token checked
 * before the body is read, workspace and user taken from the run row, a
 * host-signed baseline manifest so nothing the sandbox sends can name a doc the
 * baseline did not contain, every reported path validated server-side, and hard
 * deletes only ever applied for docs the agent explicitly removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const docFs = vi.hoisted(() => ({
  writeDocById: vi.fn(),
  moveDocById: vi.fn(),
  deleteDocById: vi.fn(),
  createPath: vi.fn(),
  resolvePath: vi.fn(),
  recordConflictingSnapshot: vi.fn(),
  deriveOperationId: vi.fn((base: string, salt: string) => `${base}::${salt}`),
}))
vi.mock("@/lib/doc-fs", () => docFs)

import { handleAgentDocsReconcile } from "@/lib/agent-docs-callback"
import { signDocManifest } from "@/lib/agent-doc-manifest"
import { agentRunSandboxName, hashAgentRunWorkerToken } from "@/lib/agent-runs"
import { DocumentError } from "@/lib/document-service"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const TOKEN = "t".repeat(43)
const URL_BASE = `https://c.test/api/internal/agent/runs/${RUN_ID}/docs`
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WS,
    userId: "user-1",
    status: "RUNNING",
    kind: "CHAT",
    claimId: null,
    apiKeyId: "key-1",
    sandboxName: agentRunSandboxName(RUN_ID),
    packProvenance: "[]",
    workerTokenHash: hashAgentRunWorkerToken(TOKEN),
    deadlineAt: new Date(Date.now() + 600_000),
    lastSeq: 0,
    eventCount: 0,
    payloadBytes: 0,
    createdAt: new Date(5_000),
    ...overrides,
  }
}

function harness(row = runRow(), member: { id: string } | null = { id: WS }) {
  const prisma: Any = {
    agentRun: { findUnique: vi.fn().mockResolvedValue(row) },
    workspace: { findFirst: vi.fn().mockResolvedValue(member) },
  }
  return prisma
}

const baseline = [
  { path: "Product", docId: "doc-1", revision: "rev-1", content: "hello" },
  { path: "Product/Plan", docId: "doc-2", revision: "rev-2", content: "plan" },
]
const unchangedFiles = [
  { path: "Product", frontmatterDocId: "doc-1", contentSha256: sha("hello") },
  { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") },
]

function post(body: unknown, { token = TOKEN, url = URL_BASE }: { token?: string | null; url?: string } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function validBody(files: unknown[], extra: Record<string, unknown> = {}, manifest = signDocManifest(RUN_ID, WS, baseline)) {
  return { manifest, files, incomplete: false, deletedPaths: [], ...extra }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTH_SECRET = "test-auth-secret"
  docFs.writeDocById.mockResolvedValue({ docId: "d", revision: "r" })
  docFs.moveDocById.mockResolvedValue({ docId: "d", revision: "r" })
  docFs.deleteDocById.mockResolvedValue(undefined)
  docFs.createPath.mockResolvedValue({ docId: "n", created: true, revision: "r", path: "p" })
  docFs.recordConflictingSnapshot.mockResolvedValue(undefined)
})

describe("agent run docs callback — authentication", () => {
  it("requires a bearer worker token and does not touch docs without one", async () => {
    const response = await handleAgentDocsReconcile(post(validBody([]), { token: null }), RUN_ID, harness())
    expect(response.status).toBe(401)
    expect(docFs.writeDocById).not.toHaveBeenCalled()
  })

  it("rejects a wrong token", async () => {
    const response = await handleAgentDocsReconcile(post(validBody([]), { token: "x".repeat(43) }), RUN_ID, harness())
    expect(response.status).toBe(401)
  })

  it("rejects query strings and non-uuid run ids", async () => {
    expect((await handleAgentDocsReconcile(post(validBody([]), { url: `${URL_BASE}?x=1` }), RUN_ID, harness())).status).toBe(400)
    expect((await handleAgentDocsReconcile(post(validBody([])), "not-a-uuid", harness())).status).toBe(400)
  })

  it("never reconciles for a claim-scoped handoff run", async () => {
    const response = await handleAgentDocsReconcile(post(validBody([])), RUN_ID, harness(runRow({ claimId: "claim-1" })))
    expect(response.status).toBe(409)
    expect(docFs.writeDocById).not.toHaveBeenCalled()
  })

  it("refuses when the user no longer belongs to the workspace", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "changed" }])),
      RUN_ID,
      harness(runRow(), null)
    )
    expect(response.status).toBe(403)
    expect(docFs.writeDocById).not.toHaveBeenCalled()
  })
})

describe("agent run docs callback — manifest and body validation", () => {
  it("rejects a manifest signed for a different run", async () => {
    const forged = signDocManifest("99999999-9999-4999-8999-999999999999", WS, baseline)
    const response = await handleAgentDocsReconcile(post(validBody([], {}, forged)), RUN_ID, harness())
    expect(response.status).toBe(422)
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
  })

  it("rejects a tampered manifest (sandbox adding a docId it was never shown)", async () => {
    const manifest = JSON.parse(JSON.stringify(signDocManifest(RUN_ID, WS, baseline)))
    manifest.entries.push({ path: "Secret", docId: "foreign-doc", revision: null, contentSha256: "0".repeat(64) })
    const response = await handleAgentDocsReconcile(post(validBody([], {}, manifest)), RUN_ID, harness())
    expect(response.status).toBe(422)
  })

  it("rejects a non-hex signature before it is ever decoded", async () => {
    const manifest = JSON.parse(JSON.stringify(signDocManifest(RUN_ID, WS, baseline)))
    manifest.signature = "zz" + manifest.signature.slice(2)
    expect((await handleAgentDocsReconcile(post(validBody([], {}, manifest)), RUN_ID, harness())).status).toBe(422)
  })

  it("rejects non-JSON bodies and malformed file lists", async () => {
    expect((await handleAgentDocsReconcile(post("not json"), RUN_ID, harness())).status).toBe(400)
    expect((await handleAgentDocsReconcile(post(validBody([{ path: "A" }])), RUN_ID, harness())).status).toBe(400)
    expect((await handleAgentDocsReconcile(post(validBody("nope" as unknown as unknown[])), RUN_ID, harness())).status).toBe(400)
  })

  it("rejects a changed file that arrives with a hash and no content", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", contentSha256: sha("tampered") }, unchangedFiles[1]])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(400)
    expect(docFs.writeDocById).not.toHaveBeenCalled()
  })

  it("enforces the body size cap even when content-length lies", async () => {
    const huge = "x".repeat(9 * 1024 * 1024)
    const response = await handleAgentDocsReconcile(post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: huge }])), RUN_ID, harness())
    expect(response.status).toBe(413)
  })

  it.each([
    ["a dot-prefixed segment", ".hidden/_secret"],
    ["a dot segment", "Product/./Plan"],
    ["a parent segment", "Product/../Plan"],
    ["a leading dot-dot", "../Escape"],
    ["a NUL byte", "Pro\0duct"],
    ["a control character", "Pro\x07duct"],
    ["a colon", "Q3: Plan"],
    ["a backslash", "Product\\Plan"],
    ["node_modules", "Product/node_modules"],
    ["the reserved _doc.md name", "Product/_doc.md"],
    ["an empty segment", "Product//Plan"],
    ["a leading slash", "/Product"],
    ["a trailing slash", "Product/"],
    ["trailing whitespace in a segment", "Product /Plan"],
    ["a trailing dot", "Product."],
    ["a segment over 200 bytes", "x".repeat(201)],
    ["an over-deep path", Array.from({ length: 31 }, (_, i) => `d${i}`).join("/")],
  ])("rejects %s in a reported file path with 400 and applies nothing", async (_label, badPath) => {
    const response = await handleAgentDocsReconcile(
      post(validBody([...unchangedFiles, { path: badPath, frontmatterDocId: null, content: "x" }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(400)
    expect(docFs.createPath).not.toHaveBeenCalled()
    expect(docFs.writeDocById).not.toHaveBeenCalled()
  })

  it("accepts a normal collision-suffixed name and unicode titles", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([...unchangedFiles, { path: "Product/Plan (3f9a2b10)", frontmatterDocId: null, content: "x" }, { path: "Product/日本語 notes", frontmatterDocId: null, content: "y" }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
  })

  it("rejects duplicate file paths", async () => {
    expect((await handleAgentDocsReconcile(post(validBody([...unchangedFiles, unchangedFiles[0]])), RUN_ID, harness())).status).toBe(400)
  })

  it("DROPS an invalid deletedPaths entry instead of failing the request, so the edits in it still land", async () => {
    // deletedPaths can only narrow what gets deleted, so ignoring a bad entry is the safe direction.
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "edited" }], { deletedPaths: ["../etc", ".hidden", 7, "Product/Plan"] })),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(docFs.writeDocById).toHaveBeenCalledWith(WS, "doc-1", "edited", expect.anything())
    // the one valid, explicit entry still authorises its delete
    expect(docFs.deleteDocById).toHaveBeenCalledWith(WS, "doc-2", expect.anything())
  })

  it("tolerates a non-array deletedPaths", async () => {
    const response = await handleAgentDocsReconcile(post(validBody(unchangedFiles, { deletedPaths: "Product/Plan" })), RUN_ID, harness())
    expect(response.status).toBe(200)
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
  })

  it("accepts as many files as the sandbox walk can enumerate, with headroom", async () => {
    const files = [...unchangedFiles, ...Array.from({ length: 5_000 }, (_, i) => ({ path: `New ${i}`, frontmatterDocId: null, content: "x" }))]
    const response = await handleAgentDocsReconcile(post(validBody(files)), RUN_ID, harness())
    expect(response.status).toBe(200)
    expect(docFs.createPath).toHaveBeenCalledTimes(5_000)
  })

  it("rejects a file list past the cap", async () => {
    const files = Array.from({ length: 6_000 }, (_, i) => ({ path: `New ${i}`, frontmatterDocId: null, content: "x" }))
    expect((await handleAgentDocsReconcile(post(validBody(files)), RUN_ID, harness())).status).toBe(400)
  })
})

describe("agent run docs callback — reconciliation", () => {
  it("applies updates and creates by id/path against the run's own workspace", async () => {
    const response = await handleAgentDocsReconcile(
      post(
        validBody([
          { path: "Product", frontmatterDocId: "doc-1", content: "edited by the agent" },
          unchangedFiles[1],
          { path: "Product/New Idea", frontmatterDocId: null, content: "brand new" },
        ])
      ),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: 2, conflicts: [], notice: null })
    expect(docFs.writeDocById).toHaveBeenCalledWith(WS, "doc-1", "edited by the agent", expect.objectContaining({ expectedRevision: "rev-1", authorName: "Compass Agent" }))
    expect(docFs.createPath).toHaveBeenCalledWith(WS, "Product/New Idea", "brand new", expect.objectContaining({ authorName: "Compass Agent" }))
  })

  it("deletes a doc only when the agent explicitly removed it, non-recursively", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([unchangedFiles[0]], { deletedPaths: ["Product/Plan"] })),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(docFs.deleteDocById).toHaveBeenCalledTimes(1)
    expect(docFs.deleteDocById).toHaveBeenCalledWith(WS, "doc-2", expect.objectContaining({ expectedRevision: "rev-2" }))
  })

  it("does NOT delete a doc that merely went missing from the final tree, and tells the user", async () => {
    const response = await handleAgentDocsReconcile(post(validBody([unchangedFiles[0]])), RUN_ID, harness())
    expect(response.status).toBe(200)
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
    expect((await response.json()).notice).toContain("'Plan'")
  })

  it("applies no delete from an incomplete sandbox view, even an explicit one", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([unchangedFiles[0]], { incomplete: true, deletedPaths: ["Product/Plan"] })),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
    expect((await response.json()).notice).toContain("incomplete")
  })

  it("fails closed when the incomplete flag is absent altogether", async () => {
    const body = validBody([unchangedFiles[0]], { deletedPaths: ["Product/Plan"] }) as Record<string, unknown>
    delete body.incomplete
    await handleAgentDocsReconcile(post(body), RUN_ID, harness())
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
  })

  it("treats hash-only unchanged files as no-ops", async () => {
    const response = await handleAgentDocsReconcile(post(validBody(unchangedFiles)), RUN_ID, harness())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: 0, conflicts: [] })
    expect(docFs.writeDocById).not.toHaveBeenCalled()
    expect(docFs.deleteDocById).not.toHaveBeenCalled()
  })

  it("ignores a docId the baseline never handed out (a create, not an update of someone else's doc)", async () => {
    await handleAgentDocsReconcile(
      post(validBody([...unchangedFiles, { path: "Imposter", frontmatterDocId: "foreign-doc", content: "overwrite attempt" }])),
      RUN_ID,
      harness()
    )
    expect(docFs.writeDocById).not.toHaveBeenCalled()
    expect(docFs.createPath).toHaveBeenCalledTimes(1)
  })

  it("surfaces a revision conflict as a user-facing notice and preserves the agent's edit as history", async () => {
    docFs.writeDocById.mockRejectedValueOnce(new DocumentError("revision-conflict"))
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "agent version" }, unchangedFiles[1]])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.conflicts).toEqual([{ path: "Product", title: "Product", reason: "revision" }])
    expect(body.notice).toContain("saved in its version history")
    expect(docFs.recordConflictingSnapshot).toHaveBeenCalledWith("doc-1", "agent version", "Compass Agent")
  })

  it("keeps going after a conflict and reports a parent delete with surviving children as a conflict, not a 500", async () => {
    docFs.deleteDocById.mockImplementation(async (_ws: string, docId: string) => {
      if (docId === "doc-2") throw new DocumentError("revision-conflict")
      throw Object.assign(new Error("has children"), { name: "DocFsError", code: "has-children" })
    })
    const response = await handleAgentDocsReconcile(post(validBody([], { deletedPaths: ["Product", "Product/Plan"] })), RUN_ID, harness())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.conflicts.map((c: { reason: string }) => c.reason)).toEqual(["revision", "has-children"])
  })

  it("reports a non-doc error as that doc's failure (200, no internals leaked) and still applies the rest", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    docFs.writeDocById.mockRejectedValueOnce(new Error("database password leaked"))
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "x" }, unchangedFiles[1], { path: "Fresh", frontmatterDocId: null, content: "y" }])),
      RUN_ID,
      harness()
    )
    spy.mockRestore()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain("password")
    expect(body.conflicts).toEqual([{ path: "Product", title: "Product", reason: "failed" }])
    expect(body.applied).toBe(1)
    expect(docFs.createPath).toHaveBeenCalled()
  })
})
