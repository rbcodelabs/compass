/**
 * Handler functions for the DocVersion MCP tools (create_doc_version,
 * list_doc_versions, get_doc_version, restore_doc_version).
 *
 * Extracted into this module (rather than left inline in app/api/mcp/route.ts)
 * so every tool -- including create_doc_version, which the codebase convention
 * otherwise leaves inline -- can be unit-tested. Read/write symmetry for this
 * entity is required per .claude/pr-guidelines.md (create-without-list/get/update
 * is a recurring dogfood failure called out there).
 *
 * MCP tool handlers have no access to a resolved per-user identity --
 * validateMcpAuth is only checked once at the top of the route as a gate --
 * so authorName is always a required explicit input here, never derived.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { maybeSnapshotDocVersion, restoreDocVersionCore } from "@/lib/doc-versions"
import { relativeTime } from "@/lib/relative-time"

// ── create_doc_version ──────────────────────────────────────────────────────
// Manual "named" snapshot -- always writes a version, bypassing the 5-minute
// coalescing window (maybeSnapshotDocVersion always creates when a label is
// set, per lib/doc-versions.ts).

export async function createDocVersion({
  docId,
  label,
  authorName,
}: {
  docId: string
  label?: string
  authorName: string
}) {
  const prisma = getPrisma()

  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: { id: true, title: true },
  })
  if (!doc) {
    return fail(`Doc "${docId}" not found.`)
  }

  await maybeSnapshotDocVersion(docId, {
    authorName,
    label: label?.trim() || "Snapshot",
  })

  const version = await prisma.docVersion.findFirst({
    where: { docId },
    orderBy: { createdAt: "desc" },
  })

  return ok(
    `**Named snapshot saved** for doc "${doc.title}"\n` +
      `Label: ${version?.label}\n` +
      `Author: ${authorName}\n` +
      `ID: ${version?.id}`,
    { id: version?.id, label: version?.label }
  )
}

// ── list_doc_versions ───────────────────────────────────────────────────────

export async function listDocVersions({ docId }: { docId: string }) {
  const prisma = getPrisma()

  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: { id: true, title: true, updatedAt: true },
  })
  if (!doc) {
    return fail(`Doc "${docId}" not found.`)
  }

  const versions = await prisma.docVersion.findMany({
    where: { docId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      createdByName: true,
      createdAt: true,
    },
  })

  const header =
    `**Version history for "${doc.title}"**\n` +
    `Current — last updated ${doc.updatedAt.toISOString()} (${relativeTime(doc.updatedAt)})`

  if (versions.length === 0) {
    return fail(`${header}\n\nNo saved versions yet.`)
  }

  const entries = versions.map(
    (v) =>
      `${v.label ? `[${v.label}] ` : ""}${v.createdByName ?? "Unknown"} — ${v.createdAt.toISOString()} (${relativeTime(v.createdAt)})\n` +
      `ID: ${v.id}`
  )

  return ok(
    `${header}\n\n${versions.length} saved version${versions.length === 1 ? "" : "s"}:\n\n${entries.join("\n\n")}`,
    {
      items: versions.map((v) => ({
        id: v.id,
        label: v.label,
        authorName: v.createdByName,
        createdAt: v.createdAt,
      })),
      count: versions.length,
    }
  )
}

// ── get_doc_version ─────────────────────────────────────────────────────────

export async function getDocVersion({ versionId }: { versionId: string }) {
  const prisma = getPrisma()

  const version = await prisma.docVersion.findUnique({ where: { id: versionId } })
  if (!version) {
    return fail(`Doc version "${versionId}" not found.`)
  }

  const lines: string[] = [
    `# ${version.icon ? version.icon + " " : ""}${version.title}`,
    `ID: ${version.id}`,
    `Doc ID: ${version.docId}`,
    version.label ? `Label: ${version.label}` : null,
    `Author: ${version.createdByName ?? "Unknown"}`,
    `Created: ${version.createdAt.toISOString()} (${relativeTime(version.createdAt)})`,
    "",
  ].filter((line): line is string => line !== null)

  lines.push(version.content ? version.content : "*(no content)*")

  return ok(lines.join("\n"), version)
}

// ── restore_doc_version ─────────────────────────────────────────────────────
// Shares its "snapshot current state, then overwrite" logic with the UI's
// restoreDocVersion server action via restoreDocVersionCore -- see
// lib/doc-versions.ts.

export async function restoreDocVersion({ versionId }: { versionId: string }) {
  const prisma = getPrisma()

  const version = await prisma.docVersion.findUnique({
    where: { id: versionId },
    select: { docId: true },
  })
  if (!version) {
    return fail(`Doc version "${versionId}" not found.`)
  }

  const doc = await prisma.doc.findUnique({ where: { id: version.docId }, select: { id: true } })
  if (!doc) {
    return fail(`Doc "${version.docId}" not found.`)
  }

  const restored = await restoreDocVersionCore(versionId, { authorName: "MCP Agent" })
  // restored can only be null here if the version/doc vanished between the
  // checks above and the core call -- an unlikely race, but handle it rather
  // than throw.
  if (!restored) {
    return fail(`Doc version "${versionId}" not found.`)
  }

  return ok(
    `**Doc restored** to version from ${restored.restoredFrom.toISOString()}\n` +
      `Title: ${restored.title}\n` +
      `ID: ${restored.id}`,
    restored
  )
}
