/**
 * Write-path guard for Solution and Objective (ADR Phase 0).
 *
 * `workspaceId` is optional in the Prisma types because Aurora DSQL cannot add a
 * NOT NULL column to a populated table, so the compiler will not catch a create
 * that forgets it. This test does: every code path that creates a Solution or
 * Objective — server actions, MCP handlers, seeds, scripts, and raw-SQL e2e
 * fixtures — must set `workspace_id` / `workspaceId`.
 *
 * It is deliberately textual. A missed create is a silent NULL that every read
 * path then (correctly) denies, which shows up as "the row vanished" rather than
 * as an error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", ".worktrees", ".pnpm-store", "__tests__", "public", "docs"]);
const SOURCE = /\.(ts|tsx|mjs|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(file, "utf-8") }));

describe("every Solution and Objective create sets workspaceId", () => {
  it("Prisma creates pass workspaceId in the same call", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.(solution|objective)\.(create|createMany|upsert)\(/g)) {
        seen += 1;
        // The data object of a create is short; look at the call's own window.
        const window = text.slice(match.index!, match.index! + 700);
        if (!/\bworkspaceId\b/.test(window)) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4); // discovery action, okrs action, add_solution, create_objective (+ e2e specs)
    expect(offenders).toEqual([]);
  });

  it("raw-SQL inserts (seeds and e2e fixtures) insert workspace_id", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const match of text.matchAll(/INSERT\s+INTO\s+[^\s(]*\.?"?(solutions|objectives)"?\s*\(([^)]*)\)/gi)) {
        seen += 1;
        if (!/\bworkspace_id\b/.test(match[2])) offenders.push(`${file}: INSERT INTO ${match[1]} (${match[2].replace(/\s+/g, " ").trim()})`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it("no authorization or scoping path reads the parent chain for a Solution or Objective", () => {
    const allowed = new Set([
      // Legacy 046 shared-comments backfill: SQL that may run on schemas that predate migration 068.
      "lib/shared-comments-backfill.ts",
      // The 068 backfill itself derives from the parent by definition.
      "lib/migrations/workspace-id-on-solution-objective.ts",
    ]);
    const offenders: string[] = [];
    for (const { file, text } of files) {
      if (allowed.has(file)) continue;
      for (const pattern of [
        /solution:\s*\{\s*opportunity:\s*\{\s*workspaceId/,
        /objective:\s*\{\s*cycle:\s*\{\s*workspaceId/,
        /\.solution\.\w+\(\{\s*where:\s*\{[^}]*opportunity:\s*\{\s*workspaceId/,
        /\.objective\.\w+\(\{\s*where:\s*\{[^}]*cycle:\s*\{\s*workspaceId/,
        /\.opportunity\??\.workspaceId\s*(===|!==)/,
      ]) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
