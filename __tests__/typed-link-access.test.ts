import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * entity_links is the ONLY store for the Opportunity <-> Objective, Opportunity -> Key Result, Solution <-> Key Result, Artifact and
 * task links (the nine associations and the COMMENT / AGENT_CONVERSATION origins). The tables they replaced (opportunity_objective_links,
 * solution_key_result_links, artifact_links, task_links) and the opportunities.linked_key_result_id column are dropped by migration 116, and
 * their Prisma models are gone, so NOTHING in app code may name those tables or columns: not a table, not a generic delegate lookup, no
 * column. Only the migration hooks and SQL (lib/migrations, prisma/migrations), the workspace export module (which tolerates old bundles that
 * still carry the retired models) and tests legitimately do.
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

/** Prose may mention a table; code may not. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

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
/**
 * lib/workspace-export/ copies a whole workspace between workspaces/organizations, including its link rows, by walking every exported
 * model generically (dynamic delegates, model introspection, and the link model names in its classification registry). It is the only
 * other code allowed to do so. The tenant-safety rules this guard protects are kept by the importer instead of lib/typed-links.ts:
 * every row's workspaceId is the NEW workspace's id, and a link whose endpoint is not itself part of the import is dropped
 * (DROP_ON_UNRESOLVED in lib/workspace-export/import.ts), so an imported link can never point into another workspace.
 * Both are asserted in __tests__/workspace-export*.integration.test.ts.
 */
const isWorkspaceExportModule = (file: string) => relPosix(file).startsWith("lib/workspace-export/");
const isSchema = (file: string) => relPosix(file) === "prisma/schema.prisma";
const FROZEN_LINK = /\.(?:opportunityObjectiveLink|solutionKeyResultLink|artifactLink)\b|\bartifact_links\b/;
const TASK_LINK_DELEGATE = /\.taskLink\b|\btask_links\b/;
/** A filter on the Task.links relation (`links: { some: ... }`) reads task_links without naming the model. */
const TASK_LINKS_RELATION = /\blinks\s*:\s*\{\s*(?:some|every|none)\b|\binclude\s*:\s*\{[^}]*\blinks\s*:\s*true\b|\bselect\s*:\s*\{[^}]*\blinks\s*:\s*(?:true|\{)/;

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

  it("the end-to-end suites clean up and assert through entity_links, never the frozen tables", () => {
    for (const file of files.filter((candidate) => relPosix(candidate).startsWith("e2e/"))) {
      const text = readFileSync(file, "utf-8");
      expect(text.match(LINK_NAME) ?? [], relPosix(file)).toEqual([]);
    }
  });

  it("nothing in app/, lib/, components/, hooks/, scripts/, e2e/, prisma/ seeds or root scripts references the link models or tables except the migration hooks, the schema and workspace export", () => {
    const offenders = files
      .filter((file) => !isMigrationOwned(file) && !isSchema(file) && !isWorkspaceExportModule(file))
      .flatMap((file) => {
        const hits = findLinkReferences(readFileSync(file, "utf-8")).filter(
          (hit) => !(hit === "dynamic delegate access" || hit === "model introspection") || !ALLOWED_GENERIC_ACCESS.has(rel(file).split(path.sep).join("/")),
        );
        return hits.map((hit) => `${rel(file)}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });

  it("no code names the frozen artifact / opportunity / solution / task link models or tables, or filters the Task.links relation, except the migrations, the schema and workspace export", () => {
    const offenders = files
      .filter((file) => !isMigrationOwned(file) && !isSchema(file) && !isWorkspaceExportModule(file))
      .flatMap((file) => {
        const text = stripComments(readFileSync(file, "utf-8"));
        const hits: string[] = [];
        if (FROZEN_LINK.test(text)) hits.push("frozen link model/table");
        if (TASK_LINK_DELEGATE.test(text)) hits.push("task_links accessor");
        if (TASK_LINKS_RELATION.test(text)) hits.push("Task.links relation");
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
    expect(hits).toEqual(["lib/migrations/entity-links-legacy-drop.ts", "lib/migrations/entity-links-opportunity-backfill.ts", "lib/migrations/entity-links-read-parity.ts", "lib/migrations/entity-links-row-detail.ts", "lib/migrations/entity-links-solution-key-result-backfill.ts", "lib/migrations/legacy-link-relations.ts", "lib/migrations/runner.ts", "lib/migrations/typed-link-tables.ts"]);
    const runnerMentions = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
      .split("\n")
      .map((line) => line.replaceAll("backfillOpportunityObjectiveLinks", ""))
      .filter((line) => LINK_NAME.test(line));
    expect(runnerMentions.length).toBeGreaterThan(0);
    expect(runnerMentions.every((line) => line.trim().startsWith("//"))).toBe(true);
  });
});
