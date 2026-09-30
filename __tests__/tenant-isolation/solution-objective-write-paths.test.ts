/**
 * Write-path guard for Solution and Objective (ADR Phase 0).
 *
 * `workspaceId` is optional in the Prisma types because Aurora DSQL cannot add a
 * NOT NULL column to a populated table, so the compiler will not catch a create
 * that forgets it. This test does: every code path that creates a Solution or
 * Objective (server actions, MCP handlers, seeds, scripts, raw-SQL e2e fixtures)
 * must set `workspace_id` / `workspaceId`.
 *
 * It parses the call rather than grepping a window, so `workspaceId` appearing in a
 * nearby comment or an unrelated argument does not satisfy it:
 *   - Prisma `create` / `upsert`: the `data` (or `create`) object LITERAL must have a
 *     top-level `workspaceId` key. A spread, or a non-literal `data`, is rejected as
 *     unverifiable, which forces the field to be written out where a reviewer sees it.
 *   - `createMany`: every element literal must have it.
 *   - Raw SQL: `INSERT INTO <table> (<columns>) ...` must list `workspace_id`; an insert
 *     with no column list is rejected (it cannot be checked), and `INSERT ... SELECT`
 *     is checked through its column list like any other insert.
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

// ── A tiny balanced-bracket reader (strings and template literals are skipped) ──

function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === quote) return j;
    else if (quote === "`" && text[j] === "$" && text[j + 1] === "{") j = matchClose(text, j + 1) ;
  }
  return text.length - 1;
}

/** Index of the bracket closing the one opened at `open`. */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i); continue; }
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) return text.length - 1; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 1; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return i;
      if (stack.length === 0) return i;
    }
  }
  return text.length - 1;
}

/** Blanks out comments (outside strings) so a comment can neither hide nor fake a key. */
function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { const end = skipString(text, i); out += text.slice(i, end + 1); i = end; continue; }
    if (c === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); const stop = end < 0 ? text.length : end; out += " ".repeat(stop - i); i = stop - 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i); const stop = end < 0 ? text.length : end + 2; out += " ".repeat(stop - i); i = stop - 1; continue; }
    out += c;
  }
  return out;
}

type Keys = { keys: Set<string>; hasSpread: boolean };

/** Top-level keys of an object literal whose `{` is at `open`. */
function objectKeys(text: string, open: number): Keys {
  const close = matchClose(text, open);
  const body = stripComments(text.slice(open + 1, close));
  const keys = new Set<string>();
  let hasSpread = false;
  let depth = 0;
  let segmentStart = 0;
  const flush = (end: number) => {
    const segment = body.slice(segmentStart, end).trim();
    if (segment.startsWith("...")) hasSpread = true;
    else {
      const m = /^(?:\[[^\]]*\]|["'`]?([A-Za-z_$][\w$]*)["'`]?)\s*(?::|$|\()/.exec(segment);
      if (m?.[1]) keys.add(m[1]);
    }
    segmentStart = end + 1;
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(body, i); continue; }
    if (c === "/" && body[i + 1] === "/") { i = body.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) flush(i);
  }
  flush(body.length);
  return { keys, hasSpread };
}

/** Finds `name:` at the top level of the object literal opened at `open`; returns the index of its value. */
function valueOf(text: string, open: number, name: string): number | null {
  const close = matchClose(text, open);
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i); continue; }
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); continue; }
    if (c === "(" || c === "{" || c === "[") { depth += 1; continue; }
    if (c === ")" || c === "}" || c === "]") { depth -= 1; continue; }
    if (depth === 0 && text.startsWith(name, i) && /[\s,{]/.test(text[i - 1] ?? " ") && /^\s*:/.test(text.slice(i + name.length))) {
      let j = i + name.length;
      j = text.indexOf(":", j) + 1;
      while (/\s/.test(text[j])) j += 1;
      return j;
    }
  }
  return null;
}

type Verdict = string | null; // null = ok, otherwise why not

function checkObjectLiteral(text: string, at: number | null, label: string): Verdict {
  if (at === null) return `${label}: not found`;
  if (text[at] !== "{") return `${label}: not an object literal (cannot verify workspaceId)`;
  const { keys, hasSpread } = objectKeys(text, at);
  if (hasSpread) return `${label}: uses a spread (write workspaceId out explicitly)`;
  return keys.has("workspaceId") ? null : `${label}: no top-level workspaceId`;
}

/** Verdict for one `.solution.create(` / `.objective.upsert(` etc. call starting at its `(`. */
export function checkPrismaCall(text: string, op: string, openParen: number): Verdict {
  const argStart = openParen + 1;
  const firstNonSpace = text.slice(argStart).search(/\S/) + argStart;
  if (text[firstNonSpace] !== "{") return "argument is not an object literal";
  if (op === "upsert") return checkObjectLiteral(text, valueOf(text, firstNonSpace, "create"), "upsert.create");
  const data = valueOf(text, firstNonSpace, "data");
  if (op === "create") return checkObjectLiteral(text, data, "create.data");
  // createMany: data is an array of literals
  if (data === null) return "createMany: no data";
  if (text[data] !== "[") return "createMany.data: not an array literal";
  const end = matchClose(text, data);
  let i = data + 1;
  while (i < end) {
    if (text[i] === "{") {
      const v = checkObjectLiteral(text, i, "createMany.data[]");
      if (v) return v;
      i = matchClose(text, i) + 1;
    } else i += 1;
  }
  return null;
}

