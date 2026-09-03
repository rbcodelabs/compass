import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const sources = [
  "app/[orgSlug]/[workspaceSlug]/roadmap/actions.ts",
  "app/api/mcp/route.ts",
  "lib/entity-mutations.ts",
  "lib/feedback-tool-handlers.ts",
].map((path) => ({ path, text: readFileSync(resolve(process.cwd(), path), "utf8") }))

const ingressKeys = [
  "ui.roadmap.add",
  "ui.roadmap.move",
  "ui.solution.promote",
  "ui.feedback.promote",
  "api.entity.update",
  "mcp.solution.promote",
  "mcp.roadmap.update",
  "mcp.roadmap.add",
  "mcp.feedback.promote",
] as const

describe("NOW gate ingress coverage", () => {
  it("keeps all nine state-changing NOW ingress paths explicitly instrumented once", () => {
    const combined = sources.map(({ text }) => text).join("\n")
    for (const ingressKey of ingressKeys) {
      expect(combined.match(new RegExp(`ingressKey: ["']${ingressKey.replaceAll(".", "\\.")}["']`, "g")) ?? [], ingressKey)
        .toHaveLength(1)
    }
    expect(combined.match(/ingressKey:\s*["'][^"']+["']/g) ?? []).toHaveLength(ingressKeys.length)
  })

  it("does not let ordinary ingress write NATIVE_GATED provenance", () => {
    for (const source of sources) {
      expect(source.text, source.path).not.toContain('nowCommitmentProvenance: "NATIVE_GATED"')
    }
  })

  it("preflights all six create ingresses from a non-NOW provisional row", () => {
    const combined = sources.map(({ text }) => text).join("\n")
    expect(combined.match(/roadmapItem\.create\(\{[\s\S]{0,500}?horizon:\s*initialHorizonForNowCreate\(/g) ?? [])
      .toHaveLength(6)
    expect(combined.match(/await finalizeCreatedNowIngress\(/g) ?? [])
      .toHaveLength(6)
  })

  it("evaluates existing-item transitions before their horizon mutation", () => {
    const roadmap = sources.find(({ path }) => path.endsWith("roadmap/actions.ts"))!.text
    expect(roadmap.indexOf('ingressKey: "ui.roadmap.move"'))
      .toBeLessThan(roadmap.indexOf("updateRoadmapItemWithCapacityRelease(itemId, { horizon, sortOrder })"))

    const mcp = sources.find(({ path }) => path === "app/api/mcp/route.ts")!.text
    expect(mcp.indexOf('ingressKey: "mcp.roadmap.update"'))
      .toBeLessThan(mcp.indexOf("const updated = await updateRoadmapItemWithCapacityRelease(itemId"))

    const entity = sources.find(({ path }) => path === "lib/entity-mutations.ts")!.text
    expect(entity.indexOf('ingressKey: "api.entity.update"'))
      .toBeLessThan(entity.indexOf("await model.update({"))
  })
})
