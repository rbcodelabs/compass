/**
 * A small, defensive HTML -> readable markdown converter for the agent's `web_fetch` tool.
 *
 * It is a reader, not a renderer: script, style, iframe, svg and other non-content elements are
 * dropped, elements hidden from the user (hidden attribute, aria-hidden, display:none) are dropped
 * because hidden text is a common carrier for injected instructions, and what remains keeps its
 * structure (headings, paragraphs, lists, links, code blocks, quotes, table rows) so the model can
 * follow the page. Links are resolved against the page URL and limited to http(s).
 *
 * Input is already size-capped by the fetcher; the walk is additionally bounded in depth and node
 * count so a pathological document cannot exhaust the stack or the request.
 */
import * as cheerio from "cheerio"

interface DomNode {
  type: string
  name?: string
  data?: string
  children?: DomNode[]
  attribs?: Record<string, string>
}

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "iframe", "frame", "frameset", "svg", "math", "template", "object", "embed", "canvas", "audio", "video", "head", "select", "option", "button", "input", "textarea", "link", "meta"])
const BLOCK_ELEMENTS = new Set(["div", "section", "article", "main", "header", "footer", "aside", "nav", "form", "figure", "figcaption", "details", "summary", "dl", "dd", "dt", "address", "fieldset", "table", "thead", "tbody", "tfoot", "caption", "center", "body", "html"])
const MAX_DEPTH = 120
const MAX_NODES = 200_000
const MAX_LINK_LENGTH = 500
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i
// C0 controls except tab/newline, DEL, zero-width characters, and bidirectional overrides.
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/** Output accumulator that collapses block separators instead of emitting them eagerly. */
class Writer {
  private parts: string[] = []
  private pendingBreak = 0
  private last = ""
  size = 0

  text(value: string) {
    if (!value) return
    if (this.pendingBreak > 0 && this.parts.length > 0) this.push("\n".repeat(this.pendingBreak))
    this.pendingBreak = 0
    this.push(value)
  }
  /** Ensures at least `lines` newlines separate what came before from what comes next. */
  breakLines(lines: number) {
    this.pendingBreak = Math.max(this.pendingBreak, lines)
  }
  get lastChar() {
    return this.pendingBreak > 0 ? "\n" : this.last
  }
  toString() {
    return this.parts.join("")
  }
  private push(value: string) {
    this.parts.push(value)
    this.size += value.length
    this.last = value[value.length - 1] ?? this.last
  }
}

interface Context {
  base: URL | null
  nodes: number
  listDepth: number
}

function isHidden(node: DomNode): boolean {
  const attribs = node.attribs
  if (!attribs) return false
  if ("hidden" in attribs) return true
  if (attribs["aria-hidden"] === "true") return true
  return typeof attribs.style === "string" && HIDDEN_STYLE.test(attribs.style)
}

function safeHref(href: string | undefined, base: URL | null): string | null {
  if (!href || href.length > MAX_LINK_LENGTH * 2) return null
  try {
    const url = base ? new URL(href, base) : new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    const out = url.href
    return out.length <= MAX_LINK_LENGTH ? out : null
  } catch {
    return null
  }
}

function plainText(node: DomNode): string {
  if (node.type === "text") return node.data ?? ""
  if (node.name && SKIP_ELEMENTS.has(node.name)) return ""
  return (node.children ?? []).map(plainText).join("")
}

function renderChildren(node: DomNode, out: Writer, context: Context, depth: number) {
  for (const child of node.children ?? []) walk(child, out, context, depth + 1)
}

/** Renders `node`'s children into a fresh writer, for elements that wrap or prefix their content. */
function renderToString(node: DomNode, context: Context, depth: number): string {
  const sub = new Writer()
  renderChildren(node, sub, context, depth)
  return tidy(sub.toString())
}

