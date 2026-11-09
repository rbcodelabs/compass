import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "./helpers/work-item-create-scan"

/**
 * GUARD (ADR: Custom field inheritance rules). A roadmap item gets its opportunity or solution from many
 * writers and there is no single choke point, so this test scans the source tree and fails when:
 *
 *  - any roadmapItem create / createMany / upsert appears in a file that is not in CREATE_SITES, or in a
 *    listed file with more sites than declared;
 *  - any roadmapItem update / updateMany appears the same way (UPDATE_SITES), or one that literally sets
 *    opportunityId / solutionId is not declared as a link update;
 *  - a file declares hooked sites but does not call applyInheritanceRules often enough;
 *  - any customFieldValue write (upsert / create / createMany) appears outside VALUE_WRITE_SITES, which
 *    keeps the late-source-value hook reachable from every value write path.
 *
 * To add a writer: hook it (applyInheritanceRules / applyInheritanceForSourceValue) and declare it here,
 * or declare it with a reason it cannot introduce a link. There is no silent third option.
 */
const ROOT = process.cwd()
const SCAN_DIRS = ["app", "lib"]
const HOOK = "applyInheritanceRules("
const VALUE_HOOK = "applyInheritanceForSourceValue("

type CreateEntry = { creates: number; hooked: number; justified?: { reason: string }[] }
type UpdateEntry = { updates: number; linkUpdates: number; reason: string }

const CREATE_SITES: Record<string, CreateEntry> = {
  "app/[orgSlug]/[workspaceSlug]/roadmap/actions.ts": {
    creates: 3, hooked: 2, // addRoadmapItem, promoteSolutionToRoadmap
    justified: [{ reason: "promoteFeedbackToRoadmap links a feedback item only; no opportunityId/solutionId to inherit from" }],
  },
  "lib/roadmap-tool-handlers.ts": { creates: 1, hooked: 1 }, // add_to_roadmap (no-solution branch)
  "lib/roadmap/create-from-solution.ts": { creates: 1, hooked: 1 }, // promote_to_roadmap, bulk promote, add_to_roadmap with a solution
  "lib/feedback-tool-handlers.ts": { creates: 1, hooked: 0, justified: [{ reason: "promote_feedback_to_roadmap links a feedback item only; no opportunityId/solutionId to inherit from" }] },
  "lib/card-sort-new-entries.ts": { creates: 1, hooked: 0, justified: [{ reason: "an accepted card-sort entry becomes an unlinked LATER item; no opportunityId/solutionId" }] },
}

const UPDATE_SITES: Record<string, UpdateEntry> = {
  "app/[orgSlug]/[workspaceSlug]/roadmap/actions.ts": { updates: 8, linkUpdates: 1, reason: "editRoadmapItem (card save) changes opportunityId and is hooked; the rest move, order, archive, rename or squad-assign without changing a link" },
  "lib/roadmap-tool-handlers.ts": { updates: 1, linkUpdates: 1, reason: "update_roadmap_item can set opportunityId/solutionId and is hooked" },
  "app/[orgSlug]/[workspaceSlug]/settings/actions.ts": { updates: 2, linkUpdates: 0, reason: "squad assignment / unassignment only" },
  "app/api/mcp/route.ts": { updates: 1, linkUpdates: 0, reason: "assign_squad only: sets squadId and nothing about opportunity or solution links" },
  "lib/launch-checklist.ts": { updates: 1, linkUpdates: 0, reason: "horizon change to LAUNCHING" },
  "lib/okr-tool-handlers.ts": { updates: 1, linkUpdates: 0, reason: "clears keyResultId when a key result is deleted; never sets an opportunity or solution" },
  "lib/roadmap/solution-sync.ts": { updates: 1, linkUpdates: 0, reason: "mirrors solution title/status/dates onto the item; not a link event (ADR)" },
  "lib/links/endpoints.ts": { updates: 1, linkUpdates: 0, reason: "touches updatedAt after a typed-link change; not a link event (ADR)" },
  "lib/analytics/service.ts": { updates: 1, linkUpdates: 0, reason: "writes analytics tracking fields" },
}

/**
 * Writers that pick the Prisma delegate by a runtime model name (`tx[config.model].update(...)`). The literal
 * `roadmapItem.update(` scan above cannot see them, which is how the roadmap detail panel's opportunity link slipped past once.
 */
