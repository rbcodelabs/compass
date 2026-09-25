/**
 * Avatar initials for the agent transcript.
 *
 * Lifted out of `app/[orgSlug]/[workspaceSlug]/agent/page.tsx` when the agent
 * rail started needing the same value from the workspace layout: two surfaces
 * render the same `AgentChat` with the same user, so a second copy of this
 * would be a second place for the two avatars to disagree.
 *
 * Deliberately *not* merged with `getInitials` in `components/sidebar.tsx`,
 * which takes a display name only and has no email fallback.
 */
export function initialsOf(nameOrEmail: string | null | undefined): string {
  if (!nameOrEmail) return "?"
  const name = nameOrEmail.trim()
  if (name.includes("@")) return name[0]!.toUpperCase()
  const parts = name.split(/\s+/).filter(Boolean)
  return (
    ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() ||
    name[0]!.toUpperCase()
  )
}
