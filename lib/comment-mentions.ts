/**
 * Structured @mentions inside a comment body.
 *
 * A mention is stored in `body` as an id-bearing token, never as the bare name:
 *
 *     @[Quinn Morales](mention:user:6f1c...)   a workspace member
 *     @[PM Agent](mention:agent:6f1c...)       an agent
 *
 * The id is the source of truth. The bracketed label is only a snapshot for
 * clients that cannot resolve ids (MCP readers, exports); the UI resolves the id
 * at render time, so renaming a person or agent never breaks a mention. The token
 * degrades to a normal markdown-looking link in plain-text consumers, and no
 * schema change is needed (Comment.body stays a text column).
 *
 * Pure module: no I/O, safe to import from client and server code.
 */

export type MentionKind = "user" | "agent"

export interface MentionRef {
  kind: MentionKind
  id: string
  /** Display snapshot taken when the mention was written. */
  label: string
}

export interface MentionMatch extends MentionRef {
  /** Offsets of the whole token in the body. */
  start: number
  end: number
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const TOKEN_SOURCE = `@\\[([^\\]\\n]{1,100})\\]\\(mention:(user|agent):(${UUID})\\)`
const MAX_LABEL = 100

/** Characters that would end the token early or confuse markdown renderers. */
function sanitizeLabel(label: string): string {
  const clean = label.replace(/[\[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim()
  return (clean || "Unknown").slice(0, MAX_LABEL)
}

export function serializeMention(ref: MentionRef): string {
  return `@[${sanitizeLabel(ref.label)}](mention:${ref.kind}:${ref.id.toLowerCase()})`
}

/** Every mention token in the body, in document order (repeats included). */
export function parseMentions(body: string): MentionMatch[] {
  const matches: MentionMatch[] = []
  for (const m of body.matchAll(new RegExp(TOKEN_SOURCE, "gi"))) {
    matches.push({
      label: m[1],
      kind: m[2].toLowerCase() as MentionKind,
      id: m[3].toLowerCase(),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    })
  }
  return matches
}

/** Distinct mentions by (kind, id), keeping first-occurrence order. */
export function uniqueMentions(body: string): MentionRef[] {
  const seen = new Set<string>()
  const refs: MentionRef[] = []
  for (const { kind, id, label } of parseMentions(body)) {
    const key = `${kind}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ kind, id, label })
  }
  return refs
}

/**
 * First distinct mention is the assignee; every other distinct mention is a
 * watcher (notified only). "One task per comment" follows from this: there is a
 * single assignee slot. `preferred` lets the author promote a different
 * mention to assignee; it is ignored unless it really is mentioned in the body.
 */
export function mentionRoles(
  body: string,
  preferred?: { kind: MentionKind; id: string } | null,
): { assignee: MentionRef | null; watchers: MentionRef[] } {
  const all = uniqueMentions(body)
  const wanted = preferred ? all.find(m => m.kind === preferred.kind && m.id === preferred.id.toLowerCase()) : undefined
  const assignee = wanted ?? all[0] ?? null
  return { assignee, watchers: all.filter(m => m !== assignee) }
}

export type BodySegment =
  | { type: "text"; text: string }
  | { type: "mention"; mention: MentionRef }

/** Split a body into text and mention segments for rendering. */
export function bodySegments(body: string): BodySegment[] {
  const segments: BodySegment[] = []
  let cursor = 0
  for (const match of parseMentions(body)) {
    if (match.start > cursor) segments.push({ type: "text", text: body.slice(cursor, match.start) })
    segments.push({ type: "mention", mention: { kind: match.kind, id: match.id, label: match.label } })
    cursor = match.end
  }
  if (cursor < body.length) segments.push({ type: "text", text: body.slice(cursor) })
  return segments
}

/** Body with each token replaced by `@Label`, using `resolveLabel` for live names when given. */
export function plainTextOf(body: string, resolveLabel?: (ref: MentionRef) => string | undefined): string {
  return bodySegments(body)
    .map(segment => segment.type === "text" ? segment.text : `@${resolveLabel?.(segment.mention) ?? segment.mention.label}`)
    .join("")
}

const TITLE_MAX = 120

/**
 * Default task title for a comment: the comment text without mention chips,
 * whitespace collapsed and trailing punctuation dropped. Falls back to the
 * quoted passage when the comment is nothing but mentions.
 */
export function suggestTaskTitle(body: string, anchorText?: string | null): string {
  const text = bodySegments(body)
    .filter((segment): segment is Extract<BodySegment, { type: "text" }> => segment.type === "text")
    .map(segment => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;\-]+/, "")
    .replace(/[\s.?!,:;]+$/, "")
    .trim()
  if (text) return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text
  const anchor = anchorText?.replace(/\s+/g, " ").trim()
  if (anchor) return `Follow up: ${anchor.length > 80 ? `${anchor.slice(0, 79).trimEnd()}…` : anchor}`
  return "Follow up on comment"
}

/** Marks a mention link whose person has no access to the workspace, so the chip can be styled to match. */
export const OUTSIDE_MENTION_FLAG = "#outside"

const MENTION_HREF = new RegExp(`^mention:(user|agent):(${UUID})(#outside)?$`, "i")

/** Parse the `href` produced by {@link mentionsAsMarkdownLinks}; null for any other link. */
export function parseMentionHref(href: string | undefined): { kind: MentionKind; id: string; outside: boolean } | null {
  const match = href ? MENTION_HREF.exec(href) : null
  return match ? { kind: match[1].toLowerCase() as MentionKind, id: match[2].toLowerCase(), outside: Boolean(match[3]) } : null
}

/**
 * Rewrite each `@[Name](mention:kind:id)` token as the markdown link `[@Name](mention:kind:id)` so a markdown
 * renderer can turn it into a chip. `resolve` swaps in the live name (and outside-workspace flag) for an id.
 */
export function mentionsAsMarkdownLinks(
  body: string,
  resolve?: (ref: MentionRef) => { name?: string; outside?: boolean } | undefined,
): string {
  return bodySegments(body)
    .map(segment => {
      if (segment.type === "text") return segment.text
      const live = resolve?.(segment.mention)
      const label = sanitizeLabel(live?.name ?? segment.mention.label)
      return `[@${label}](mention:${segment.mention.kind}:${segment.mention.id}${live?.outside ? OUTSIDE_MENTION_FLAG : ""})`
    })
    .join("")
}