const GENERIC_DELEGATE_WRITERS: Record<string, { hooked: boolean; reason: string }> = {
  "lib/entity-mutations.ts": { hooked: true, reason: "updateEntityField: the roadmap detail panel links an opportunity through it (ROADMAP_ITEM_FIELDS includes opportunityId)" },
  "lib/entity-detail.ts": { hooked: false, reason: "read-only: findMany by model name for panel lookups, never writes" },
  "lib/task-tool-handlers.ts": { hooked: false, reason: "task rows only (modelName is a task-link target lookup); never writes a roadmap item" },
  "lib/workspace-update-mutations.ts": { hooked: false, reason: "reads the row a mutation just wrote for update capture; the writes stay in the callers the other scans cover" },
}

const VALUE_WRITE_SITES: Record<string, { writes: number; hooked: boolean; reason?: string }> = {
  "lib/custom-field-value-write.ts": { writes: 1, hooked: true },
  "lib/custom-field-inheritance.ts": { writes: 1, hooked: false, reason: "the inserter itself: insert-only fill of ROADMAP_ITEM targets" },
  "app/[orgSlug]/[workspaceSlug]/roadmap/actions.ts": { writes: 1, hooked: false, reason: "swimlane assignment writes a ROADMAP_ITEM field, which is only ever a rule target, never a source (OPPORTUNITY/SOLUTION)" },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !full.includes(`${path.sep}__tests__${path.sep}`)) out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).map((full) => ({
  rel: path.relative(ROOT, full).split(path.sep).join("/"),
  text: stripComments(readFileSync(full, "utf-8")),
}))

