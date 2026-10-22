/**
 * Doc embeds: a Compass record referenced from a markdown Doc.
 *
 * Wire format is an ordinary markdown link whose destination is a compass://
 * URL (the same scheme the canvas uses, see lib/canvas-cards.ts):
 *
 *   [Cached title](compass://solution/<uuid>)
 *
 *   - alone in a top-level paragraph      => BLOCK embed (rendered as a card)
 *   - anywhere else (prose, list, quote)  => INLINE chip
 *
 * Every other markdown tool sees a normal link, so the format degrades
 * gracefully. The Doc stores only the reference plus a cached title; the title
 * is display-only, is never rewritten automatically, and is never trusted for
 * authorization (the server resolves every reference when rendering).
 *
 * A fenced block whose info string is `compass-embed` is RESERVED for a future
 * structured form: it is passed through verbatim as an ordinary code block and
 * its contents are never parsed.
 *
 * Pure module: no DB, no React, no markdown-it. The text between embeds is kept
 * verbatim in `text` segments, so serializeDocEmbeds(parseDocEmbeds(x)) === x
 * for any x whose embed links are already in canonical form.
 */
import { CANVAS_CARD_KINDS, MAX_CARD_TITLE_LENGTH, isUuid } from "@/lib/canvas-cards"

export const DOC_EMBED_KINDS = [...CANVAS_CARD_KINDS, "artifact"] as const
export type DocEmbedKind = (typeof DOC_EMBED_KINDS)[number]

export const RESERVED_EMBED_FENCE_INFO = "compass-embed"
export const MAX_EMBED_TITLE_LENGTH = MAX_CARD_TITLE_LENGTH

export type DocEmbedRef = { kind: DocEmbedKind; id: string }
export type DocEmbed = DocEmbedRef & { title: string }
export type DocEmbedForm = "block" | "inline"

export type DocEmbedSegment =
  | { type: "text"; text: string }
  | ({ type: "embed"; form: DocEmbedForm } & DocEmbed)

export type DocEmbedIssueCode = "malformed-link" | "unknown-kind" | "invalid-id"
export type DocEmbedIssue = { code: DocEmbedIssueCode; message: string; line: number; raw: string }

export type DocEmbedParseMode = "strict" | "lenient"
export type DocEmbedParseResult = { segments: DocEmbedSegment[]; issues: DocEmbedIssue[] }

