import { remark } from "remark"
import remarkGfm from "remark-gfm"

type MdNode = { type: string; value?: string; alt?: string | null; children?: MdNode[] }

const BLOCK_TYPES = new Set([
  "paragraph", "heading", "listItem", "blockquote", "code", "table", "tableRow", "tableCell", "thematicBreak",
])

const processor = remark().use(remarkGfm)

function collect(node: MdNode, out: string[]): void {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    if (node.value) out.push(node.value)
  } else if (node.type === "image") {
    if (node.alt) out.push(node.alt)
  } else if (node.type === "break") {
    out.push(" ")
  } else if (node.type !== "html") {
    for (const child of node.children ?? []) collect(child, out)
  }
  // Keep adjacent blocks ("## Steps" then "1. Open") from fusing into one word.
  if (BLOCK_TYPES.has(node.type)) out.push(" ")
}

/**
 * A one-line, markup-free preview of a Markdown description — for places that
 * show a clamped excerpt (the feedback grid's title cell and mobile card)
 * rather than rendering the Markdown. Without this, a description written in
 * the composer's rich editor surfaces in the grid as `## Steps to reproduce 1.
 * Open **Settings**`. Raw HTML is dropped, never rendered.
 */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown?.trim()) return ""
  const tree = processor.parse(markdown) as MdNode
  const out: string[] = []
  collect(tree, out)
  return out.join("").replace(/\s+/g, " ").trim()
}
