/**
 * Handler functions for Docs MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 */

import getPrisma from "@/lib/db"

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter (--- ... ---) from the top of a markdown string.
 * Vault files (Obsidian, etc.) commonly include frontmatter that TipTap
 * has no knowledge of, so it renders as raw text instead of being ignored.
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n?/, "").trimStart()
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

  // Fetch all docs for the workspace so we can build the tree client-side.
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

  // Build indented tree output
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

  const lines: string[] = [
    `# ${doc.icon ? doc.icon + " " : ""}${doc.title}`,
    `ID: ${doc.id}`,
    doc.parent
      ? `Parent: ${doc.parent.title} (${doc.parent.id})`
      : "Parent: (root)",
    `Updated: ${doc.updatedAt.toISOString()}`,
    "",
  ]

  if (doc.content) {
    lines.push("## Content", "", doc.content, "")
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
}: {
  workspaceId: string
  title: string
  content?: string
  parentId?: string | null
  icon?: string
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

  // Place at end of sibling list
  const lastSibling = await prisma.doc.findFirst({
    where: { workspaceId, parentId: parentId ?? null },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })

  const doc = await prisma.doc.create({
    data: {
      workspaceId,
      parentId: parentId ?? null,
      title: title.trim(),
      content: content != null ? stripFrontmatter(content) : null,
      icon: icon?.trim() ?? null,
      sortOrder: lastSibling ? lastSibling.sortOrder + 1 : 0,
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

  const updated = await prisma.doc.update({
    where: { id: docId },
    data: {
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(content !== undefined ? { content: stripFrontmatter(content) } : {}),
      ...(icon !== undefined ? { icon: icon.trim() } : {}),
      updatedAt: new Date(),
    },
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
