/**
 * Handler functions for Docs MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 *
 * Frontmatter handling:
 *   When content is passed to createDoc / updateDoc, gray-matter parses any YAML
 *   frontmatter block (--- … ---) from the top. The parsed key-value pairs are
 *   stored in the `metadata` JSON column; the markdown body goes in `content`.
 *   On getDoc, the two are re-serialized back to a frontmatter string so MCP
 *   agents always see the full document as they'd expect.
 */

import getPrisma from "@/lib/db"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import matter from "gray-matter"
import { Prisma } from "@prisma/client"
import { ok, fail } from "@/lib/mcp-output"
import { recencyOrderBy, type RecencySort } from "@/lib/mcp-recency"
import { GTM_POSITIONING_BRIEF_TEMPLATE } from "@/lib/gtm-templates"
import { maybeSnapshotDocVersion } from "@/lib/doc-versions"
import { createDocument, hydrateDocument, updateDocument } from "@/lib/document-service"
import { isDocumentPilotWorkspace } from "@/lib/document-storage"
import { documentMcpActor } from "@/lib/document-mcp-actor"

// Keep the legacy history display label. Pilot receipts additionally bind the
// trusted request actor carried by mcp-authz's AsyncLocalStorage.
const MCP_AUTHOR_NAME = "MCP Agent"

// ── helpers ───────────────────────────────────────────────────────────────────

type DocMetadata = Record<string, unknown>

/** Cast our plain object to the Prisma InputJsonValue type required for Json fields. */
function toJsonInput(data: DocMetadata): Prisma.InputJsonValue {
  return data as unknown as Prisma.InputJsonValue
}

/**
 * Parse content that may include YAML frontmatter.
 * Returns { body, metadata } where body is the clean markdown text
 * and metadata is the parsed frontmatter key-value pairs (or null if none).
 */
function parseContent(raw: string, preserveWhitespace = false): { body: string; metadata: DocMetadata | null } {
  const parsed = matter(raw)
  const body = preserveWhitespace ? (parsed.matter ? parsed.content : raw) : parsed.content.trimStart()
  const metadata =
    parsed.data && Object.keys(parsed.data).length > 0
      ? (parsed.data as DocMetadata)
      : null
  return { body, metadata }
}

/**
 * Re-serialize metadata + body back to a frontmatter markdown string.
 * Used in getDoc so MCP agents receive the full document they'd expect.
 */
function serializeWithFrontmatter(body: string | null, metadata: DocMetadata | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return body ?? ""
  return matter.stringify(body ?? "", metadata)
}

// ── list_docs ────────────────────────────────────────────────────────────────

export async function listDocs({
  workspaceId,
  updatedSince,
  updatedBefore,
  sort,
}: {
  workspaceId: string
  updatedSince?: string
  updatedBefore?: string
  sort?: RecencySort
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  })
  if (!workspace) {
    return fail(`No workspace found with id "${workspaceId}".`)
  }

  const allDocs = await prisma.doc.findMany({
    where: {
      workspaceId,
      ...(updatedSince || updatedBefore
        ? {
            updatedAt: {
              ...(updatedSince ? { gte: new Date(updatedSince) } : {}),
              ...(updatedBefore ? { lt: new Date(updatedBefore) } : {}),
            },
          }
        : {}),
    },
    orderBy: recencyOrderBy(sort) ?? [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      icon: true,
      parentId: true,
      sortOrder: true,
      updatedAt: true,
      _count: { select: { children: true } },
    },
  })

  if (!allDocs.length) {
    // An empty *recency window* is a successful answer, not a failure: "nothing
    // changed since X" is exactly what a digest caller expects to hear on a quiet
    // day, and returning ok:false there reads as an error and invites pointless
    // retries. An empty *unfiltered* workspace keeps its original fail() so
    // existing callers see no change.
    if (updatedSince || updatedBefore) {
      return ok(`No docs updated in the requested window in workspace "${workspace.name}".`, { items: [], count: 0 })
    }
    return fail(`No docs found in workspace "${workspace.name}".`)
  }

  // A doc whose parent is absent from the result set is rendered at the top
  // level. Without this, a recency filter that matches a child but not its
  // parent would leave the child in `items` but unreachable from any root, so
  // it would silently disappear from the rendered tree while still being
  // counted. Promotion is preferred over fetching the missing parents
  // (list_tasks/includeSubtasks does that) because it keeps `count` equal to the
  // number of docs that actually matched the filter.
  //
  // On an unfiltered call every parent is present, so nothing is promoted — the
  // one exception being a doc whose parentId dangles, which relationMode="prisma"
  // does not prevent. Such a doc was previously counted but never rendered; it
  // is now rendered as a root.
  const presentIds = new Set(allDocs.map((doc) => doc.id))
  const childrenMap = new Map<string | null, typeof allDocs>()
  for (const doc of allDocs) {
    const key = doc.parentId && presentIds.has(doc.parentId) ? doc.parentId : null
    if (!childrenMap.has(key)) childrenMap.set(key, [])
    childrenMap.get(key)!.push(doc)
  }

  const lines: string[] = [`**${workspace.name}** — ${allDocs.length} docs\n`]

  function renderNode(doc: (typeof allDocs)[0], depth: number) {
    const indent = "  ".repeat(depth)
    const icon = doc.icon ? `${doc.icon} ` : ""
    const childCount = doc._count.children
    lines.push(
      `${indent}• ${icon}**${doc.title}**${childCount ? ` (${childCount} children)` : ""}\n` +
        `${indent}  ID: ${doc.id}`
    )
    const children = childrenMap.get(doc.id) ?? []
    for (const child of children) renderNode(child, depth + 1)
  }

  const roots = childrenMap.get(null) ?? []
  for (const root of roots) renderNode(root, 0)

  return ok(lines.join("\n"), {
    items: allDocs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      parentId: doc.parentId,
    })),
    count: allDocs.length,
  })
}

