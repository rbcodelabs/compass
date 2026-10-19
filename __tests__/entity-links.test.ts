/**
 * Unit tests for lib/entity-links.ts — the single source of truth for the
 * relative path that addresses one entity inside a workspace.
 *
 * Both the in-app search (lib/workspace-search.ts) and the MCP tools
 * (lib/compass-url.ts -> entityUrl) build their links from this module, so a
 * drift between "what the UI links to" and "what an agent hands a human" is a
 * test failure here rather than a silently broken link in production.
 */
import { describe, expect, it } from "vitest"

import { entityPath, parseEntityLink, workspaceBasePath } from "@/lib/entity-links"

const slugs = { orgSlug: "rbcodelabs", workspaceSlug: "compass" }

describe("workspaceBasePath", () => {
  it("builds the workspace root and encodes both slugs", () => {
    expect(workspaceBasePath({ orgSlug: "Acme Org", workspaceSlug: "PM/Tools" })).toBe("/Acme%20Org/PM%2FTools")
  })
})

describe("entityPath — entities with their own page", () => {
  it("links an opportunity to its own discovery page", () => {
    expect(entityPath({ ...slugs, type: "opportunity", id: "opp-1" })).toBe("/rbcodelabs/compass/discovery/opp-1")
  })

  it("links an experiment to its own page", () => {
    expect(entityPath({ ...slugs, type: "experiment", id: "exp-1" })).toBe("/rbcodelabs/compass/experiments/exp-1")
  })

  it("links a task to its own page", () => {
    expect(entityPath({ ...slugs, type: "task", id: "task-1" })).toBe("/rbcodelabs/compass/tasks/task-1")
  })

  it("links an artifact to its own page under docs/artifacts", () => {
    expect(entityPath({ ...slugs, type: "artifact", id: "art-1" })).toBe("/rbcodelabs/compass/docs/artifacts/art-1")
  })

  it("links a doc to its own page", () => {
    expect(entityPath({ ...slugs, type: "doc", id: "doc-1" })).toBe("/rbcodelabs/compass/docs/doc-1")
  })
})

describe("entityPath — entities addressed by the ?detail= panel", () => {
  it("opens a solution on its owning opportunity page", () => {
    expect(entityPath({ ...slugs, type: "solution", id: "sol-1", opportunityId: "opp-1" }))
      .toBe("/rbcodelabs/compass/discovery/opp-1?detail=solution%3Asol-1")
  })

  it("falls back to the workspace root when a solution's opportunity is unknown", () => {
    // The panel provider mounts in the workspace layout, so ?detail= resolves
    // on any page under the workspace — the owning page is a nicety, not a
    // requirement.
    expect(entityPath({ ...slugs, type: "solution", id: "sol-1" }))
      .toBe("/rbcodelabs/compass?detail=solution%3Asol-1")
  })

  it("opens an assumption on its owning opportunity page when known", () => {
    expect(entityPath({ ...slugs, type: "assumption", id: "asm-1", opportunityId: "opp-1" }))
      .toBe("/rbcodelabs/compass/discovery/opp-1?detail=assumption%3Aasm-1")
  })

  it("falls back to the workspace root for an assumption with no known opportunity", () => {
    expect(entityPath({ ...slugs, type: "assumption", id: "asm-1" }))
      .toBe("/rbcodelabs/compass?detail=assumption%3Aasm-1")
  })

  it("opens a roadmap item on the roadmap", () => {
    expect(entityPath({ ...slugs, type: "roadmapItem", id: "item-1" }))
      .toBe("/rbcodelabs/compass/roadmap?detail=roadmapItem%3Aitem-1")
  })

  it("opens feedback on the feedback page", () => {
    expect(entityPath({ ...slugs, type: "feedback", id: "fb-1" }))
      .toBe("/rbcodelabs/compass/feedback?detail=feedback%3Afb-1")
  })

  it("opens an objective on the OKRs page", () => {
    expect(entityPath({ ...slugs, type: "objective", id: "obj-1" }))
      .toBe("/rbcodelabs/compass/okrs?detail=objective%3Aobj-1")
  })

  it("opens a key result on the OKRs page", () => {
    expect(entityPath({ ...slugs, type: "keyResult", id: "kr-1" }))
      .toBe("/rbcodelabs/compass/okrs?detail=keyResult%3Akr-1")
  })
})

describe("entityPath — encoding", () => {
  it("percent-encodes org and workspace slugs in every shape", () => {
    expect(entityPath({ orgSlug: "Acme Org", workspaceSlug: "PM/Tools", type: "task", id: "task 1" }))
      .toBe("/Acme%20Org/PM%2FTools/tasks/task%201")
    expect(entityPath({ orgSlug: "Acme Org", workspaceSlug: "PM/Tools", type: "feedback", id: "item:1" }))
      .toBe("/Acme%20Org/PM%2FTools/feedback?detail=feedback%3Aitem%3A1")
  })

  it("percent-encodes the opportunity segment of a nested panel link", () => {
    expect(entityPath({ ...slugs, type: "solution", id: "sol/1", opportunityId: "opp 1" }))
      .toBe("/rbcodelabs/compass/discovery/opp%201?detail=solution%3Asol%2F1")
  })
})

