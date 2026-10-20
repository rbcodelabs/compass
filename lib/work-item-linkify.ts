import { entityPath, type EntityLinkType, type WorkspaceSlugs } from "@/lib/entity-links"
import { parseDisplayId } from "@/lib/work-item-ids"

/**
 * Turns display IDs in prose (`see TASK-12 and OPP-3`) into links, for comments, descriptions and chat replies.
 *
 * Purely textual: the link carries the display ID itself (`/org/ws/tasks/TASK-12`), and the destination page
 * resolves it inside the workspace, so no lookup happens while rendering. A reference to a row that does not exist
 * is therefore a link that 404s, which is why only UPPER-CASE tokens with a registered prefix are linked: `task-12`
 * in running text, `DOC-1` inside a URL, or `ABC-123` for some other tracker are left alone.
 *
 * Dependency-free (no react-markdown, no unist): it works on the minimal mdast shape and is exported as a remark
 * plugin factory so MarkdownContent can opt in.
 */

// Not preceded by a word character, "-", "/", "#", "." or "@" (so `ABC-TASK-5`, a URL path or an e-mail local part
// is not matched), and not followed by a word character or "-" (so `TASK-5-beta` is not half-linked).
const TOKEN = /(?<![\w\-/#.@])([A-Z]{2,5})-(\d{1,9})(?![\w-])/g

type Text = { type: "text"; value: string }
type Link = { type: "link"; url: string; title?: null; children: Text[] }
type Node = { type: string; value?: string; children?: Node[]; url?: string }

function linkFor(token: string, slugs: WorkspaceSlugs): Link | null {
  const parsed = parseDisplayId(token)
  if (!parsed) return null
  // Only types whose link builder knows where they live. Metrics, studies, decisions and the like have their own
  // pages that this renderer does not know about yet; they stay plain text rather than linking somewhere wrong.
  if (!LINKABLE.has(parsed.type)) return null
  const displayId = `${parsed.prefix}-${parsed.number}`
  const url = entityPath({ ...slugs, type: parsed.type as EntityLinkType, id: displayId, displayId })
  return { type: "link", url, children: [{ type: "text", value: token }] }
}

const LINKABLE: ReadonlySet<string> = new Set<EntityLinkType>([
  "objective", "keyResult", "opportunity", "solution", "assumption", "experiment", "roadmapItem", "feedback", "task", "doc", "artifact",
])

/** Splits one text value into text and link nodes, or returns null when nothing in it is a linkable ID. */
export function splitWorkItemRefs(value: string, slugs: WorkspaceSlugs): Array<Text | Link> | null {
  const out: Array<Text | Link> = []
  let last = 0
  for (const match of value.matchAll(TOKEN)) {
    const link = linkFor(match[0], slugs)
    if (!link) continue
    const start = match.index ?? 0
    if (start > last) out.push({ type: "text", value: value.slice(last, start) })
    out.push(link)
    last = start + match[0].length
  }
  if (out.length === 0) return null
  if (last < value.length) out.push({ type: "text", value: value.slice(last) })
  return out
}

const SKIP = new Set(["link", "linkReference", "code", "inlineCode", "definition", "html", "image", "imageReference"])

function walk(node: Node, slugs: WorkspaceSlugs) {
  if (!node.children || SKIP.has(node.type)) return
  const next: Node[] = []
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitWorkItemRefs(child.value, slugs)
      if (parts) next.push(...(parts as Node[]))
      else next.push(child)
    } else {
      walk(child, slugs)
      next.push(child)
    }
  }
  node.children = next
}

/** remark plugin: `remarkPlugins={[remarkGfm, [remarkWorkItemRefs, slugs]]}`. */
export function remarkWorkItemRefs(slugs: WorkspaceSlugs) {
  return (tree: Node) => walk(tree, slugs)
}