// ── get_doc ──────────────────────────────────────────────────────────────────

export async function getDoc({ docId }: { docId: string }) {
  const prisma = getPrisma()

  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    include: {
      parent: { select: { id: true, title: true } },
      children: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          icon: true,
          _count: { select: { children: true } },
        },
      },
    },
  })

  if (!doc) {
    return fail(`Doc "${docId}" not found.`)
  }

  // Re-serialize metadata + body so agents see the full frontmatter document
  const metadata = doc.metadata as DocMetadata | null
  const hydrated = await hydrateDocument(doc.workspaceId, doc)
  const fullContent = serializeWithFrontmatter(hydrated.content, metadata)

  const lines: string[] = [
    `# ${doc.icon ? doc.icon + " " : ""}${doc.title}`,
    `ID: ${doc.id}`,
    doc.parent
      ? `Parent: ${doc.parent.title} (${doc.parent.id})`
      : "Parent: (root)",
    `Updated: ${doc.updatedAt.toISOString()}`,
    doc.docType !== "STANDARD" ? `Doc Type: ${doc.docType}` : null,
    doc.roadmapItemId ? `Linked Roadmap Item: ${doc.roadmapItemId}` : null,
    "",
  ].filter((line): line is string => line !== null)

  if (fullContent) {
    lines.push("## Content", "", fullContent, "")
  } else {
    lines.push("*(no content yet)*", "")
  }

  if (doc.children.length) {
    lines.push("## Children")
    for (const child of doc.children) {
      lines.push(
        `• ${child.icon ? child.icon + " " : ""}**${child.title}**${child._count.children ? ` (${child._count.children} children)` : ""} — ID: ${child.id}`
      )
    }
  }

  return ok(lines.join("\n"), {
    id: doc.id,
    title: doc.title,
    content: fullContent,
    properties: metadata,
    revision: doc.revision,
    storageProvider: doc.storageProvider ?? "DATABASE",
  })
}

// ── create_doc ───────────────────────────────────────────────────────────────

export async function createDoc({
  workspaceId,
  title,
  content,
  parentId,
  icon,
  roadmapItemId,
  docType,
  operationId,
}: {
  workspaceId: string
  title: string
  content?: string
  parentId?: string | null
  icon?: string
  roadmapItemId?: string | null
  docType?: "STANDARD" | "GTM_POSITIONING_BRIEF"
  operationId?: string
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      slug: true,
      organization: { select: { slug: true } },
    },
  })
  if (!workspace) {
    return fail(`No workspace found with id "${workspaceId}".`)
  }

  const pilot = isDocumentPilotWorkspace(workspaceId)
  if (parentId && !pilot) {
    const parent = await prisma.doc.findUnique({
      where: { id: parentId },
      select: { id: true, workspaceId: true },
    })
    if (!parent || (parent.workspaceId && parent.workspaceId !== workspaceId)) {
      return fail(`Parent doc "${parentId}" not found.`)
    }
  }

  if (roadmapItemId && !pilot) {
    const roadmapItem = await prisma.roadmapItem.findUnique({
      where: { id: roadmapItemId },
      select: { id: true, title: true, workspaceId: true },
    })
    if (!roadmapItem || (roadmapItem.workspaceId && roadmapItem.workspaceId !== workspaceId)) {
      return fail(`Roadmap item "${roadmapItemId}" not found.`)
    }

    const existingBrief = await prisma.doc.findUnique({
      where: { roadmapItemId },
      select: { id: true, title: true },
    })
    if (existingBrief) {
      return fail(
        `Roadmap item "${roadmapItem.title}" already has a linked doc: "${existingBrief.title}".\n` +
          `ID: ${existingBrief.id}`
      )
    }
  }

  const lastSibling = await prisma.doc.findFirst({
    where: { workspaceId, parentId: parentId ?? null },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })

  const effectiveDocType = docType ?? "STANDARD"
  const effectiveContent =
    content ?? (effectiveDocType === "GTM_POSITIONING_BRIEF" ? GTM_POSITIONING_BRIEF_TEMPLATE : undefined)

  const { body, metadata } =
    effectiveContent != null ? parseContent(effectiveContent, pilot) : { body: null, metadata: null }

  const data = {
      workspaceId,
      parentId: parentId ?? null,
      title: title.trim(),
      content: body ?? null,
      metadata: metadata != null ? toJsonInput(metadata) : undefined,
      icon: icon?.trim() ?? null,
      sortOrder: lastSibling ? lastSibling.sortOrder + 1 : 0,
      roadmapItemId: roadmapItemId ?? null,
      docType: effectiveDocType,
    }
  const doc = pilot
    ? await createDocument(data, { operationId, ...documentMcpActor() })
    : await prisma.doc.create({ data })

  // This used to emit a *relative* `/{org}/{ws}/docs` — the docs index, not the
  // doc just created, and with no origin for an MCP client to resolve it
  // against. Now it is the absolute URL of this doc, or absent entirely.
  const url = safeEntityUrl({
    orgSlug: workspace.organization?.slug,
    workspaceSlug: workspace.slug,
    type: "doc",
    id: doc.id,
  })

  const summary = (
    `**Doc created**\n` +
    `ID: ${doc.id}\n` +
    `Title: ${doc.title}\n` +
    (parentId ? `Parent: ${parentId}\n` : "Location: root\n") +
    (metadata ? `Properties: ${Object.keys(metadata).join(", ")}\n` : "") +
    (roadmapItemId ? `Linked Roadmap Item: ${roadmapItemId}\n` : "") +
    (effectiveDocType !== "STANDARD" ? `Doc Type: ${effectiveDocType}\n` : "")
  ).trimEnd()

  return ok(
    withUrlLine(summary, url),
    {
      id: doc.id,
      title: doc.title,
      url,
      revision: doc.revision,
      storageProvider: doc.storageProvider ?? "DATABASE",
    }
  )
}

