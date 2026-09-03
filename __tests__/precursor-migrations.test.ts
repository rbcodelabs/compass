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
    "042_native_decision_gates_repair",
    "043_decision_evidence_refs",
  ])("registers %s in the authenticated migration manifest", (name) => {
    expect(route).toContain(`name: "${name}"`)
    expect(migration(name)).toMatch(/CREATE (?:TABLE|INDEX)|ALTER TABLE/)
  })

  it("keeps every index asynchronous and every DDL transaction isolated", () => {
    for (const name of [
      "039_native_decision_gates",
      "040_release_authorization",
      "041_portfolio_capacity_ledger",
      "042_native_decision_gates_repair",
      "043_decision_evidence_refs",
    ]) {
      const sql = migration(name)
      expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!ASYNC\b)/i)
      const ddlStatements = sql.match(/(?:CREATE|ALTER)\s+(?:TABLE|INDEX)[\s\S]*?;/gi) ?? []
      const asyncConstraintValidations = sql.match(/ALTER\s+TABLE\s+ASYNC[\s\S]*?;/gi) ?? []
      expect((sql.match(/BEGIN;/g) ?? [])).toHaveLength(ddlStatements.length - asyncConstraintValidations.length)
      expect((sql.match(/COMMIT;/g) ?? [])).toHaveLength(ddlStatements.length - asyncConstraintValidations.length)
      expect(asyncConstraintValidations.every((statement) => /VALIDATE\s+CONSTRAINT/i.test(statement))).toBe(true)
      expect(sql).not.toMatch(/FOREIGN\s+KEY/i)
    }
  })

  it("keeps migration 039 DSQL-safe while installing the provenance default before the bounded backfill", () => {
    const sql = migration("039_native_decision_gates")
    const defaultIndex = sql.indexOf('ALTER COLUMN "now_commitment_provenance" SET DEFAULT')
    expect(defaultIndex).toBeGreaterThan(-1)
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+"now_commitment_provenance"\s+SET\s+NOT\s+NULL/i)
    expect(route).toContain("backfillRoadmapCommitmentProvenance")
  })

  it("repairs a partially applied 039 without unsupported DSQL ALTER COLUMN operations", () => {
    const sql = migration("042_native_decision_gates_repair")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "now_commitment_provenance"')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "now_decision_record_id"')
    expect(sql).toContain('SET DEFAULT \'LEGACY_UNGATED\'')
    expect(sql).toContain('CREATE INDEX ASYNC IF NOT EXISTS "idx_review_requests_workspace_state"')
    expect(sql).not.toMatch(/SET\s+NOT\s+NULL/i)
    expect(sql).toContain('ADD CONSTRAINT "chk_roadmap_items_commitment_provenance_not_null"')
    expect(sql).toContain('ALTER TABLE ASYNC "roadmap_items" VALIDATE CONSTRAINT')
  })

  it("requires migration-specific catalog postconditions before finishing every decision-gate receipt", () => {
    expect(route).toContain('"040_release_authorization":')
    expect(route).toContain('"041_portfolio_capacity_ledger":')
    expect(route).toContain('"043_decision_evidence_refs":')
    expect(route).toContain('applied.includes("043_decision_evidence_refs")')
    expect(route).toContain("assertDecisionMigrationPostconditions")
    expect(route).toContain("tables.length === expected.tables.size")
    expect(route).toContain("constraints.length === expected.constraints.size")
    expect(route).toContain("indexes.length === expected.indexes.size")
  })

  it("exposes the live precursor schema to the contract release", () => {
    const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")
    expect(schema).toContain("model ReviewRequest")
    expect(schema).toContain("model PortfolioCapacityPlan")
    expect(schema).toMatch(/activeWorkspaceId\s+String\?\s+@unique\(map: "idx_capacity_plans_active_workspace"\)/)
    expect(schema).toContain("nowCommitmentProvenance")
    expect(schema.match(/model PortfolioCapacityPlan/g)).toHaveLength(1)
    expect(schema).toContain("model DecisionEvidenceRef")
  })

  it("uses the migration-health canonical native provenance literal at runtime", () => {
    const commitment = readFileSync(path.join(root, "lib/now-commitment.ts"), "utf8")
    const card = readFileSync(path.join(root, "components/roadmap/now-commitment-card.tsx"), "utf8")
    expect(route).toContain("'LEGACY_UNGATED','NATIVE_GATED'")
    expect(commitment).toContain('nowCommitmentProvenance: "NATIVE_GATED"')
    expect(commitment).not.toContain('"NATIVE_DECISION"')
    expect(card).toContain('provenance === "NATIVE_GATED"')
    expect(card).not.toContain('"NATIVE_DECISION"')
  })

  it("atomically limits activation to one capacity plan per workspace", () => {
    const sql = migration("041_portfolio_capacity_ledger")
    expect(sql).toContain('"active_workspace_id" UUID')
    expect(sql).toMatch(/UNIQUE NULLS DISTINCT \("active_workspace_id"\)/)
    expect(sql).toContain("state = 'ACTIVE' AND active_workspace_id = workspace_id")
    expect(sql).toContain("state <> 'ACTIVE' AND active_workspace_id IS NULL")
    expect(sql).toContain('UNIQUE ("plan_id", "roadmap_item_id")')
    expect(sql).toContain('UNIQUE NULLS DISTINCT ("active_roadmap_item_id")')
    expect(sql).toContain('"portfolio_capacity_operations"')
    expect(sql).toContain('"now_snapshot_fingerprint" CHAR(64)')
  })
})
