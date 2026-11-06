import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MODEL_BUCKETS } from "@/lib/workspace-export/model-registry"
import { PARENT, dmmfModels, exportOrder, modelHasWorkspaceId } from "@/lib/workspace-export/scope"
import { OPTIONAL_STRING_FIELDS } from "@/lib/workspace-export/schema-meta.generated"
import { OUTPUT_PATH, SCHEMA_PATH, parseOptionalStringFields, render } from "../scripts/gen-workspace-export-meta.ts"

describe("workspace export scope", () => {
  it("every exported model is reachable: it has workspaceId, a declared parent, or is a special case", () => {
    for (const model of exportOrder()) {
      const ok = model === "Agent" || modelHasWorkspaceId(model) || PARENT[model]
      expect(ok, `${model} has no workspace scope`).toBeTruthy()
    }
  })

  it("parent declarations point at exported models and real columns", () => {
    for (const [model, p] of Object.entries(PARENT)) {
      expect(MODEL_BUCKETS[p.model], `${model} parent ${p.model}`).toBe("CONTENT")
      expect(dmmfModels.get(model)?.fields.some((f) => f.name === p.fk), `${model}.${p.fk}`).toBe(true)
    }
  })

  it("parents come before children in the export order", () => {
    const order = exportOrder()
    for (const [model, p] of Object.entries(PARENT)) {
      if (!order.includes(model) || !order.includes(p.model)) continue
      expect(order.indexOf(p.model), `${p.model} before ${model}`).toBeLessThan(order.indexOf(model))
    }
  })

  it("generated schema metadata is current (run: node scripts/gen-workspace-export-meta.ts)", () => {
    const expected = render(parseOptionalStringFields(readFileSync(SCHEMA_PATH, "utf8")))
    expect(readFileSync(OUTPUT_PATH, "utf8")).toBe(expected)
    expect(Object.keys(OPTIONAL_STRING_FIELDS).length).toBeGreaterThan(20)
  })
})
