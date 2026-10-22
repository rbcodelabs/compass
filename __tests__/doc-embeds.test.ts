import { describe, it, expect } from "vitest"
import { CANVAS_CARD_KINDS } from "@/lib/canvas-cards"
import {
  DOC_EMBED_KINDS,
  RESERVED_EMBED_FENCE_INFO,
  normalizeEmbedTitle,
  parseDocEmbeds,
  parseBlockEmbedLine,
  serializeDocEmbeds,
  serializeEmbed,
  validateDocEmbeds,
} from "@/lib/doc-embeds"

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const ID2 = "11111111-2222-4333-8444-555555555555"
const link = (title: string, kind = "solution", id = ID) => `[${title}](compass://${kind}/${id})`

const roundTrip = (md: string) => serializeDocEmbeds(parseDocEmbeds(md).segments)
const embeds = (md: string) => parseDocEmbeds(md).segments.filter((s) => s.type === "embed")
const forms = (md: string) => embeds(md).map((e) => (e.type === "embed" ? e.form : null))

describe("doc-embeds kinds", () => {
  it("reuses the canvas kinds and adds artifact", () => {
    expect([...DOC_EMBED_KINDS]).toEqual([...CANVAS_CARD_KINDS, "artifact"])
  })
})

describe("block vs inline classification", () => {
  it("a lone link in a top-level paragraph is a block embed", () => {
    const md = `Intro\n\n${link("Checkout redesign")}\n\nOutro\n`
    expect(embeds(md)[0]).toMatchObject({ form: "block", kind: "solution", id: ID, title: "Checkout redesign" })
  })

  it("allows up to three spaces of indent and trailing spaces on a block embed", () => {
    expect(forms(`   ${link("A")}  \n`)).toEqual(["block"])
  })

  it("a link mid-sentence is an inline chip", () => {
    const md = `We believe ${link("this")} matters.\n`
    expect(embeds(md)).toHaveLength(1)
    expect(embeds(md)[0]).toMatchObject({ form: "inline", title: "this" })
  })

  it("a link in a list item is an inline chip, even when alone", () => {
    const md = `- ${link("One")}\n- ${link("Two", "task", ID2)}\n\n1. ${link("Three")}\n`
    expect(forms(md)).toEqual(["inline", "inline", "inline"])
  })

  it("a link in a blockquote is inline", () => {
    expect(forms(`> ${link("Quoted")}\n`)).toEqual(["inline"])
  })

  it("embeds separated by a blank line are both blocks", () => {
    expect(forms(`${link("A")}\n\n${link("B", "task", ID2)}\n`)).toEqual(["block", "block"])
  })

  it("embeds on consecutive lines share a paragraph, so both are inline", () => {
    expect(forms(`${link("A")}\n${link("B", "task", ID2)}\n`)).toEqual(["inline", "inline"])
  })

  it("two links on one line are inline", () => {
    expect(forms(`${link("A")} ${link("B", "task", ID2)}\n`)).toEqual(["inline", "inline"])
  })

  it("a heading or fence next to the line does not join its paragraph", () => {
    const md = `# Heading\n${link("A")}\n\`\`\`ts\ncode\n\`\`\`\n${link("B", "task", ID2)}\n`
    expect(forms(md)).toEqual(["block", "block"])
  })

  it("all documented kinds are accepted", () => {
    for (const kind of DOC_EMBED_KINDS) {
      expect(embeds(`${link("x", kind)}\n`)).toHaveLength(1)
    }
  })

  it("parseBlockEmbedLine accepts only a single whole-paragraph embed", () => {
    expect(parseBlockEmbedLine(link("A"))).toMatchObject({ kind: "solution", id: ID, title: "A" })
    expect(parseBlockEmbedLine(`x ${link("A")}`)).toBeNull()
    expect(parseBlockEmbedLine(`${link("A")} x`)).toBeNull()
    expect(parseBlockEmbedLine("[A](https://example.com)")).toBeNull()
    expect(parseBlockEmbedLine(link("A", "nope"))).toBeNull()
  })
})

describe("round trip serialize(parse(x)) === x", () => {
  const cases: Record<string, string> = {
    plain: `# Spec\n\nSome text.\n`,
    "bracketed title": `${link("Plan \\[draft\\] v2")}\n`,
    "parenthesised title": `${link("Plan (draft) v2")}\n`,
    "emoji title": `${link("Launch 🚀 plan 👩‍👩‍👧")}\n`,
    "backslash title": `${link("C:\\\\path")}\n`,
    "255 char title": `${link("a".repeat(255))}\n`,
    "300 char title": `${link("é".repeat(300))}\n`,
    "emoji past 255": `${link("🚀".repeat(260))}\n`,
    "empty title": `${link("")}\n`,
    "list links": `- ${link("One")}\n- ${link("Two", "task", ID2)}\n\n1. ${link("Three", "metric")}\n`,
    "mid sentence": `See ${link("this one")}, then ${link("that", "doc", ID2)}.\n`,
    "adjacent embeds": `${link("A")}\n\n${link("B", "task", ID2)}\n`,
    "adjacent without blank": `${link("A")}\n${link("B", "task", ID2)}\n`,
    "uppercase uuid": `${link("A", "solution", ID.toUpperCase())}\n`,
    crlf: `Intro\r\n\r\n${link("A")}\r\n`,
    "no trailing newline": link("A"),
    "ordinary https link": `[Docs](https://example.com/a(b))\n\n${link("A")}\n`,
    "unknown kind stays plain": `[x](compass://nope/${ID})\n`,
    "bad uuid stays plain": `[x](compass://solution/not-a-uuid)\n`,
    "reserved fence": "```compass-embed\n" + link("A") + "\n```\n",
    "reserved fence with attrs": "~~~compass-embed foo\nanything [x](compass://solution/zz)\n~~~\n",
    "image is not an embed": `![x](compass://solution/${ID})\n`,
  }
  for (const [name, md] of Object.entries(cases)) {
    it(name, () => expect(roundTrip(md)).toBe(md))
  }

  it("is idempotent for non-canonical input", () => {
    const md = `${link("a *b* \\*c\\*")}\n`
    const once = roundTrip(md)
    expect(roundTrip(once)).toBe(once)
  })
})

