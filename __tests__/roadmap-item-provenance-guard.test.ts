import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Deploy-ordering guard for 075_roadmap_item_provenance (migration-only PR).
 * Prisma selects every declared column, so declaring auto_created / schedule_edited_at in
 * schema.prisma before the migration is applied would break every roadmap_items read. This PR
 * therefore leaves the RoadmapItem model untouched; the follow-up code PR declares the columns
 * and deletes this guard.
 */
describe("075_roadmap_item_provenance deploy ordering", () => {
  it("does NOT yet declare the columns in schema.prisma", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf-8")
    const model = schema.match(/model RoadmapItem \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/model RoadmapItem/)
    expect(model).not.toMatch(/autoCreated|auto_created|scheduleEditedAt|schedule_edited_at/)
  })
})
