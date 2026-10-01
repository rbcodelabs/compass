import { describe, expect, it } from "vitest"
import { getAllDocs, getDoc, getDocRaw, getHelpTopic, searchHelp } from "@/lib/docs"
import { getHelp, searchHelp as searchHelpTool } from "@/lib/help-tool-handlers"

describe("thinking-model and typed-link documentation is registered with the help tools", () => {
  it("registers the thinking models page once, ordered after the pages it follows", () => {
    const docs = getAllDocs()
    const page = docs.filter((doc) => doc.slug === "27-thinking-models")
    expect(page).toHaveLength(1)
    expect(page[0].title).toBe("Thinking models")
    expect(page[0].order).toBe(27)
  })

  it("resolves the page by slug suffix and by title for get_help", () => {
    expect(getHelpTopic("thinking-models")?.slug).toBe("27-thinking-models")
    expect(getHelpTopic("Thinking models")?.slug).toBe("27-thinking-models")
  })

  it("finds each new tool's reference section when searching by its name", () => {
    for (const tool of [
      "link_opportunity_to_objective",
      "unlink_opportunity_from_objective",
      "link_solution_to_key_result",
      "unlink_solution_from_key_result",
      "list_links",
    ]) {
      const [top] = searchHelp(tool, 5)
      expect(top?.slug, tool).toBe("09-mcp-api")
      expect(top?.anchor, tool).toBe(tool)
    }
  })

  it("finds the stillLinkedViaKeyResult semantics in the unlink tool's section", () => {
    const [top] = searchHelp("unlink opportunity from objective stillLinkedViaKeyResult", 5)
    expect(top?.slug).toBe("09-mcp-api")
    expect(top?.anchor).toBe("unlink_opportunity_from_objective")
    expect(getDocRaw("09-mcp-api")!.content).toContain("`removed: 0, stillLinkedViaKeyResult: true` is a successful no-op")
  })

  it("renders heading ids that match the anchors search_help and other pages use", async () => {
    const page = await getDoc("09-mcp-api")
    for (const id of ["typed-links", "link_opportunity_to_objective", "list_links", "the-workspaces-thinking-model"]) {
      expect(page!.html, id).toContain(`id="${id}"`)
    }
    for (const slug of ["00-overview", "01-okrs", "02-discovery", "27-thinking-models"]) {
      expect(getDocRaw(slug)!.content, slug).toContain("/help/09-mcp-api#typed-links")
    }
  })

  it("finds the thinking-model help from a natural-language question", () => {
    const results = searchHelp("what is a thinking model Torres outcome", 5)
    expect(results.map((r) => r.slug)).toContain("27-thinking-models")
  })

  it("returns the thinkingModel field documentation through the search_help and get_help tools", async () => {
    const search = await searchHelpTool({ query: "thinkingModel get_workspace_summary labels" })
    expect(search.structuredContent.ok).toBe(true)
    expect(search.content[0].text).toContain("Path: /help/09-mcp-api#the-workspaces-thinking-model")

    const help = await getHelp({ topic: "09-mcp-api" })
    expect(help.content[0].text).toContain("### The workspace's thinking model")
  })

  it("no longer claims that a Solution can be re-parented from its panel", () => {
    const discovery = getDocRaw("02-discovery")!.content
    expect(discovery).not.toMatch(/Re-parenting a Solution to a different Opportunity is a deliberate action/)
    expect(discovery).toContain("there is no action")
  })
})
