import getPrisma from "@/lib/db"

type AuthoredComment = { authorId: string | null; authorName: string; authorType: string }

/** Resolve live human identities without changing the stored comment or its timestamps. */
export async function resolveCommentAuthors<T extends AuthoredComment>(comments: T[]): Promise<T[]> {
  const ids = [...new Set(comments.filter(c => c.authorType === "HUMAN" && c.authorId).map(c => c.authorId!))]
  if (!ids.length) return comments
  const users = await getPrisma().user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
  const names = new Map(users.map(user => [user.id, user.name?.trim() || user.email]))
  return comments.map(comment => {
    const name = comment.authorType === "HUMAN" && comment.authorId ? names.get(comment.authorId) : undefined
    return name ? { ...comment, authorName: name } : comment
  })
}
