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

import { entityPath, workspaceBasePath } from "@/lib/entity-links"

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