describe("what is and is not an embed", () => {
  it("leaves ordinary and unknown compass links as plain text", () => {
    const md = `[a](https://example.com)\n\n[b](compass://nope/${ID})\n\n[c](compass://solution/zzz)\n`
    expect(embeds(md)).toHaveLength(0)
  })

  it("passes the reserved fence through verbatim without parsing its contents", () => {
    expect(RESERVED_EMBED_FENCE_INFO).toBe("compass-embed")
    expect(embeds("```compass-embed\n" + link("A") + "\n```\n")).toHaveLength(0)
  })

  it("does not parse links inside any fenced code or inline code", () => {
    expect(embeds("```\n" + link("A") + "\n```\n")).toHaveLength(0)
    expect(embeds("Use `" + link("A") + "` syntax\n")).toHaveLength(0)
  })

  it("a fence closer must be at least as long as the opener", () => {
    const md = "````\n```\n" + link("A") + "\n````\n\n" + link("B") + "\n"
    expect(embeds(md).map((e) => (e.type === "embed" ? e.title : null))).toEqual(["B"])
  })
})

describe("strict vs lenient", () => {
  const bad = {
    unknownKind: `[x](compass://nope/${ID})\n`,
    badId: `[x](compass://solution/not-a-uuid)\n`,
    missingId: `[x](compass://solution)\n`,
    unclosed: `[x](compass://solution/${ID}\n`,
  }

  it("lenient keeps everything and reports no issues", () => {
    for (const md of Object.values(bad)) {
      const parsed = parseDocEmbeds(md, { mode: "lenient" })
      expect(parsed.issues).toEqual([])
      expect(serializeDocEmbeds(parsed.segments)).toBe(md)
    }
  })

  it("strict reports errors with codes and line numbers", () => {
    expect(parseDocEmbeds(bad.unknownKind, { mode: "strict" }).issues).toMatchObject([{ code: "unknown-kind", line: 1 }])
    expect(parseDocEmbeds(bad.badId, { mode: "strict" }).issues).toMatchObject([{ code: "invalid-id", line: 1 }])
    expect(parseDocEmbeds(bad.missingId, { mode: "strict" }).issues).toMatchObject([{ code: "malformed-link", line: 1 }])
    expect(parseDocEmbeds(bad.unclosed, { mode: "strict" }).issues).toMatchObject([{ code: "malformed-link", line: 1 }])
    expect(parseDocEmbeds(`ok\n\n${bad.unknownKind}`, { mode: "strict" }).issues[0].line).toBe(3)
  })

  it("strict ignores ordinary links, code, and the reserved fence", () => {
    const md = "[a](https://example.com)\n\n```compass-embed\n[x](compass://nope/1)\n```\n\n`[x](compass://nope/1)`\n"
    expect(validateDocEmbeds(md)).toEqual([])
  })

  it("validateDocEmbeds is strict by default", () => {
    expect(validateDocEmbeds(bad.unknownKind)).toHaveLength(1)
    expect(validateDocEmbeds(`${link("fine")}\n`)).toEqual([])
  })
})

describe("title handling", () => {
  it("serializeEmbed escapes brackets and backslashes and strips newlines", () => {
    expect(serializeEmbed({ kind: "task", id: ID, title: "a [b]\nc\\d" })).toBe(
      `[a \\[b\\] c\\\\d](compass://task/${ID})`
    )
  })

  it("serializeEmbed never truncates a stored title", () => {
    const title = "x".repeat(400)
    expect(serializeEmbed({ kind: "task", id: ID, title })).toContain(title)
  })

  it("normalizeEmbedTitle caps at 255 code points, strips newlines and trims", () => {
    expect(Array.from(normalizeEmbedTitle("🚀".repeat(300))!)).toHaveLength(255)
    expect(normalizeEmbedTitle("  a\n b\r\n c ")).toBe("a b c")
    expect(normalizeEmbedTitle("   ")).toBeUndefined()
    expect(normalizeEmbedTitle(undefined)).toBeUndefined()
  })

  it("the parser never rewrites a cached title", () => {
    const t = "Old name (renamed since)"
    expect(embeds(`${link(t)}\n`)[0]).toMatchObject({ title: t })
  })

  it("unescapes titles on parse", () => {
    expect(embeds(`${link("a \\[b\\] \\\\ c")}\n`)[0]).toMatchObject({ title: "a [b] \\ c" })
  })
})
