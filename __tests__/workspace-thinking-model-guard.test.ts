import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Migration 073 adds workspaces.thinking_model and workspaces.thinking_model_labels
 * as a migration-only PR. The shared workspace select feeds every page, so any code
 * that selects either column before 073 is applied would 500 the whole app. Until
 * the follow-up code PR (which removes this guard) lands, nothing may reference the
 * columns and the Prisma Workspace model must not declare them.
 */

const ROOT = process.cwd();
const SCANNED_DIRS = ["app", "lib", "components", "hooks", "scripts"];
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/;
const MIGRATION_NAME = "073_workspace_thinking_model";
// snake_case (raw SQL / @map) and camelCase (Prisma field) spellings, either column.
const FORBIDDEN = /thinking_model|thinkingModel/i;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === ".next") return [];
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : SOURCE_FILE.test(entry) ? [full] : [];
  });
}

/** The migration's own registered name legitimately contains the substring. */
function referencesColumns(source: string): boolean {
  return FORBIDDEN.test(source.replaceAll(MIGRATION_NAME, ""));
}

function workspaceModelBody(schema: string): string {
  return schema.match(/model Workspace \{[\s\S]*?\n\}/)?.[0] ?? "";
}

describe("workspace thinking-model columns are not referenced by application code yet", () => {
  it("scans a non-trivial set of source files", () => {
    const files = SCANNED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(200);
  });

  it("no source file under app/lib/components/hooks/scripts references thinking_model or thinkingModel", () => {
    const offenders = SCANNED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
      .filter((file) => referencesColumns(readFileSync(file, "utf-8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("schema.prisma Workspace declares neither column", () => {
    const body = workspaceModelBody(readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8"));
    expect(body.length).toBeGreaterThan(500); // the model was actually found
    expect(body).not.toMatch(FORBIDDEN);
  });

  it("canary: the detector flags known-bad fixtures and ignores the registered migration name", () => {
    expect(referencesColumns("SELECT id, thinking_model FROM workspaces")).toBe(true);
    expect(referencesColumns("select: { thinkingModel: true }")).toBe(true);
    expect(referencesColumns("workspace.thinking_model_labels")).toBe(true);
    expect(referencesColumns('name: "073_workspace_thinking_model"')).toBe(false);
    expect(workspaceModelBody('model Workspace {\n  id String\n  thinkingModel String? @map("thinking_model")\n}\n')).toMatch(FORBIDDEN);
  });
});
