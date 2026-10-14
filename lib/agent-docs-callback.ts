/**
 * Worker-authenticated reconciliation of a detached run's doc tree (ADR 0019 §2.4).
 *
 * Same trust model as `lib/agent-session-callback.ts`: bearer worker token,
 * authenticated before the body is read, size cap. The sandbox supplies the final
 * file list and the host-signed baseline manifest it was given; the workspace and
 * acting user come from the run row, and the manifest must verify against that run
 * and workspace. Nothing the sandbox sends can name a doc the baseline did not
 * contain (see `planReconciliation`'s id validation) or a workspace other than the
 * run's own.
 *
 * The worker must call this *before* its terminal event: a terminal run no longer
 * has a bound token, which is also what stops a finished run from rewriting docs
 * later. The response carries the user-facing conflict notice so the worker can
 * append it to the final answer.
 */

import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { AgentRunError, authorizeAgentRunWorker } from "@/lib/agent-runs"
import { verifyDocManifest } from "@/lib/agent-doc-manifest"
import { MAX_FINAL_FILES, reconcileAgentDocs, type DocFinalFile } from "@/lib/agent-doc-reconciliation"
import { validateDocPath } from "@/lib/doc-path"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const sha256Hex = /^[a-f0-9]{64}$/i

export const MAX_AGENT_DOCS_BODY_BYTES = 8 * 1024 * 1024

const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > MAX_AGENT_DOCS_BODY_BYTES) {
    throw new AgentRunError("Doc state is too large", 413, "DOCS_TOO_LARGE")
  }
  if (!request.body) throw new AgentRunError("Body is required", 400, "INVALID_CALLBACK_BODY")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      // A lying (or absent) content-length must not be the only guard.
      if (total > MAX_AGENT_DOCS_BODY_BYTES) {
        await reader.cancel()
        throw new AgentRunError("Doc state is too large", 413, "DOCS_TOO_LARGE")
      }
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    reader.releaseLock()
  }
}

function parseFinalFiles(value: unknown): DocFinalFile[] | null {
  if (!Array.isArray(value) || value.length > MAX_FINAL_FILES) return null
  const files: DocFinalFile[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") return null
    const f = item as Record<string, unknown>
    // The sandbox runs agent-controlled code: a path is only ever accepted in the
    // exact form the doc layer itself could have produced.
    if (validateDocPath(f.path) !== null) return null
    if (f.frontmatterDocId !== null && typeof f.frontmatterDocId !== "string") return null
    const hasContent = typeof f.content === "string"
    const hasHash = typeof f.contentSha256 === "string" && sha256Hex.test(f.contentSha256)
    // Content wins: a sandbox-claimed hash is only honoured when no content is sent.
    if (!hasContent && !hasHash) return null
    files.push({
      path: f.path as string,
      frontmatterDocId: f.frontmatterDocId as string | null,
      ...(hasContent ? { content: f.content as string } : { contentSha256: (f.contentSha256 as string).toLowerCase() }),
    })
  }
  return files
}

/**
 * Unlike `files`, a bad entry here is dropped, not fatal: deletedPaths can only
 * NARROW what gets deleted, so ignoring an entry is always the safe direction, and
 * rejecting the whole request over one would throw away every edit in it.
 */
function parseDeletedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((p): p is string => typeof p === "string" && validateDocPath(p) === null).slice(0, MAX_FINAL_FILES)
}

export async function handleAgentDocsReconcile(request: Request, runId: string, database?: AppPrismaClient) {
  try {
    if (!uuid.test(runId) || new URL(request.url).search) return respond({ error: "Invalid callback URL" }, 400)
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
    if (!bearer) return respond({ error: "Worker bearer token required" }, 401)
    const prisma = database ?? getPrisma()

    const run = await authorizeAgentRunWorker({ prisma, runId, rawToken: bearer[1] })
    // Claim-scoped handoff runs hold an MCP key narrower than "act as the user";
    // a host-applied file edit would sidestep that. They are never given docs.
    if (run.claimId) return respond({ error: "This run does not reconcile docs", code: "DOCS_NOT_SUPPORTED" }, 409)

    // The key the agent used is the user's own authority; re-check it still holds.
    const member = await prisma.workspace.findFirst({
      where: { id: run.workspaceId, members: { some: { userId: run.userId } } },
      select: { id: true },
    })
    if (!member) return respond({ error: "Workspace access was revoked", code: "WORKSPACE_ACCESS_REVOKED" }, 403)

    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(request))
    } catch (error) {
      if (error instanceof AgentRunError) throw error
      return respond({ error: "Body must be JSON", code: "INVALID_CALLBACK_BODY" }, 400)
    }
    const body = (parsed ?? {}) as { manifest?: unknown; files?: unknown; incomplete?: unknown; deletedPaths?: unknown }
    const baseline = verifyDocManifest(body.manifest, { runId, workspaceId: run.workspaceId })
    if (!baseline) return respond({ error: "Doc manifest failed verification", code: "INVALID_DOC_MANIFEST" }, 422)
    const files = parseFinalFiles(body.files)
    if (!files) return respond({ error: "Invalid doc file list", code: "INVALID_DOC_FILES" }, 400)

    const deletedPaths = parseDeletedPaths(body.deletedPaths)
    // Anything but an explicit `false` is treated as incomplete: fail closed.
    const incomplete = body.incomplete !== false
    // Two entries for one path, or a hash-only entry that cannot be honoured, are malformed input.
    if (new Set(files.map((f) => f.path)).size !== files.length) return respond({ error: "Duplicate doc paths", code: "INVALID_DOC_FILES" }, 400)

    let outcome: Awaited<ReturnType<typeof reconcileAgentDocs>>
    try {
      outcome = await reconcileAgentDocs(run.workspaceId, runId, baseline, { files, incomplete, deletedPaths }, "Compass Agent")
    } catch (error) {
      if (error instanceof Error && /no content was provided|neither content nor/.test(error.message)) {
        return respond({ error: error.message, code: "INVALID_DOC_FILES" }, 400)
      }
      throw error
    }
    return respond({
      applied: outcome.applied,
      conflicts: outcome.conflicts.map((c) => ({ path: c.path, title: c.title, reason: c.reason })),
      notice: outcome.notices.length > 0 ? outcome.notices.join("\n") : null,
    })
  } catch (error) {
    if (error instanceof AgentRunError) return respond({ error: error.message, code: error.code }, error.status)
    console.error("Agent docs reconciliation failed", { runId, error })
    return respond({ error: "Agent docs reconciliation failed", code: "RECONCILE_FAILED" }, 500)
  }
}
