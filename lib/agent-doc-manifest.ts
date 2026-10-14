/**
 * Host-signed baseline manifest for a detached agent run (ADR 0019 §2.4).
 *
 * A detached run outlives the request that started it, so the host cannot keep the
 * "before" doc tree in memory the way the synchronous turn path does. Instead it
 * writes a manifest of what the sandbox was shown (path, docId, revision, content
 * hash) into the sandbox, signed with a server secret and bound to the run and
 * workspace. The sandbox hands the manifest back with its final doc tree and the
 * callback verifies the signature, so:
 *
 *  - no baseline needs to be stored anywhere server-side, and
 *  - nothing the sandbox controls (an agent can run code there) can forge a docId,
 *    a revision, or a hash to widen what the reconciliation is allowed to touch.
 *
 * The manifest holds hashes and ids, never doc content.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { sha256, type DocBaselineEntry } from "@/lib/agent-doc-reconciliation"

/** Sandbox-relative file the host writes the signed manifest to. */
export const DOC_MANIFEST_FILE = "docs-manifest.json"

export type DocManifestEntry = { path: string; docId: string; revision: string | null; contentSha256: string }

export type SignedDocManifest = {
  runId: string
  workspaceId: string
  entries: DocManifestEntry[]
  signature: string
}

function secret(): string {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error("Doc manifest signing requires AUTH_SECRET")
  return value
}

function canonicalPayload(runId: string, workspaceId: string, entries: readonly DocManifestEntry[]): string {
  // Fixed key order and a domain-separation prefix: the signature must not be
  // reusable for any other HMAC this secret might back.
  return JSON.stringify([
    "compass-agent-doc-manifest-v1",
    runId,
    workspaceId,
    entries.map((e) => [e.path, e.docId, e.revision, e.contentSha256]),
  ])
}

function sign(runId: string, workspaceId: string, entries: readonly DocManifestEntry[]): string {
  return createHmac("sha256", secret()).update(canonicalPayload(runId, workspaceId, entries)).digest("hex")
}

export function signDocManifest(runId: string, workspaceId: string, baseline: readonly DocBaselineEntry[]): SignedDocManifest {
  const entries = baseline.map((b): DocManifestEntry => ({
    path: b.path,
    docId: b.docId,
    revision: b.revision,
    contentSha256: b.contentSha256 ?? sha256(b.content ?? ""),
  }))
  return { runId, workspaceId, entries, signature: sign(runId, workspaceId, entries) }
}

function isEntry(value: unknown): value is DocManifestEntry {
  if (!value || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return (
    typeof e.path === "string" &&
    typeof e.docId === "string" &&
    (e.revision === null || typeof e.revision === "string") &&
    typeof e.contentSha256 === "string"
  )
}

/** Returns the verified baseline, or null when the manifest is malformed, forged, or for another run/workspace. */
export function verifyDocManifest(value: unknown, expected: { runId: string; workspaceId: string }): DocBaselineEntry[] | null {
  if (!value || typeof value !== "object") return null
  const m = value as Record<string, unknown>
  if (m.runId !== expected.runId || m.workspaceId !== expected.workspaceId) return null
  if (typeof m.signature !== "string" || !Array.isArray(m.entries) || !m.entries.every(isEntry)) return null
  const entries = m.entries as DocManifestEntry[]
  const actual = Buffer.from(sign(expected.runId, expected.workspaceId, entries), "hex")
  const provided = Buffer.from(m.signature, "hex")
  if (actual.length !== provided.length || !timingSafeEqual(actual, provided)) return null
  return entries.map((e) => ({ path: e.path, docId: e.docId, revision: e.revision, contentSha256: e.contentSha256 }))
}