export function isDocEmbedKind(value: unknown): value is DocEmbedKind {
  return typeof value === "string" && (DOC_EMBED_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Normalize a title for a NEW embed: newlines collapsed, trimmed, capped at 255
 * code points (not UTF-16 units, so an emoji is never split). Applied where an
 * embed is created, never when an existing one is parsed or serialized.
 */
export function normalizeEmbedTitle(title: string | undefined | null): string | undefined {
  if (!title) return undefined
  const cleaned = collapseNewlines(title).trim()
  if (!cleaned) return undefined
  return Array.from(cleaned).slice(0, MAX_EMBED_TITLE_LENGTH).join("")
}

const collapseNewlines = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ")

const escapeTitle = (s: string) => s.replace(/[\\[\]]/g, "\\$&")
// CommonMark: a backslash before any ASCII punctuation is an escape.
const unescapeTitle = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1")

/** The canonical one-line markdown for an embed. Does not truncate the title. */
export function serializeEmbed(embed: DocEmbed): string {
  return `[${escapeTitle(collapseNewlines(embed.title))}](compass://${embed.kind}/${embed.id})`
}

// ---------------------------------------------------------------------------
// Link recognition
// ---------------------------------------------------------------------------

const TITLE_SOURCE = String.raw`(?:[^\[\]\\\r\n]|\\.)*`
/** Any compass:// link; the URL is validated separately so strict mode can say why it failed. */
const ANY_COMPASS_LINK = new RegExp(String.raw`(!?)\[(${TITLE_SOURCE})\]\((compass:\/\/[^)\r\n]*)\)`, "g")
const WHOLE_COMPASS_LINK = new RegExp(String.raw`^\[(${TITLE_SOURCE})\]\((compass:\/\/[^)\r\n]*)\)$`)

type UrlCheck = { ok: true; ref: DocEmbedRef } | { ok: false; code: DocEmbedIssueCode; message: string }

function checkCompassUrl(url: string): UrlCheck {
  const match = /^compass:\/\/([^/]*)\/([^/]*)$/.exec(url)
  if (!match) return { ok: false, code: "malformed-link", message: `Malformed compass link "${url}"` }
  const [, kind, id] = match
  if (!isDocEmbedKind(kind)) return { ok: false, code: "unknown-kind", message: `Unknown embed kind "${kind}"` }
  if (!isUuid(id)) return { ok: false, code: "invalid-id", message: `Embed id "${id}" is not a UUID` }
  return { ok: true, ref: { kind, id } }
}

/**
 * The embed a string consists of in its entirety, or null. This is the
 * paragraph test shared with the editor's markdown-it rule: pass the raw
 * (still-escaped) paragraph source.
 */
export function parseBlockEmbedLine(source: string): DocEmbed | null {
  const match = WHOLE_COMPASS_LINK.exec(source.trim())
  if (!match) return null
  const check = checkCompassUrl(match[2])
  return check.ok ? { ...check.ref, title: unescapeTitle(match[1]) } : null
}

// ---------------------------------------------------------------------------
// Line classification (just enough CommonMark to find top-level paragraphs)
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const isBlank = (line: string) => line.trim() === ""
const isAtxHeading = (line: string) => /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
const isThematicBreak = (line: string) => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)
const isBlockquoteStart = (line: string) => /^ {0,3}>/.test(line)
const isListStart = (line: string) => /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+\S/.test(line)
const isFenceOpen = (line: string) => {
  const m = FENCE_OPEN.exec(line)
  return !!m && !(m[1][0] === "`" && m[2].includes("`"))
}

/** Lines that end a paragraph above them without being part of it. */
const interruptsParagraph = (line: string) =>
  isBlank(line) || isFenceOpen(line) || isAtxHeading(line) || isThematicBreak(line) || isBlockquoteStart(line) || isListStart(line)

/** Lines after which a new top-level paragraph can begin immediately. */
const endsStandaloneBlock = (line: string) => isBlank(line) || isAtxHeading(line) || isThematicBreak(line)

type Fence = { char: string; length: number }

function fenceOpener(line: string): (Fence & { info: string }) | null {
  const m = FENCE_OPEN.exec(line)
  if (!m || (m[1][0] === "`" && m[2].includes("`"))) return null
  return { char: m[1][0], length: m[1].length, info: m[2].trim().split(/\s+/)[0] ?? "" }
}

const closesFence = (line: string, fence: Fence) => {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return !!m && m[1][0] === fence.char && m[1].length >= fence.length
}

/** [start, end) ranges of inline code spans on a line, so links inside them are ignored. */
function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

export function parseDocEmbeds(markdown: string, options: { mode?: DocEmbedParseMode } = {}): DocEmbedParseResult {
  const strict = options.mode === "strict"
  const lines = markdown.match(/[^\n]*\n|[^\n]+/g) ?? []
  const body = (i: number) => lines[i].replace(/\r?\n$/, "")

  const segments: DocEmbedSegment[] = []
  const issues: DocEmbedIssue[] = []
  let pendingText = ""
  const flush = () => {
    if (pendingText) segments.push({ type: "text", text: pendingText })
    pendingText = ""
  }

  let fence: Fence | null = null
  let prevClosedFence = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = body(i)

    if (fence) {
      pendingText += raw
      prevClosedFence = closesFence(line, fence)
      if (prevClosedFence) fence = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      // Covers the reserved `compass-embed` fence too: its contents are opaque.
      fence = { char: opener.char, length: opener.length }
      pendingText += raw
      prevClosedFence = false
      continue
    }

    const prevOk = i === 0 || endsStandaloneBlock(body(i - 1)) || prevClosedFence
    const nextOk = i === lines.length - 1 || interruptsParagraph(body(i + 1))
    const blockEmbed = prevOk && nextOk && /^ {0,3}\[/.test(line) ? parseBlockEmbedLine(line) : null
    if (blockEmbed) {
      const start = line.indexOf("[")
      const end = line.lastIndexOf(")") + 1
      pendingText += raw.slice(0, start)
      flush()
      segments.push({ type: "embed", form: "block", ...blockEmbed })
      pendingText += raw.slice(end)
      prevClosedFence = false
      continue
    }

    prevClosedFence = false
    scanInline(raw, i + 1)
  }
  flush()
  return { segments, issues }

  function scanInline(raw: string, lineNumber: number) {
    const spans = codeSpanRanges(raw)
    const inCode = (at: number) => spans.some(([s, e]) => at >= s && at < e)
    const covered: Array<[number, number]> = []
    let cursor = 0
    ANY_COMPASS_LINK.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ANY_COMPASS_LINK.exec(raw))) {
      const [whole, bang, title, url] = m
      if (inCode(m.index) || raw[m.index - 1] === "\\") continue
      covered.push([m.index, m.index + whole.length])
      if (bang) continue
      const check = checkCompassUrl(url)
      if (!check.ok) {
        if (strict) issues.push({ code: check.code, message: check.message, line: lineNumber, raw: whole })
        continue
      }
      pendingText += raw.slice(cursor, m.index)
      flush()
      segments.push({ type: "embed", form: "inline", ...check.ref, title: unescapeTitle(title) })
      cursor = m.index + whole.length
    }
    pendingText += raw.slice(cursor)

    if (strict) {
      // A compass link the pattern could not even delimit (e.g. missing ")").
      const stray = /\]\(compass:\/\//g
      let s: RegExpExecArray | null
      while ((s = stray.exec(raw))) {
        if (inCode(s.index) || covered.some(([a, b]) => s!.index >= a && s!.index < b)) continue
        issues.push({
          code: "malformed-link",
          message: "Malformed compass link",
          line: lineNumber,
          raw: raw.slice(s.index).trim(),
        })
      }
    }
  }
}

/** Markdown for parsed segments: text verbatim, embeds in canonical form. */
export function serializeDocEmbeds(segments: DocEmbedSegment[]): string {
  return segments.map((s) => (s.type === "text" ? s.text : serializeEmbed(s))).join("")
}

/** Strict validation: every problem found, empty when the document is clean. */
export function validateDocEmbeds(markdown: string): DocEmbedIssue[] {
  return parseDocEmbeds(markdown, { mode: "strict" }).issues
}
