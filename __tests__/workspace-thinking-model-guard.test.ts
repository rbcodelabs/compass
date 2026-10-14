import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Migration 073 (PR #338) added workspaces.thinking_model and
 * workspaces.thinking_model_labels as a migration-only change and, until the code
 * PR, a guard forbade any reference to them. This is the code PR, so the guard is
 * inverted (as PR #331 inverted PR-A's "schema unchanged" test): the Prisma
 * Workspace model must now declare both columns, with the exact mapping that
 * migration 073 created, or the shared workspace select would query a column that
 * does not exist.
 */

const ROOT = process.cwd();

function workspaceModelBody(schema: string): string {
  return schema.match(/model Workspace \{[\s\S]*?\n\}/)?.[0] ?? "";
}

describe("workspace thinking-model columns are declared to match migration 073", () => {
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8");
  const body = workspaceModelBody(schema);

  it("finds the Workspace model", () => {
    expect(body.length).toBeGreaterThan(500);
  });

  it("declares thinkingModel as a nullable VarChar(40) mapped to thinking_model", () => {
    expect(body).toMatch(/\n\s+thinkingModel\s+String\?\s+@map\("thinking_model"\)\s+@db\.VarChar\(40\)/);
  });

  it("declares thinkingModelLabels as a nullable Text mapped to thinking_model_labels", () => {
    expect(body).toMatch(/\n\s+thinkingModelLabels\s+String\?\s+@map\("thinking_model_labels"\)\s+@db\.Text/);
  });

  it("neither column has a default (migration 073 adds none)", () => {
    const lines = body.split("\n").filter((l) => /thinkingModel/.test(l));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toMatch(/@default/);
  });

  it("matches the column definitions in migration 073", () => {
    const sql = readFileSync(
      path.join(ROOT, "prisma/migrations/073_workspace_thinking_model/migration.sql"),
      "utf-8",
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS thinking_model VARCHAR\(40\);/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS thinking_model_labels TEXT;/);
  });
});