/** Argument text of the call whose "(" is at `open`, via paren balancing. */
function argumentText(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

function sites(text: string, operations: string[]) {
  const pattern = new RegExp(`\\broadmapItem\\.(${operations.join("|")})\\(`, "g")
  return [...text.matchAll(pattern)].map((match) => ({
    op: match[1],
    args: argumentText(text, match.index! + match[0].length - 1),
  }))
}

const count = (text: string, needle: string) => text.split(needle).length - 1

describe("roadmap item creation paths", () => {
  const found = files.map((file) => ({ ...file, creates: sites(file.text, ["create", "createMany", "upsert"]) })).filter((file) => file.creates.length > 0)

  it("finds no roadmapItem creation outside the declared files", () => {
    const unlisted = found.filter((file) => !CREATE_SITES[file.rel]).map((file) => file.rel)
    expect(unlisted, `Un-hooked roadmapItem create path(s): ${unlisted.join(", ")}. Hook them with applyInheritanceRules or justify them in CREATE_SITES.`).toEqual([])
  })

  it("matches the declared number of creation sites in each file", () => {
    for (const [rel, entry] of Object.entries(CREATE_SITES)) {
      const actual = found.find((file) => file.rel === rel)?.creates.length ?? 0
      expect(actual, `${rel}: roadmapItem create sites`).toBe(entry.creates)
      expect(entry.hooked + (entry.justified?.length ?? 0), `${rel}: every site is hooked or justified`).toBe(entry.creates)
      for (const justified of entry.justified ?? []) expect(justified.reason.length).toBeGreaterThan(20)
    }
  })

  it("calls applyInheritanceRules in every file that declares hooked creation sites", () => {
    for (const [rel, entry] of Object.entries(CREATE_SITES)) {
      const linkUpdates = UPDATE_SITES[rel]?.linkUpdates ?? 0
      const text = files.find((file) => file.rel === rel)?.text ?? ""
      expect(count(text, HOOK), `${rel}: applyInheritanceRules( calls`).toBeGreaterThanOrEqual(entry.hooked + linkUpdates)
    }
  })

  it("keeps the REST executor free of direct roadmap writes (it delegates to the hooked MCP handlers)", () => {
    const execute = files.find((file) => file.rel === "lib/rest/execute.ts")!
    expect(sites(execute.text, ["create", "createMany", "upsert", "update", "updateMany"])).toEqual([])
    expect(execute.text).toContain("createRoadmapItem")
    expect(execute.text).toContain("updateRoadmapItem")
  })
})

describe("roadmap item link-changing updates", () => {
  const found = files.map((file) => ({ ...file, updates: sites(file.text, ["update", "updateMany"]) })).filter((file) => file.updates.length > 0)

  it("finds no roadmapItem update outside the declared files", () => {
    const unlisted = found.filter((file) => !UPDATE_SITES[file.rel]).map((file) => file.rel)
    expect(unlisted, `Un-classified roadmapItem update path(s): ${unlisted.join(", ")}. Hook link changes with applyInheritanceRules or justify them in UPDATE_SITES.`).toEqual([])
  })

  it("matches the declared number of update sites, and every literal opportunityId/solutionId write is a declared link update", () => {
    for (const [rel, entry] of Object.entries(UPDATE_SITES)) {
      const file = found.find((candidate) => candidate.rel === rel)
      expect(file?.updates.length ?? 0, `${rel}: roadmapItem update sites`).toBe(entry.updates)
      const literal = (file?.updates ?? []).filter((site) => /\b(opportunityId|solutionId)\b/.test(site.args)).length
      expect(literal, `${rel}: update sites that literally set opportunityId/solutionId`).toBeLessThanOrEqual(entry.linkUpdates)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  it("hooks every declared link update", () => {
    for (const [rel, entry] of Object.entries(UPDATE_SITES)) {
      if (entry.linkUpdates === 0) continue
      const text = files.find((file) => file.rel === rel)?.text ?? ""
      expect(count(text, HOOK), `${rel}: applyInheritanceRules( calls`).toBeGreaterThanOrEqual(entry.linkUpdates)
    }
  })
})

describe("generic-delegate writers (dynamic model name)", () => {
  const GENERIC = /\)\[\s*(?:config\.model|modelName)\b|\btx\[\s*(?:config\.model|model)\b/
  const found = files.filter((file) => GENERIC.test(file.text)).map((file) => file.rel)

  it("finds no dynamic-model writer outside the declared files", () => {
    const unlisted = found.filter((rel) => !GENERIC_DELEGATE_WRITERS[rel])
    expect(unlisted, `Un-classified generic-delegate writer(s): ${unlisted.join(", ")}. If it can write a roadmap item's opportunityId/solutionId it must call applyInheritanceRules; otherwise justify it in GENERIC_DELEGATE_WRITERS.`).toEqual([])
    for (const [rel, entry] of Object.entries(GENERIC_DELEGATE_WRITERS)) {
      expect(found, `${rel} no longer matches; remove the stale entry`).toContain(rel)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  it("hooks the generic path that sets a roadmap item's opportunity link", () => {
    const mutations = files.find((file) => file.rel === "lib/entity-mutations.ts")!
    expect(mutations.text).toMatch(/ROADMAP_ITEM_FIELDS = \[[^\]]*"opportunityId"/)
    expect(count(mutations.text, HOOK), "lib/entity-mutations.ts: applyInheritanceRules( calls").toBeGreaterThanOrEqual(1)
    expect(mutations.text).toMatch(/type === "roadmapItem" && field === "opportunityId"[^]*applyInheritanceRules\(/)
    for (const [rel, entry] of Object.entries(GENERIC_DELEGATE_WRITERS)) {
      if (entry.hooked) expect(count(files.find((file) => file.rel === rel)!.text, HOOK), rel).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("custom field value write paths (late source values)", () => {
  const found = files
    .map((file) => ({ ...file, writes: [...file.text.matchAll(/\bcustomFieldValue\.(upsert|create|createMany|createManyAndReturn)\(/g)].length }))
    .filter((file) => file.writes > 0)

  it("allows customFieldValue writes only in the declared files", () => {
    const unlisted = found.filter((file) => !VALUE_WRITE_SITES[file.rel]).map((file) => file.rel)
    expect(unlisted, `Custom field value write(s) outside the funnel: ${unlisted.join(", ")}. Route them through writeCustomFieldValue.`).toEqual([])
    for (const [rel, entry] of Object.entries(VALUE_WRITE_SITES)) {
      expect(found.find((file) => file.rel === rel)?.writes ?? 0, `${rel}: customFieldValue write sites`).toBe(entry.writes)
      if (!entry.hooked) expect((entry.reason ?? "").length).toBeGreaterThan(20)
    }
  })

  it("has the funnel call applyInheritanceForSourceValue, and the funnel is used by every value action", () => {
    const funnel = files.find((file) => file.rel === "lib/custom-field-value-write.ts")!
    expect(count(funnel.text, VALUE_HOOK)).toBeGreaterThanOrEqual(1)
    for (const rel of [
      "app/[orgSlug]/[workspaceSlug]/settings/actions.ts",
      "app/[orgSlug]/[workspaceSlug]/discovery/actions.ts",
      "lib/custom-field-tool-handlers.ts",
      "lib/custom-field-bulk.ts",
    ]) {
      expect(files.find((file) => file.rel === rel)!.text, `${rel} writes values through the funnel`).toContain("writeCustomFieldValue(")
    }
  })
})
