import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The EntityLink model and the entity_links table are reached through ONE directory, lib/links/, which owns the
 * tenant-safety rules (workspaceId from the verified `from` row, both endpoints re-verified in the transaction,
 * workspace-filtered reads, no ON CONFLICT). Nothing else in app code may name them: not the model delegate, not the
 * table, not a generic delegate lookup. Allowed besides lib/links/: schema.prisma (declares the model), the migration
 * hook and SQL, and lib/typed-links.ts, whose pair-race matcher recognises the model/index name in an error.
 * Tests may name them. Same pattern as typed-link-access.test.ts.
 */
const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated", ".worktrees", ".claude", ".pnpm-store"]);
const SCANNED_DIRS = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name) && entry.name !== "__tests__" && entry.name !== "public")
  .map((entry) => entry.name);

// \b on both sides keeps parseEntityLink / EntityLinkInput / the URL path "entity-links" out of it.
const MODEL_NAME = /\bentityLink\b|\bEntityLink\b|\bentity_links\b|idx_entity_links_/;
const DYNAMIC_DELEGATE = /\b(?:\w*[Pp]risma\w*|\w*[Cc]lient|db|tx|database)\s*\[\s*(?:`[^`]*\$\{|[^"'`\]\s])/;
const rejoinConcatenation = (text: string) => text.replace(/["'`]\s*\+\s*["'`]/g, "");
/** Prose may mention the table; code may not. A `//` after a colon (a URL) is not a comment. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

function findReferences(source: string): string[] {
  const text = stripComments(source);
  const hits: string[] = [];
  if (MODEL_NAME.test(rejoinConcatenation(text))) hits.push("entity_links model/table name");
  if (DYNAMIC_DELEGATE.test(text)) hits.push("dynamic delegate access");
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs|sql|prisma)$/.test(entry.name) ? [full] : [];
  });
}

const posix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const mayName = (file: string) =>
  posix(file).startsWith("lib/links/") ||
  posix(file).startsWith("lib/migrations/") ||
  posix(file).startsWith("prisma/migrations/") ||
  ["prisma/schema.prisma", "lib/typed-links.ts"].includes(posix(file));

describe("findReferences (canary: the guard catches known-bad text)", () => {
  it.each([
    "await prisma.entityLink.findMany()",
    "tx.entityLink.create({ data })",
    "db.$queryRaw`SELECT * FROM entity_links`",
    "const t = 'entity' + '_links'",
    "type M = 'EntityLink'",
    "const delegate = prisma[modelName]",
    "await prisma.entityLink.deleteMany() // cleanup",
  ])("flags %s", (text) => expect(findReferences(text)).not.toEqual([]));

  it.each([
    "parseEntityLink(href)",
    "type EntityLinkInput = {}",
    "export type EntityLinkType = EntityType",
    'write("POST", "linkEntities", "/api/v1/workspaces/{workspaceId}/entity-links")',
    "prisma['opportunity'].findMany()",
    "// the entity_links table is empty in phase 1",
    "/** Uses prisma.entityLink under the hood. */",
  ])("does not flag %s", (text) => expect(findReferences(text)).toEqual([]));
});

describe("the entity_links table is reached only through lib/links/", () => {
  const files = SCANNED_DIRS.flatMap((dir) => {
    try {
      return sourceFiles(path.join(ROOT, dir));
    } catch {
      return [];
    }
  }).concat(readdirSync(ROOT).filter((name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name)).map((name) => path.join(ROOT, name)));

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((file) => posix(file).startsWith("scripts"))).toBe(true);
    expect(files.some((file) => posix(file).startsWith("e2e"))).toBe(true);
  });

  it("lib/links/service.ts does name the model (so the scan is looking at the right thing)", () => {
    expect(MODEL_NAME.test(readFileSync(path.join(ROOT, "lib/links/service.ts"), "utf-8"))).toBe(true);
  });

  it("no other file names the model or table, or reaches a delegate by computed name", () => {
    const offenders = files
      .filter((file) => !mayName(file))
      .flatMap((file) => {
        const hits = findReferences(readFileSync(file, "utf-8"));
        return hits.length ? [`${posix(file)}: ${hits.join(", ")}`] : [];
      })
      // E2E teardown deletes by raw SQL (FK-ordered cleanup of test workspaces); it never reads or writes links via the app.
      .filter((line) => line !== "e2e/functional/global-teardown.ts: entity_links model/table name")
      // Files that legitimately use non-literal delegates over a fixed model list that does not include EntityLink.
      .filter((line) => !/^(lib\/entity-mutations\.ts|lib\/workspace-update-mutations\.ts|lib\/prisma-updated-at\.ts|scripts\/verify-geode-document-migration\.ts): dynamic delegate access$/.test(line));
    expect(offenders).toEqual([]);
  });
});