// ── update_doc ───────────────────────────────────────────────────────────────

export async function updateDoc({
  docId,
  title,
  content,
  icon,
  expectedRevision,
  operationId,
}: {
  docId: string
  title?: string
  content?: string
  icon?: string
  expectedRevision?: string
  operationId?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true, storageProvider: true },
  })
  if (!existing) {
    return fail(`Doc "${docId}" not found.`)
  }

  const { body, metadata } =
    content !== undefined ? parseContent(content, existing.storageProvider === "GEODE") : { body: undefined, metadata: undefined }

  // Snapshot the doc's pre-change state before applying the new values —
  // but only when this call actually changes something, so a no-op call
  // never creates a version.
  if (existing.storageProvider !== "GEODE" && (title !== undefined || content !== undefined || icon !== undefined)) {
    await maybeSnapshotDocVersion(docId, { authorName: MCP_AUTHOR_NAME })
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date() }
  if (title !== undefined) updateData.title = title.trim()
  if (body !== undefined) updateData.content = body
  if (metadata !== undefined) updateData.metadata = metadata != null ? toJsonInput(metadata) : null
  if (icon !== undefined) updateData.icon = icon.trim()

  const updated = existing.storageProvider === "GEODE" ? await updateDocument(docId, {
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(body !== undefined ? { content: body } : {}),
    ...(metadata !== undefined ? { metadata: metadata === null ? Prisma.JsonNull : toJsonInput(metadata) } : {}),
    ...(icon !== undefined ? { icon: icon.trim() } : {}),
  }, { expectedRevision, operationId, ...documentMcpActor() }) : await prisma.doc.update({
    where: { id: docId },
    data: updateData,
  })

  return ok(
    `**Doc updated**\n` +
      `ID: ${updated.id}\n` +
      `Title: ${updated.title}\n` +
      (updated.icon ? `Icon: ${updated.icon}\n` : "") +
      `Updated: ${updated.updatedAt.toISOString()}`,
    {
      id: updated.id,
      title: updated.title,
      icon: updated.icon,
      updatedAt: updated.updatedAt.toISOString(),
      revision: updated.revision,
    }
  )
}

// ── update_doc_metadata ───────────────────────────────────────────────────────

export async function updateDocMetadata({
  docId,
  metadata,
  expectedRevision,
  operationId,
}: {
  docId: string
  metadata: DocMetadata
  expectedRevision?: string
  operationId?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true, storageProvider: true },
  })
  if (!existing) {
    return fail(`Doc "${docId}" not found.`)
  }

  const updated = existing.storageProvider === "GEODE"
    ? await updateDocument(docId, { metadata: toJsonInput(metadata) }, { expectedRevision, operationId, ...documentMcpActor() })
    : await prisma.doc.update({
    where: { id: docId },
    data: { metadata: toJsonInput(metadata), updatedAt: new Date() },
  })

  return ok(
    `**Doc metadata updated**\n` +
      `ID: ${updated.id}\n` +
      `Properties: ${Object.keys(metadata).join(", ")}`,
    {
      id: updated.id,
      properties: Object.keys(metadata),
      revision: updated.revision,
    }
  )
}