function walk(node: DomNode, out: Writer, context: Context, depth: number) {
  if (depth > MAX_DEPTH || ++context.nodes > MAX_NODES) return
  if (node.type === "text") {
    let value = (node.data ?? "").replace(/\s+/g, " ")
    if (/\s$/.test(out.lastChar) || out.lastChar === "") value = value.replace(/^ /, "")
    out.text(value)
    return
  }
  const name = node.name?.toLowerCase()
  // Comments, directives and CDATA carry nothing a reader would see.
  if (!name || (node.type !== "tag" && node.type !== "script" && node.type !== "style")) {
    if (node.type === "root") renderChildren(node, out, context, depth)
    return
  }
  if (SKIP_ELEMENTS.has(name) || isHidden(node)) return

  if (/^h[1-6]$/.test(name)) {
    const heading = renderToString(node, context, depth).replace(/\s*\n\s*/g, " ")
    if (!heading) return
    out.breakLines(2)
    out.text(`${"#".repeat(Number(name[1]))} ${heading}`)
    out.breakLines(2)
    return
  }
  switch (name) {
    case "br":
      out.text("\n")
      return
    case "hr":
      out.breakLines(2)
      out.text("---")
      out.breakLines(2)
      return
    case "p":
      out.breakLines(2)
      renderChildren(node, out, context, depth)
      out.breakLines(2)
      return
    case "ul":
    case "ol": {
      out.breakLines(1)
      context.listDepth++
      let index = 0
      for (const child of node.children ?? []) {
        if (child.type === "tag" && child.name === "li" && !isHidden(child)) {
          index++
          const body = renderToString(child, context, depth + 1)
          if (!body) continue
          const marker = name === "ol" ? `${index}. ` : "- "
          const indent = "  ".repeat(context.listDepth - 1)
          out.breakLines(1)
          out.text(`${indent}${marker}${body.replace(/\n+/g, `\n${indent}  `)}`)
        } else {
          walk(child, out, context, depth + 1)
        }
      }
      context.listDepth--
      out.breakLines(1)
      return
    }
    case "li": {
      // A stray li outside a list.
      const body = renderToString(node, context, depth)
      if (body) {
        out.breakLines(1)
        out.text(`- ${body}`)
        out.breakLines(1)
      }
      return
    }
    case "a": {
      const label = renderToString(node, context, depth).replace(/\s*\n\s*/g, " ")
      const href = safeHref(node.attribs?.href, context.base)
      if (!label) return
      out.text(href && href !== label ? `[${label}](${href})` : label)
      return
    }
    case "pre": {
      const code = plainText(node).replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "")
      if (!code) return
      out.breakLines(2)
      out.text(`\`\`\`\n${code.replace(/```/g, "'''")}\n\`\`\``)
      out.breakLines(2)
      return
    }
    case "code": {
      const code = plainText(node).replace(/\s+/g, " ").trim()
      if (code) out.text(`\`${code.replace(/`/g, "'")}\``)
      return
    }
    case "blockquote": {
      const quoted = renderToString(node, context, depth)
      if (!quoted) return
      out.breakLines(2)
      out.text(quoted.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"))
      out.breakLines(2)
      return
    }
    case "tr": {
      const cells: string[] = []
      for (const child of node.children ?? []) {
        if (child.type === "tag" && (child.name === "td" || child.name === "th") && !isHidden(child)) {
          cells.push(renderToString(child, context, depth + 1).replace(/\s*\n\s*/g, " "))
        }
      }
      const row = cells.join(" | ").trim()
      if (row.replace(/\|/g, "").trim()) {
        out.breakLines(1)
        out.text(row)
        out.breakLines(1)
      }
      return
    }
    default:
      if (BLOCK_ELEMENTS.has(name)) {
        out.breakLines(1)
        renderChildren(node, out, context, depth)
        out.breakLines(1)
      } else {
        renderChildren(node, out, context, depth)
      }
  }
}

/** Trims line ends, drops invisible characters and collapses runs of blank lines. */
export function tidy(value: string): string {
  return value
    .replace(INVISIBLE_CHARS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface ConvertedHtml {
  title: string
  text: string
}

export function htmlToMarkdown(html: string, baseUrl?: string): ConvertedHtml {
  let base: URL | null = null
  try {
    base = baseUrl ? new URL(baseUrl) : null
  } catch {
    base = null
  }
  const $ = cheerio.load(html)
  const title = tidy($("title").first().text()).replace(/\s+/g, " ").slice(0, 300)
  const out = new Writer()
  walk($.root()[0] as unknown as DomNode, out, { base, nodes: 0, listDepth: 0 }, 0)
  return { title, text: tidy(out.toString()) }
}

/** Plain-text bodies (text, markdown, JSON, XML, CSV): only invisible characters and line endings are normalised. */
export function normalizePlainText(value: string): string {
  return tidy(value.replace(/\r\n?/g, "\n"))
}
