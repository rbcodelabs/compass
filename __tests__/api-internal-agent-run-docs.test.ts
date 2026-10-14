/**
 * Worker doc-tree reconciliation callback (lib/agent-docs-callback.ts, ADR 0019).
 *
 * Same trust boundary as the session upload: bearer-shaped worker token checked
 * before the body is read, workspace and user taken from the run row, and a
 * host-signed baseline manifest so nothing the sandbox sends can name a doc the
 * baseline did not contain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const docFs = vi.hoisted(() => ({
  writePath: vi.fn(),
  movePath: vi.fn(),
  deletePath: vi.fn(),
  recordConflictingSnapshot: vi.fn(),
  deriveOperationId: vi.fn((base: string, salt: string) => `${base}::${salt}`),
}))
vi.mock("@/lib/doc-fs", () => docFs)

import { handleAgentDocsReconcile, conflictNotice } from "@/lib/agent-docs-callback"
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

function post(body: unknown, { token = TOKEN, url = URL_BASE }: { token?: string | null; url?: string } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function validBody(files: unknown[], manifest = signDocManifest(RUN_ID, WS, baseline)) {
  return { manifest, files }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTH_SECRET = "test-auth-secret"
  docFs.writePath.mockResolvedValue(undefined)
  docFs.movePath.mockResolvedValue(undefined)
  docFs.deletePath.mockResolvedValue(undefined)
  docFs.recordConflictingSnapshot.mockResolvedValue(undefined)
})

describe("agent run docs callback — authentication", () => {
  it("requires a bearer worker token and does not touch docs without one", async () => {
    const response = await handleAgentDocsReconcile(post(validBody([]), { token: null }), RUN_ID, harness())
    expect(response.status).toBe(401)
    expect(docFs.writePath).not.toHaveBeenCalled()
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
    expect(docFs.writePath).not.toHaveBeenCalled()
  })

  it("refuses when the user no longer belongs to the workspace", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "changed" }])),
      RUN_ID,
      harness(runRow(), null)
    )
    expect(response.status).toBe(403)
    expect(docFs.writePath).not.toHaveBeenCalled()
  })
})

describe("agent run docs callback — manifest and body validation", () => {
  it("rejects a manifest signed for a different run", async () => {
    const forged = signDocManifest("99999999-9999-4999-8999-999999999999", WS, baseline)
    const response = await handleAgentDocsReconcile(post(validBody([], forged)), RUN_ID, harness())
    expect(response.status).toBe(422)
    expect(docFs.deletePath).not.toHaveBeenCalled()
  })

  it("rejects a tampered manifest (sandbox adding a docId it was never shown)", async () => {
    const manifest = JSON.parse(JSON.stringify(signDocManifest(RUN_ID, WS, baseline)))
    manifest.entries.push({ path: "Secret", docId: "foreign-doc", revision: null, contentSha256: "0".repeat(64) })
    const response = await handleAgentDocsReconcile(post(validBody([], manifest)), RUN_ID, harness())
    expect(response.status).toBe(422)
  })

  it("rejects non-JSON bodies and malformed file lists", async () => {
    expect((await handleAgentDocsReconcile(post("not json"), RUN_ID, harness())).status).toBe(400)
    expect((await handleAgentDocsReconcile(post(validBody([{ path: "A" }])), RUN_ID, harness())).status).toBe(400)
    expect((await handleAgentDocsReconcile(post(validBody("nope" as unknown as unknown[])), RUN_ID, harness())).status).toBe(400)
  })

  it("rejects a changed file that arrives with a hash and no content", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", contentSha256: sha("tampered") }, { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(400)
    expect(docFs.writePath).not.toHaveBeenCalled()
  })

  it("enforces the body size cap even when content-length lies", async () => {
    const huge = "x".repeat(9 * 1024 * 1024)
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: huge }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(413)
  })
})

describe("agent run docs callback — reconciliation", () => {
  it("applies updates, creates and deletes against the run's own workspace", async () => {
    const response = await handleAgentDocsReconcile(
      post(
        validBody([
          { path: "Product", frontmatterDocId: "doc-1", content: "edited by the agent" },
          { path: "Product/New Idea", frontmatterDocId: null, content: "brand new" },
        ])
      ),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ applied: 3, conflicts: [], notice: null })
    expect(docFs.writePath).toHaveBeenCalledWith(WS, "Product", "edited by the agent", expect.objectContaining({ expectedRevision: "rev-1", authorName: "Compass Agent" }))
    expect(docFs.writePath).toHaveBeenCalledWith(WS, "Product/New Idea", "brand new", expect.objectContaining({ authorName: "Compass Agent" }))
    // doc-2 was in the baseline and is gone from the final tree.
    expect(docFs.deletePath).toHaveBeenCalledWith(WS, "Product/Plan", expect.objectContaining({ expectedRevision: "rev-2", recursive: true }))
  })

  it("treats hash-only unchanged files as no-ops", async () => {
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", contentSha256: sha("hello") }, { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ applied: 0, conflicts: [] })
    expect(docFs.writePath).not.toHaveBeenCalled()
    expect(docFs.deletePath).not.toHaveBeenCalled()
  })

  it("ignores a docId the baseline never handed out (treated as a create, not an update of someone else's doc)", async () => {
    await handleAgentDocsReconcile(
      post(validBody([
        { path: "Product", frontmatterDocId: "doc-1", contentSha256: sha("hello") },
        { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") },
        { path: "Imposter", frontmatterDocId: "foreign-doc", content: "overwrite attempt" },
      ])),
      RUN_ID,
      harness()
    )
    expect(docFs.writePath).toHaveBeenCalledTimes(1)
    expect(docFs.writePath).toHaveBeenCalledWith(WS, "Imposter", "overwrite attempt", expect.not.objectContaining({ expectedRevision: expect.anything() }))
  })

  it("surfaces a revision conflict as a user-facing notice and preserves the agent's edit as history", async () => {
    docFs.writePath.mockRejectedValueOnce(new DocumentError("revision-conflict"))
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "agent version" }, { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.conflicts).toEqual([{ path: "Product", title: "Product" }])
    expect(body.notice).toBe(conflictNotice(["Product"]))
    expect(body.notice).toContain("saved in its version history")
    expect(docFs.recordConflictingSnapshot).toHaveBeenCalledWith("doc-1", "agent version", "Compass Agent")
  })

  it("answers 500 without leaking internals when applying throws", async () => {
    docFs.writePath.mockRejectedValueOnce(new Error("database password leaked"))
    const response = await handleAgentDocsReconcile(
      post(validBody([{ path: "Product", frontmatterDocId: "doc-1", content: "x" }, { path: "Product/Plan", frontmatterDocId: "doc-2", contentSha256: sha("plan") }])),
      RUN_ID,
      harness()
    )
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("password")
  })
})
