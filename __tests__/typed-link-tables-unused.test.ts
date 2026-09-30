import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration-only PR: the typed link tables exist but no application code may
 * read or write them yet (old clients must be unaffected, and the code that
 * uses them must not deploy before migration 071 is applied). The only
 * allowed references are the migration hook and the status block, both of
 * which live under lib/migrations.
 */
const ROOT = process.cwd();
const FORBIDDEN = /opportunityObjectiveLink|solutionKeyResultLink|opportunity_objective_links|solution_key_result_links|OpportunityObjectiveLink|SolutionKeyResultLink/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe("typed link tables are not used by application code yet", () => {
  it("nothing in app/ or lib/ (outside lib/migrations) references the new models or tables", () => {
    const offenders = ["app", "lib", "components", "hooks"]
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .filter((file) => !file.startsWith(path.join(ROOT, "lib/migrations") + path.sep))
      .filter((file) => FORBIDDEN.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("within lib/migrations only the hook (and a comment in the runner's migration entry) mention them", () => {
    const files = sourceFiles(path.join(ROOT, "lib/migrations"))
      .filter((file) => FORBIDDEN.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(ROOT, file))
      .sort();
    expect(files).toEqual(["lib/migrations/runner.ts", "lib/migrations/typed-link-tables.ts"]);
    // The runner mention must be prose only, never a query.
    const runnerMentions = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
      .split("\n")
      .map((line) => line.replaceAll("backfillOpportunityObjectiveLinks", ""))
      .filter((line) => FORBIDDEN.test(line));
    expect(runnerMentions.length).toBeGreaterThan(0);
    expect(runnerMentions.every((line) => line.trim().startsWith("//"))).toBe(true);
  });
});
