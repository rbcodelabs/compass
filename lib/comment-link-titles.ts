import getPrisma from "@/lib/db"

/**
 * Display titles for TaskLinks of linkedType COMMENT, keyed `COMMENT:<commentId>`
 * to match the maps the task readers already build for other link types. A
 * comment has no title column, so the title is derived from its anchor.
 */
export async function commentLinkTitles(workspaceId: string, commentIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (commentIds.length === 0) return titles
  const rows = await getPrisma().comment.findMany({
    where: { id: { in: commentIds }, workspaceId, targetType: "DOC" },
    select: { id: true, docAnchor: { select: { anchorText: true } } },
  })
  for (const row of rows) {
    const anchor = row.docAnchor?.anchorText.replace(/\s+/g, " ").trim()
    titles.set(`COMMENT:${row.id}`, anchor ? `Comment on “${anchor.length > 60 ? `${anchor.slice(0, 59)}…` : anchor}”` : "Doc comment")
  }
  return titles
}
