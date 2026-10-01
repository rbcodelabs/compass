import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration-only PR: the typed link tables exist but no application code may
 * read or write them yet (old clients must be unaffected, and the code that
 * uses them must not deploy before migration 071 is applied). The only
 * allowed references are the migration hook and a comment in the runner, both
 * under lib/migrations.
 */
const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated", ".worktrees", ".claude", ".pnpm-store"]);
const SCANNED_DIRS = ["app", "lib", "components", "hooks", "scripts", "e2e", "prisma"];

// Any spelling of either model or table: PascalCase, camelCase, snake_case, kebab, spaced.
const LINK_NAME = /opportunity[\s_-]?objective[\s_-]?links?|solution[\s_-]?key[\s_-]?result[\s_-]?links?/i;
/** Names split across a string concatenation are rejoined before matching ("opportunity_objective" + "_links"). */
const rejoinConcatenation = (text: string) => text.replace(/["'`]\s*\+\s*["'`]/g, "");
/** Generic, non-literal model access on a Prisma-like receiver: prisma[name], tx[model]. */
const DYNAMIC_DELEGATE = /\b(?:prisma|db|tx|client)\s*\[\s*(?:`[^`]*\$\{|[^"'`\]\s])/;
const DYNAMIC_MODEL_INTROSPECTION = /Prisma\.ModelName|\bdmmf\b/;

function findLinkReferences(text: string): string[] {
  const joined = rejoinConcatenation(text);
  const hits: string[] = [];
  if (LINK_NAME.test(joined)) hits.push("link model/table name");
  if (DYNAMIC_DELEGATE.test(text)) hits.push("dynamic delegate access");
  if (DYNAMIC_MODEL_INTROSPECTION.test(text)) hits.push("model introspection");
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs|sql|prisma)$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(ROOT, file);
const isMigrationOwned = (file: string) =>
  rel(file).startsWith(`lib${path.sep}migrations${path.sep}`) || rel(file).startsWith(`prisma${path.sep}migrations${path.sep}`);
/** This test, its sibling tests for the migration, and schema.prisma legitimately name the tables. */
const isOwnedTestOrSchema = (file: string) =>
  /^__tests__\/(typed-link-tables-|prisma-migrations\.test\.ts)/.test(rel(file).split(path.sep).join("/")) || rel(file) === `prisma${path.sep}schema.prisma`;

// Files that legitimately use non-literal Prisma delegates or model introspection today, each over a fixed
// model list that does not include the link models (the name check above still covers those lists).
const ALLOWED_GENERIC_ACCESS = new Set([
  "lib/entity-mutations.ts",
  "lib/workspace-update-mutations.ts",
  "lib/prisma-updated-at.ts",
  "scripts/verify-geode-document-migration.ts",
]);

describe("findLinkReferences (canary: the guard catches known-bad text)", () => {
  it.each([
    ["prisma.opportunityObjectiveLink.findMany()", "link model/table name"],
    ["await prisma.solutionKeyResultLink.create({ data })", "link model/table name"],
    ["db.$queryRaw`SELECT * FROM opportunity_objective_links`", "link model/table name"],
    ["const t = 'solution_key_result_links'", "link model/table name"],
    ["const t = 'opportunity_objective' + '_links'", "link model/table name"],
    ['const t = "solution_key" + "_result_links"', "link model/table name"],
    ["type M = 'OpportunityObjectiveLink'", "link model/table name"],
    ["opportunity-objective-link", "link model/table name"],
    ["const delegate = prisma[modelName]", "dynamic delegate access"],
    ["tx[`${kind}Link`].create(args)", "dynamic delegate access"],
    ["Object.keys(Prisma.ModelName)", "model introspection"],
    ["Prisma.dmmf.datamodel.models", "model introspection"],
  ])("flags %s", (text, reason) => {
    expect(findLinkReferences(text)).toContain(reason);
  });

  it.each([
    "prisma.opportunity.findMany()",
    "prisma.keyResult.update({ where: { id } })",
    "const linked = opportunity.linkedKeyResultId",
    "prisma['opportunity'].findMany()",
  ])("does not flag %s", (text) => {
    expect(findLinkReferences(text)).toEqual([]);
  });
});

describe("typed link tables are not used by application code yet", () => {
  const files = SCANNED_DIRS.flatMap((dir) => {
    try {
      return sourceFiles(path.join(ROOT, dir));
    } catch {
      return [];
    }
  }).concat(readdirSync(ROOT).filter((name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name)).map((name) => path.join(ROOT, name)));

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((file) => rel(file).startsWith("scripts"))).toBe(true);
    expect(files.some((file) => rel(file).startsWith("e2e"))).toBe(true);
    expect(files.some((file) => rel(file) === "seed-screenshots.ts")).toBe(true);
  });

  it("nothing in app/, lib/, components/, hooks/, scripts/, e2e/, prisma/ seeds or root scripts references the new models or tables", () => {
    const offenders = files
      .filter((file) => !isMigrationOwned(file) && !isOwnedTestOrSchema(file))
      .flatMap((file) => {
        const hits = findLinkReferences(readFileSync(file, "utf-8")).filter(
          (hit) => !(hit === "dynamic delegate access" || hit === "model introspection") || !ALLOWED_GENERIC_ACCESS.has(rel(file).split(path.sep).join("/")),
        );
        return hits.map((hit) => `${rel(file)}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });

  it("within lib/migrations only the hook (and prose in the runner's migration entry) mention them", () => {
    const hits = files
      .filter((file) => rel(file).startsWith(`lib${path.sep}migrations${path.sep}`))
      .filter((file) => LINK_NAME.test(rejoinConcatenation(readFileSync(file, "utf-8").replaceAll("backfillOpportunityObjectiveLinks", "").replaceAll("pruneStaleLegacyLinks", ""))))
      .map(rel)
      .sort();
    expect(hits).toEqual(["lib/migrations/runner.ts", "lib/migrations/typed-link-tables.ts"]);
    const runnerMentions = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
      .split("\n")
      .map((line) => line.replaceAll("backfillOpportunityObjectiveLinks", ""))
      .filter((line) => LINK_NAME.test(line));
    expect(runnerMentions.length).toBeGreaterThan(0);
    expect(runnerMentions.every((line) => line.trim().startsWith("//"))).toBe(true);
  });
});
