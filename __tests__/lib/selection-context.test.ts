// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"

import {
  humanizeFieldKey,
  oneLine,
  resolveSelectionContext,
  selectionChipLabel,
  selectionSourceLine,
} from "@/lib/selection-context"

const OPP = "11111111-1111-4111-8111-111111111111"
const TASK = "22222222-2222-4222-8222-222222222222"
const SOL = "33333333-3333-4333-8333-333333333333"
const at = (pathname: string, search = "") => ({ pathname, search })
const WS = "/acme/product"

function mount(html: string) {
  document.body.innerHTML = html
  return document.getElementById("target")!.firstChild ?? document.getElementById("target")!
}

afterEach(() => { document.body.innerHTML = "" })

describe("resolveSelectionContext (annotated)", () => {
  it("resolves nearest field then entity, with the title from an outer container", () => {
    const node = mount(`
      <div data-ctx-entity-type="opportunity" data-ctx-entity-id="${OPP}" data-ctx-entity-title="Fix onboarding">
        <span data-ctx-entity-type="opportunity" data-ctx-entity-id="${OPP}" data-ctx-field="Description">
          <p id="target">Some description text</p>
        </span>
      </div>`)
    expect(resolveSelectionContext(node, at(`${WS}/feedback`))).toEqual({
      entityType: "opportunity",
      entityId: OPP,
      entityTitle: "Fix onboarding",
      field: "Description",
      url: `${WS}/discovery/${OPP}`,
    })
  })

  it("uses the nearest entity when entities nest", () => {
    const node = mount(`
      <div data-ctx-entity-type="opportunity" data-ctx-entity-id="${OPP}" data-ctx-entity-title="Outer">
        <div data-ctx-entity-type="task" data-ctx-entity-id="${TASK}" data-ctx-entity-title="Inner task">
          <p id="target">text</p>
        </div>
      </div>`)
    const ctx = resolveSelectionContext(node, at(WS))
    expect(ctx).toMatchObject({ entityType: "task", entityId: TASK, entityTitle: "Inner task", url: `${WS}/tasks/${TASK}` })
    expect(ctx?.field).toBeUndefined()
  })

  it("links panel-only entities through ?detail=", () => {
    const node = mount(`<div data-ctx-entity-type="solution" data-ctx-entity-id="${SOL}"><p id="target">x</p></div>`)
    expect(resolveSelectionContext(node, at(WS))?.url).toBe(`${WS}?detail=${encodeURIComponent(`solution:${SOL}`)}`)
  })

  it("ignores annotations with an unknown type or a malformed id", () => {
    const bad = mount(`<div data-ctx-entity-type="widget" data-ctx-entity-id="${OPP}"><p id="target">x</p></div>`)
    expect(resolveSelectionContext(bad, at(WS, ""))).toBeNull()
    const badId = mount(`<div data-ctx-entity-type="task" data-ctx-entity-id="not-a-uuid"><p id="target">x</p></div>`)
    expect(resolveSelectionContext(badId, at(WS, ""))).toBeNull()
  })

  it("bounds and flattens the title and field label", () => {
    const long = "x".repeat(500)
    const node = mount(`<div data-ctx-entity-type="task" data-ctx-entity-id="${TASK}" data-ctx-entity-title="Line one
      line two ${long}" data-ctx-field="${long}"><p id="target">x</p></div>`)
    const ctx = resolveSelectionContext(node, at(WS))!
    expect(ctx.entityTitle).not.toMatch(/\n/)
    expect(ctx.entityTitle!.length).toBeLessThanOrEqual(120)
    expect(ctx.field!.length).toBeLessThanOrEqual(60)
  })
})

describe("resolveSelectionContext (URL fallback)", () => {
  it("uses the ?detail= entity for a selection inside a detail panel, with no field", () => {
    const node = mount(`<div data-slot="sheet-content"><p id="target">x</p></div>`)
    expect(resolveSelectionContext(node, at(`${WS}/discovery`, `?detail=${encodeURIComponent(`solution:${SOL}`)}`))).toEqual({
      entityType: "solution",
      entityId: SOL,
      url: `${WS}?detail=${encodeURIComponent(`solution:${SOL}`)}`,
    })
  })

  it("also works inside the pinned panel", () => {
    const node = mount(`<aside data-slot="pinned-panel"><p id="target">x</p></aside>`)
    expect(resolveSelectionContext(node, at(WS, `?detail=task:${TASK}`))?.entityType).toBe("task")
  })

  it("does not give a selection in the page behind a panel the panel's entity", () => {
    const node = mount(`<main><p id="target">x</p></main>`)
    expect(resolveSelectionContext(node, at(`${WS}/discovery`, `?detail=task:${TASK}`))).toBeNull()
  })

  it("uses the route entity on an entity's own page", () => {
    const node = mount(`<main><p id="target">x</p></main>`)
    expect(resolveSelectionContext(node, at(`${WS}/discovery/${OPP}`))).toMatchObject({ entityType: "opportunity", entityId: OPP })
  })

  it("keeps an annotated field when only the entity comes from the URL", () => {
    const node = mount(`<aside data-slot="pinned-panel"><div data-ctx-field="Notes"><p id="target">x</p></div></aside>`)
    expect(resolveSelectionContext(node, at(WS, `?detail=task:${TASK}`))).toMatchObject({ entityType: "task", field: "Notes" })
  })

  it("returns null when nothing resolves", () => {
    const node = mount(`<main><p id="target">x</p></main>`)
    expect(resolveSelectionContext(node, at(`${WS}/discovery`))).toBeNull()
    expect(resolveSelectionContext(null, at(WS))).toBeNull()
  })
})

describe("formatting", () => {
  const ctx = { entityType: "opportunity" as const, entityId: OPP, entityTitle: 'Fix "quoted" onboarding', field: "Description", url: "/x" }

  it("writes a stable source line in the page-context vocabulary", () => {
    expect(selectionSourceLine(ctx)).toBe(`Selected from: Opportunity "Fix 'quoted' onboarding" (id ${OPP}) — field: Description`)
  })
  it("omits title and field when absent", () => {
    expect(selectionSourceLine({ entityType: "task", entityId: TASK, url: "/x" })).toBe(`Selected from: Task (id ${TASK})`)
  })
  it("honours workspace label overrides", () => {
    expect(selectionSourceLine(ctx, { opportunity: "Problem" })).toContain("Selected from: Problem ")
    expect(selectionChipLabel(ctx, { opportunity: "Problem" })).toBe("Problem · Description")
  })
  it("humanizes field keys", () => {
    expect(humanizeFieldKey("description")).toBe("Description")
    expect(humanizeFieldKey("ownerName")).toBe("Owner name")
    expect(humanizeFieldKey("story_points")).toBe("Story points")
    expect(oneLine("  a \n b ", 10)).toBe("a b")
    expect(oneLine("", 10)).toBeUndefined()
  })
})
