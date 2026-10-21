/** The "Specs and Discovery Plans" help page: registered for /help/[slug], rendered, and linked both ways with the MCP API reference. */
import { describe, expect, it } from "vitest"
import { getAllDocs, getDoc, getDocRaw, getHelpTopic } from "@/lib/docs"
import { DOC_EMBED_KINDS } from "@/lib/doc-embeds"

const SLUG = "29-specs-and-discovery-plans"

describe("Specs and Discovery Plans help page", () => {
  it("is registered once, after the pages it follows", () => {
    const matches = getAllDocs().filter((doc) => doc.slug === SLUG)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ title: "Specs and Discovery Plans", order: 29, section: "Core Features" })
    expect(Math.max(...getAllDocs().map((d) => d.order))).toBe(29)
  })

  it("renders for /help/[slug] and resolves by title for get_help", async () => {
    const page = await getDoc(SLUG)
    expect(page).not.toBeNull()
    expect(page!.html).toContain("<h1")
    expect(getHelpTopic("Specs and Discovery Plans")?.slug).toBe(SLUG)
    expect(getHelpTopic("specs-and-discovery-plans")?.slug).toBe(SLUG)
  })

  it("documents the embed syntax: card alone in a paragraph, plain link elsewhere, cached title is only a hint", () => {
    const raw = getDocRaw(SLUG)!.content
    expect(raw).toContain("[Checkout redesign](compass://solution/")
    expect(raw).toMatch(/Alone in its own paragraph/)
    expect(raw).toMatch(/Anywhere else/)
    expect(raw).toMatch(/cached title/i)
    expect(raw).toMatch(/never shows it/i)
  })

  it("lists every embeddable kind", () => {
    const raw = getDocRaw(SLUG)!.content
    for (const kind of DOC_EMBED_KINDS) expect(raw).toContain(`\`${kind}\``)
  })

  it("explains Record unavailable without saying why", () => {
    const raw = getDocRaw(SLUG)!.content
    expect(raw).toContain("Record unavailable")
    expect(raw).toMatch(/deliberately does not say which/)
  })

  it("explains the section entry points, the labels and read-only access", () => {
    const raw = getDocRaw(SLUG)!.content
    for (const text of ["**Specs**", "**Discovery Plans**", "**New spec**", "**New plan**", "**Spec (unscoped)**", "read-only"]) expect(raw).toContain(text)
  })

  it("is linked from the MCP API section and links back to it, and the MCP reference documents get_spec", async () => {
    const mcp = getDocRaw("09-mcp-api")!.content
    expect(mcp).toContain(`(/help/${SLUG})`)
    expect(mcp).toContain("`get_spec`")
    expect(getDocRaw(SLUG)!.content).toContain("(/help/09-mcp-api#specs-and-discovery-plans)")
    expect((await getDoc("09-mcp-api"))!.html).toContain('id="specs-and-discovery-plans"')
  })
})
