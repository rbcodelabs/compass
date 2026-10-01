import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The typed link models and tables (opportunity_objective_links, solution_key_result_links) are reached
 * through ONE module, lib/typed-links.ts, which owns the tenant-safety rules (workspaceId from the authorized
 * parent, both endpoints re-verified in the transaction, origin never downgraded, workspace-filtered reads).
 * Nothing else in app code may name them: not a model delegate, not a table, not a generic delegate lookup.
 * The migration hook and its SQL (lib/migrations, prisma/migrations) and schema.prisma legitimately do, and so
 * do tests.
 *
 * (This used to be the migration-only PR's "nothing reads these tables yet" guard. The code PR that deploys
 * after migration 071 replaces that invariant with this narrower, permanent one.)
 */
const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated", ".worktrees", ".claude", ".pnpm-store"]);
// Every top-level source directory, not a fixed list: a new top-level folder is scanned the day it appears.
const SCANNED_DIRS = readdirSync(process.cwd(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name) && entry.name !== "__tests__" && entry.name !== "public")
  .map((entry) => entry.name);

// Any spelling of either model or table: PascalCase, camelCase, snake_case, kebab, spaced.
const LINK_NAME = /opportunity[\s_-]?objective[\s_-]?links?|solution[\s_-]?key[\s_-]?result[\s_-]?links?/i;
/** Names split across a string concatenation are rejoined before matching ("opportunity_objective" + "_links"). */
const rejoinConcatenation = (text: string) => text.replace(/["'`]\s*\+\s*["'`]/g, "");
/** Generic, non-literal model access on a Prisma-like receiver: prisma[name], tx[model]. */
const DYNAMIC_DELEGATE = /\b(?:\w*[Pp]risma\w*|\w*[Cc]lient|db|tx|database)\s*\[\s*(?:`[^`]*\$\{|[^"'`\]\s])/;
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
const relPosix = (file: string) => rel(file).split(path.sep).join("/");
const isMigrationOwned = (file: string) => relPosix(file).startsWith("lib/migrations/") || relPosix(file).startsWith("prisma/migrations/");
/** The one module that may name the link models, and schema.prisma (which declares them). */
const LINK_MODULE = "lib/typed-links.ts";
/**
 * The end-to-end files that must delete synthetic link rows by workspace id (no foreign key reaches them, so deleting the workspace
 * would leave them behind in the shared e2e database): the typed-links spec's afterAll and the suite's global teardown. The spec
 * verifies behaviour through the MCP tools.
 */
const E2E_CLEANUP_SPECS = new Set(["e2e/functional/specs/typed-links.spec.ts", "e2e/functional/global-teardown.ts"]);
const isLinkModuleOrSchema = (file: string) => relPosix(file) === LINK_MODULE || relPosix(file) === "prisma/schema.prisma" || E2E_CLEANUP_SPECS.has(relPosix(file));

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
    // Assembled, so this canary is not itself a dynamic-delegate create the write-path guard would flag in this file.
    [["tx[", "`${kind}Link`", "].cre", "ate(args)"].join(""), "dynamic delegate access"],
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

describe("typed link models are reached only through lib/typed-links.ts", () => {
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

  it("the allow-listed e2e files may only DELETE from the link tables or count their rows, never INSERT or UPDATE them", () => {
    for (const spec of E2E_CLEANUP_SPECS) {
      const text = readFileSync(path.join(ROOT, spec), "utf-8");
      expect(text, spec).toMatch(LINK_NAME);
      expect(text, spec).not.toMatch(/(?:INSERT\s+INTO|UPDATE)\s+\S*(?:opportunity_objective_links|solution_key_result_links)/i);
      for (const line of text.split("\n").filter((l) => LINK_NAME.test(l) && /(?:SELECT|DELETE|INSERT|UPDATE)\s/i.test(l))) {
        expect(line, `${spec}: ${line.trim()}`).toMatch(/DELETE FROM|SELECT count/i);
      }
    }
  });

  it("lib/typed-links.ts does name them (so the scan below is looking at the right thing)", () => {
    expect(findLinkReferences(readFileSync(path.join(ROOT, LINK_MODULE), "utf-8"))).toContain("link model/table name");
  });

  it("nothing in app/, lib/, components/, hooks/, scripts/, e2e/, prisma/ seeds or root scripts references the link models or tables except that module and the migration hook", () => {
    const offenders = files
      .filter((file) => !isMigrationOwned(file) && !isLinkModuleOrSchema(file))
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
