import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_LINKS_OPPORTUNITY_RESIDUAL_MIGRATION } from "@/lib/migrations/entity-links-opportunity-backfill";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";

const ROOT = process.cwd();
const NAME = "106_entity_links_residual_opportunity";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");

describe("106 residual opportunity pass", () => {
  const runner = read("lib/migrations/runner.ts");

  it("registers after 105 with a DDL-free SQL file", () => {
    expect(ENTITY_LINKS_OPPORTUNITY_RESIDUAL_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "105_workspace_agent_github_repos"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("is explicit-only, and a pending 106 is skipped by an untargeted POST", () => {
    const pending = [{ name: "107_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["107_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
  });

  it("runs the 095 backfill then its postconditions before the receipt, with no async wait", () => {
    expect(runner).toMatch(/migration\.name === ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION \|\| migration\.name === ENTITY_LINKS_OPPORTUNITY_RESIDUAL_MIGRATION/);
    const hook = runner.indexOf("await backfillEntityLinksOpportunity(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksOpportunityBackfill(client, schema)");
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(runner).not.toMatch(new RegExp(`ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*${NAME}`));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"lib/migrations/entity-links-opportunity-backfill.ts": "${digest("lib/migrations/entity-links-opportunity-backfill.ts")}"`);
  });
});