/** Verdicts for every INSERT INTO solutions/objectives in a file's text. */
export function checkRawInserts(text: string): string[] {
  const offenders: string[] = [];
  for (const m of text.matchAll(/INSERT\s+INTO\s+([^\s(]*?)"?(solutions|objectives)"?\s*(\(([^)]*)\))?/gi)) {
    const table = m[2];
    if (!m[3]) offenders.push(`INSERT INTO ${table}: no column list (cannot verify workspace_id)`);
    else if (!/\bworkspace_id\b/.test(m[4])) offenders.push(`INSERT INTO ${table} (${m[4].replace(/\s+/g, " ").trim()})`);
  }
  return offenders;
}

describe("the write-path checker itself (so a miss cannot pass vacuously)", () => {
  const call = (src: string, op = "create") => checkPrismaCall(src, op, src.indexOf("("));
  it("accepts an explicit workspaceId key, long-form or shorthand", () => {
    expect(call("create({ data: { workspaceId: x, title: t } })")).toBeNull();
    expect(call("create({ data: { title: t, workspaceId } })")).toBeNull();
    expect(call("create({\n data: {\n // workspaceId is set below\n workspaceId: opp.workspaceId,\n opportunityId,\n },\n })")).toBeNull();
  });
  it("rejects a create that never sets it, even when 'workspaceId' appears elsewhere in the call", () => {
    expect(call("create({ data: { opportunityId, title: `for ${workspaceId}` } })")).toMatch(/no top-level workspaceId/);
    expect(call("create({ data: { opportunityId }, select: { workspaceId: true } })")).toMatch(/no top-level workspaceId/);
    expect(call("create({ data: { title, opp: { connect: { workspaceId } } } })")).toMatch(/no top-level workspaceId/);
    expect(call("create({ data: { title } }) /* workspaceId */")).toMatch(/no top-level workspaceId/);
  });
  it("rejects unverifiable shapes: spread and non-literal data", () => {
    expect(call("create({ data: { ...fields, title } })")).toMatch(/spread/);
    expect(call("create({ data: payload })")).toMatch(/not an object literal/);
    expect(call("create(args)")).toMatch(/not an object literal/);
  });
  it("checks upsert's create branch and every createMany element", () => {
    expect(call("upsert({ where: { id }, update: { workspaceId }, create: { title } })", "upsert")).toMatch(/no top-level workspaceId/);
    expect(call("upsert({ where: { id }, update: {}, create: { workspaceId, title } })", "upsert")).toBeNull();
    expect(call("createMany({ data: [{ workspaceId, title }, { title }] })", "createMany")).toMatch(/no top-level workspaceId/);
    expect(call("createMany({ data: [{ workspaceId, title }, { workspaceId, title }] })", "createMany")).toBeNull();
  });
  it("checks raw INSERTs through their column list, including INSERT ... SELECT, and rejects a missing list", () => {
    expect(checkRawInserts("INSERT INTO s.solutions (id, workspace_id, title) VALUES ($1,$2,$3)")).toEqual([]);
    expect(checkRawInserts('INSERT INTO "${S}".objectives (id, workspace_id, cycle_id) SELECT gen_random_uuid(), w, c FROM x')).toEqual([]);
    expect(checkRawInserts("INSERT INTO s.solutions (id, title) SELECT id, title FROM legacy WHERE workspace_id = 1")).toHaveLength(1);
    expect(checkRawInserts("INSERT INTO s.objectives SELECT * FROM legacy")).toEqual(["INSERT INTO objectives: no column list (cannot verify workspace_id)"]);
  });
});

const files = walk(ROOT).map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(file, "utf-8") }));

describe("every Solution and Objective create sets workspaceId", () => {
  it("Prisma creates set a top-level workspaceId in their data literal", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.(solution|objective)\.(create|createMany|upsert)\(/g)) {
        seen += 1;
        const verdict = checkPrismaCall(text, match[2], match.index! + match[0].length - 1);
        if (verdict) offenders.push(`${file}: ${match[0]} ${verdict}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4); // discovery action, okrs action, add_solution, create_objective (+ e2e specs)
    expect(offenders).toEqual([]);
  });

  it("raw-SQL inserts (seeds and e2e fixtures) list workspace_id", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      seen += [...text.matchAll(/INSERT\s+INTO\s+[^\s(]*?"?(solutions|objectives)"?\s*/gi)].length;
      for (const offender of checkRawInserts(text)) offenders.push(`${file}: ${offender}`);
    }
    expect(seen).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it("no authorization or scoping path reads the parent chain for a Solution or Objective", () => {
    const allowed = new Set([
      // Legacy 046 shared-comments backfill: SQL that may run on schemas that predate migration 068.
      "lib/shared-comments-backfill.ts",
      // The 068/069 backfill itself derives from the parent by definition.
      "lib/migrations/workspace-id-on-solution-objective.ts",
      // Teardown reaches un-backfilled rows through the parent, only while their own workspaceId is NULL.
      "lib/delete-workspace-cascade.ts",
      "app/[orgSlug]/[workspaceSlug]/settings/actions.ts",
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
