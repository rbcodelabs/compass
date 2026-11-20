import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { partitionPendingMigrations } from "@/lib/migrations/runner"
import { assertReviewedManagedManifest } from "@/lib/preview-automation/managed-manifest"

/** Static guards for 128_task_start_date: the SQL file is what reaches Aurora DSQL, with Prisma runtime changes deferred. */
const NAME = "128_task_start_date"
const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const statements = read(`prisma/migrations/${NAME}/migration.sql`)
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe(NAME, () => {
  it("is registered exactly once, after 125_unified_conversations, and passes the reviewed manifest gate", () => {
    expect(names.filter((n) => n === NAME)).toHaveLength(1)
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("125_unified_conversations"))
    const entries = partitionPendingMigrations("compass_pr_570_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("adds one nullable timestamptz column with DSQL-safe idempotent DDL", () => {
    expect(statements).toEqual(["ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ"])
  })

})
