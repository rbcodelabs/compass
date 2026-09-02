import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const route = readFileSync(path.join(root, "app/api/admin/migrate/route.ts"), "utf8")

function migration(name: string) {
  return readFileSync(path.join(root, "prisma/migrations", name, "migration.sql"), "utf8")
}

describe("decision-gate expand precursor migrations", () => {
  it.each([
    "039_native_decision_gates",
    "040_release_authorization",
    "041_portfolio_capacity_ledger",
  ])("registers %s in the authenticated migration manifest", (name) => {
    expect(route).toContain(`name: "${name}"`)
    expect(migration(name)).toMatch(/CREATE (?:TABLE|INDEX)|ALTER TABLE/)
  })

  it("keeps every index asynchronous and every DDL transaction isolated", () => {
    for (const name of [
      "039_native_decision_gates",
      "040_release_authorization",
      "041_portfolio_capacity_ledger",
    ]) {
      const sql = migration(name)
      expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!ASYNC\b)/i)
      const ddlStatements = sql.match(/(?:CREATE|ALTER)\s+(?:TABLE|INDEX)[\s\S]*?;/gi) ?? []
      expect((sql.match(/BEGIN;/g) ?? [])).toHaveLength(ddlStatements.length)
      expect((sql.match(/COMMIT;/g) ?? [])).toHaveLength(ddlStatements.length)
      expect(sql).not.toMatch(/FOREIGN\s+KEY/i)
    }
  })

  it("installs a default before the bounded provenance backfill and NOT NULL afterward", () => {
    const sql = migration("039_native_decision_gates")
    const defaultIndex = sql.indexOf('ALTER COLUMN "now_commitment_provenance" SET DEFAULT')
    const notNullIndex = sql.indexOf('ALTER COLUMN "now_commitment_provenance" SET NOT NULL')
    expect(defaultIndex).toBeGreaterThan(-1)
    expect(notNullIndex).toBeGreaterThan(defaultIndex)
    expect(route).toContain("backfillRoadmapCommitmentProvenance")
  })

  it("does not add precursor models or columns to Prisma ordinary-route reads", () => {
    const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")
    expect(schema).not.toContain("model ReviewRequest")
    expect(schema).toContain("model PortfolioCapacityPlan")
    expect(schema).toMatch(/activeWorkspaceId\s+String\?\s+@unique\(map: "idx_capacity_plans_active_workspace"\)/)
    expect(schema).not.toContain("nowCommitmentProvenance")
  })

  it("atomically limits activation to one capacity plan per workspace", () => {
    const sql = migration("041_portfolio_capacity_ledger")
    expect(sql).toContain('"active_workspace_id" UUID')
    expect(sql).toMatch(/UNIQUE NULLS DISTINCT \("active_workspace_id"\)/)
    expect(sql).toContain("state = 'ACTIVE' AND active_workspace_id = workspace_id")
    expect(sql).toContain("state <> 'ACTIVE' AND active_workspace_id IS NULL")
  })
})
