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
import matter from "gray-matter"
import { Prisma } from "@prisma/client"
import { GTM_POSITIONING_BRIEF_TEMPLATE } from "@/lib/gtm-templates"
import { maybeSnapshotDocVersion } from "@/lib/doc-versions"

// MCP callers have no session-derived identity to snapshot under (unlike the
// UI's updateDoc server action, which uses session.user.id/name) —
// validateMcpAuth only gates the request once at the route level, not a
// per-user identity carried into handlers. Mirrors how SolutionComment
// distinguishes MCP callers via a fixed default rather than a resolved user.
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
function parseContent(raw: string): { body: string; metadata: DocMetadata | null } {
  const parsed = matter(raw)
  const body = parsed.content.trimStart()
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

export async function listDocs({ workspaceId }: { workspaceId: string }) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  })
  if (!workspace) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No workspace found with id "${workspaceId}".`,
        },
      ],
    }
  }

  const allDocs = await prisma.doc.findMany({
    where: { workspaceId },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
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
    return {
      content: [
        {
          type: "text" as const,
          text: `No docs found in workspace "${workspace.name}".`,
        },
      ],
    }
  }

  const childrenMap = new Map<string | null, typeof allDocs>()
  for (const doc of allDocs) {
    const key = doc.parentId ?? null
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

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
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
    return {
      content: [{ type: "text" as const, text: `Doc "${docId}" not found.` }],
    }
  }

  // Re-serialize metadata + body so agents see the full frontmatter document
  const metadata = doc.metadata as DocMetadata | null
  const fullContent = serializeWithFrontmatter(doc.content, metadata)

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

  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
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
}: {
  workspaceId: string
  title: string
  content?: string
  parentId?: string | null
  icon?: string
  roadmapItemId?: string | null
  docType?: "STANDARD" | "GTM_POSITIONING_BRIEF"
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
    return {
      content: [
        {
          type: "text" as const,
          text: `No workspace found with id "${workspaceId}".`,
        },
      ],
    }
  }

  if (parentId) {
    const parent = await prisma.doc.findUnique({
      where: { id: parentId },
      select: { id: true },
    })
    if (!parent) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Parent doc "${parentId}" not found.`,
          },
        ],
      }
    }
  }

  if (roadmapItemId) {
    const roadmapItem = await prisma.roadmapItem.findUnique({
      where: { id: roadmapItemId },
      select: { id: true, title: true },
    })
    if (!roadmapItem) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Roadmap item "${roadmapItemId}" not found.`,
          },
        ],
      }
    }

    const existingBrief = await prisma.doc.findUnique({
      where: { roadmapItemId },
      select: { id: true, title: true },
    })
    if (existingBrief) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Roadmap item "${roadmapItem.title}" already has a linked doc: "${existingBrief.title}".\n` +
              `ID: ${existingBrief.id}`,
          },
        ],
      }
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
    effectiveContent != null ? parseContent(effectiveContent) : { body: null, metadata: null }

  const doc = await prisma.doc.create({
    data: {
      workspaceId,
      parentId: parentId ?? null,
      title: title.trim(),
      content: body ?? null,
      metadata: metadata != null ? toJsonInput(metadata) : undefined,
      icon: icon?.trim() ?? null,
      sortOrder: lastSibling ? lastSibling.sortOrder + 1 : 0,
      roadmapItemId: roadmapItemId ?? null,
      docType: effectiveDocType,
    },
  })

  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Doc created**\n` +
          `ID: ${doc.id}\n` +
          `Title: ${doc.title}\n` +
          (parentId ? `Parent: ${parentId}\n` : "Location: root\n") +
          (metadata ? `Properties: ${Object.keys(metadata).join(", ")}\n` : "") +
          (roadmapItemId ? `Linked Roadmap Item: ${roadmapItemId}\n` : "") +
          (effectiveDocType !== "STANDARD" ? `Doc Type: ${effectiveDocType}\n` : "") +
          `URL: /${workspace.organization.slug}/${workspace.slug}/docs`,
      },
    ],
  }
}

// ── update_doc ───────────────────────────────────────────────────────────────

export async function updateDoc({
  docId,
  title,
  content,
  icon,
}: {
  docId: string
  title?: string
  content?: string
  icon?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true },
  })
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Doc "${docId}" not found.` }],
    }
  }

  const { body, metadata } =
    content !== undefined ? parseContent(content) : { body: undefined, metadata: undefined }

  // Snapshot the doc's pre-change state before applying the new values —
  // but only when this call actually changes something, so a no-op call
  // never creates a version.
  if (title !== undefined || content !== undefined || icon !== undefined) {
    await maybeSnapshotDocVersion(docId, { authorName: MCP_AUTHOR_NAME })
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date() }
  if (title !== undefined) updateData.title = title.trim()
  if (body !== undefined) updateData.content = body
  if (metadata !== undefined) updateData.metadata = metadata != null ? toJsonInput(metadata) : null
  if (icon !== undefined) updateData.icon = icon.trim()

  const updated = await prisma.doc.update({
    where: { id: docId },
    data: updateData,
  })

  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Doc updated**\n` +
          `ID: ${updated.id}\n` +
          `Title: ${updated.title}\n` +
          (updated.icon ? `Icon: ${updated.icon}\n` : "") +
          `Updated: ${updated.updatedAt.toISOString()}`,
      },
    ],
  }
}

// ── update_doc_metadata ───────────────────────────────────────────────────────

export async function updateDocMetadata({
  docId,
  metadata,
}: {
  docId: string
  metadata: DocMetadata
}) {
  const prisma = getPrisma()

  const existing = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true },
  })
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Doc "${docId}" not found.` }],
    }
  }

  const updated = await prisma.doc.update({
    where: { id: docId },
    data: { metadata: toJsonInput(metadata), updatedAt: new Date() },
  })

  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Doc metadata updated**\n` +
          `ID: ${updated.id}\n` +
          `Properties: ${Object.keys(metadata).join(", ")}`,
      },
    ],
  }
}
