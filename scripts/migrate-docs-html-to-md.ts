#!/usr/bin/env node
/**
 * One-time migration: convert doc content from HTML (stored by the old TipTap
 * editor via getHTML()) to markdown (stored by the new tiptap-markdown editor).
 *
 * Idempotent — skips docs whose content is already markdown or empty.
 * Detection heuristic: HTML content starts with "<" or contains block-level tags.
 *
 * Run:
 *   node --experimental-strip-types scripts/migrate-docs-html-to-md.ts
 *
 * Requires DATABASE_URL / PGHOST etc. in environment (same as the app).
 */

import rehypeRemark from "rehype-remark"
import remarkStringify from "remark-stringify"
import { unified } from "unified"
import rehypeParse from "rehype-parse"

// Dynamic import for Prisma to avoid TS module issues
const { default: getPrisma } = await import("../lib/db.js")

// ── helpers ──────────────────────────────────────────────────────────────────

const HTML_PATTERN = /^<[a-zA-Z]|<(p|h[1-6]|ul|ol|li|strong|em|code|pre|blockquote|br)\b/

function looksLikeHtml(content: string): boolean {
  return HTML_PATTERN.test(content.trim())
}

async function htmlToMarkdown(html: string): Promise<string> {
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkStringify)
    .process(html)
  return String(file).trim()
}

function excerpt(s: string, len = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  return oneLine.length > len ? oneLine.slice(0, len) + "…" : oneLine
}

// ── main ─────────────────────────────────────────────────────────────────────

const prisma = getPrisma()

const docs = await prisma.doc.findMany({
  select: { id: true, title: true, content: true },
  orderBy: { createdAt: "asc" },
})

console.log(`Found ${docs.length} doc(s) total.`)

let skipped = 0
let converted = 0
let errors = 0

for (const doc of docs) {
  if (!doc.content || !looksLikeHtml(doc.content)) {
    skipped++
    continue
  }

  try {
    const markdown = await htmlToMarkdown(doc.content)

    await prisma.doc.update({
      where: { id: doc.id },
      data: { content: markdown },
    })

    console.log(`✓ [${doc.id}] "${doc.title}"`)
    console.log(`  Before: ${excerpt(doc.content)}`)
    console.log(`  After:  ${excerpt(markdown)}`)
    converted++
  } catch (err) {
    console.error(`✗ [${doc.id}] "${doc.title}" — ${err}`)
    errors++
  }
}

console.log(`\nDone. Converted: ${converted}, Skipped: ${skipped}, Errors: ${errors}`)

await prisma.$disconnect()
