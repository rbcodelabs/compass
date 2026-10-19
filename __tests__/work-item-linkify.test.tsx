// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MarkdownContent } from "@/components/markdown-content"
import { WorkItemLinkScopeProvider } from "@/components/work-item-link-scope"
import { splitWorkItemRefs } from "@/lib/work-item-linkify"

const slugs = { orgSlug: "acme", workspaceSlug: "product" }
const urls = (value: string) => (splitWorkItemRefs(value, slugs) ?? []).filter((part) => part.type === "link").map((part) => (part as { url: string }).url)

describe("splitWorkItemRefs", () => {
  it("links registered, upper-case IDs to the page that resolves them", () => {
    expect(urls("see TASK-12 and OPP-3, then KR-1.")).toEqual([
      "/acme/product/tasks/TASK-12",
      "/acme/product/discovery/OPP-3",
      "/acme/product/okrs?detail=keyResult%3AKR-1",
    ])
  })

  it("keeps the surrounding text exactly, including punctuation", () => {
    const parts = splitWorkItemRefs("(TASK-5)", slugs)!
    expect(parts.map((part) => (part.type === "text" ? part.value : `[${part.children[0].value}]`)).join("")).toBe("([TASK-5])")
  })

  it("leaves alone what is not a work item reference", () => {
    for (const text of ["task-12 in lower case", "ABC-123 from another tracker", "ABC-TASK-5", "see /docs/DOC-5 path", "TASK-5-beta", "user@TASK-5", "TASK-0", "v2-TASK-9x", "STUDY-2 has no page here", "DEC-4"]) {
      expect(splitWorkItemRefs(text, slugs), text).toBeNull()
    }
  })
})

describe("MarkdownContent", () => {
  afterEach(cleanup)

  it("links IDs inside a workspace, but not in code, existing links or outside a workspace", () => {
    render(
      <WorkItemLinkScopeProvider {...slugs}>
        <MarkdownContent>{"Blocked by TASK-7. `TASK-8` and [TASK-9](https://example.com) stay as written."}</MarkdownContent>
      </WorkItemLinkScopeProvider>,
    )
    expect(screen.getByRole("link", { name: "TASK-7" }).getAttribute("href")).toBe("/acme/product/tasks/TASK-7")
    expect(screen.getByRole("link", { name: "TASK-9" }).getAttribute("href")).toBe("https://example.com")
    expect(screen.queryByRole("link", { name: "TASK-8" })).toBeNull()
    expect(screen.getAllByRole("link")).toHaveLength(2)
  })

  it("renders plain text with no provider (portal, marketing)", () => {
    render(<MarkdownContent>{"Blocked by TASK-7"}</MarkdownContent>)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText(/Blocked by TASK-7/)).toBeTruthy()
  })
})