describe("parseEntityLink — the inverse of entityPath", () => {
  const ID = "0b9a7f6e-3c1d-4e2a-8f5b-6d7c8e9fa0b1"
  const ID2 = "1c0b8a7f-4d2e-4f3b-9a6c-7e8d9fa0b1c2"
  const back = (input: Parameters<typeof entityPath>[0]) => parseEntityLink(entityPath(input))

  it("round-trips every type entityPath can emit", () => {
    const types = ["objective", "keyResult", "opportunity", "solution", "assumption", "experiment", "roadmapItem", "feedback", "task", "doc", "artifact"] as const
    for (const type of types) {
      expect(back({ ...slugs, type, id: ID })).toEqual({ ...slugs, type, id: ID })
    }
  })

  it("prefers the ?detail= entity over the discovery page it rides on", () => {
    expect(back({ ...slugs, type: "solution", id: ID, opportunityId: ID2 })).toEqual({ ...slugs, type: "solution", id: ID })
  })

  it("accepts an absolute URL only on the current origin", () => {
    const url = `https://compass.example.com${entityPath({ ...slugs, type: "task", id: ID })}`
    expect(parseEntityLink(url, "https://compass.example.com")).toMatchObject({ type: "task", id: ID })
    expect(parseEntityLink(url, "https://other.example.com")).toBeNull()
    expect(parseEntityLink(url)).toBeNull()
  })

  it("ignores page links, non-uuid ids, extra segments and protocol-relative hrefs", () => {
    expect(parseEntityLink("/rbcodelabs/compass/discovery/tree")).toBeNull()
    expect(parseEntityLink("/rbcodelabs/compass/discovery")).toBeNull()
    expect(parseEntityLink(`/rbcodelabs/compass/tasks/${ID}/edit`)).toBeNull()
    expect(parseEntityLink("/rbcodelabs/compass/docs/artifacts")).toBeNull()
    expect(parseEntityLink(`/rbcodelabs/compass/okrs?detail=bogus:${ID}`)).toBeNull()
    expect(parseEntityLink(`//evil.example.com/rbcodelabs/compass/tasks/${ID}`)).toBeNull()
    expect(parseEntityLink("mailto:a@b.co")).toBeNull()
    expect(parseEntityLink("#section")).toBeNull()
  })

  it("never throws on malformed escapes", () => {
    expect(parseEntityLink("/%E0%A4%A/compass/tasks/x")).toBeNull()
  })
})

describe("display IDs in links", () => {
  const slugs = { orgSlug: "acme", workspaceSlug: "product" }
  it("builds readable paths and panel params from a display ID, and falls back to the UUID", () => {
    const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    expect(entityPath({ ...slugs, type: "task", id, displayId: "TASK-5" })).toBe("/acme/product/tasks/TASK-5")
    expect(entityPath({ ...slugs, type: "opportunity", id, displayId: "OPP-12" })).toBe("/acme/product/discovery/OPP-12")
    expect(entityPath({ ...slugs, type: "roadmapItem", id, displayId: "RM-7" })).toBe("/acme/product/roadmap?detail=roadmapItem%3ARM-7")
    expect(entityPath({ ...slugs, type: "task", id, displayId: null })).toBe(`/acme/product/tasks/${id}`)
  })

  it("parses display IDs from page paths and ?detail= params, round-tripping what it builds", () => {
    expect(parseEntityLink("/acme/product/tasks/TASK-5")).toEqual({ ...slugs, type: "task", id: "TASK-5" })
    expect(parseEntityLink("/acme/product/okrs?detail=keyResult%3AKR-3")).toEqual({ ...slugs, type: "keyResult", id: "KR-3" })
    for (const type of ["opportunity", "experiment", "task", "doc", "roadmapItem", "solution", "feedback"] as const) {
      const path = entityPath({ ...slugs, type, id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", displayId: "XYZ-1".replace("XYZ", { opportunity: "OPP", experiment: "EXP", task: "TASK", doc: "DOC", roadmapItem: "RM", solution: "SOL", feedback: "FB" }[type]) })
      expect(parseEntityLink(path)).toMatchObject({ type, id: expect.stringMatching(/^[A-Z]+-1$/) })
    }
  })

  it("still rejects page names and junk as entities", () => {
    expect(parseEntityLink("/acme/product/discovery/tree")).toBeNull()
    expect(parseEntityLink("/acme/product/discovery/card-sort")).toBeNull()
    expect(parseEntityLink("/acme/product/tasks/TASK-0")).toBeNull()
    expect(parseEntityLink("/acme/product/tasks/NOPE-5")).toBeNull()
  })
})
