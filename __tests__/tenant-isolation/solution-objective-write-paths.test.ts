/**
 * Write-path guard for Solution and Objective (ADR Phase 0).
 *
 * `workspaceId` is optional in the Prisma types because Aurora DSQL cannot add a
 * NOT NULL column to a populated table, so the compiler will not catch a create
 * that forgets it. This test does: every code path that creates a Solution or
 * Objective (server actions, MCP handlers, seeds, scripts, raw-SQL fixtures, tests)
 * must set `workspace_id` / `workspaceId` from a DERIVED value.
 *
 * THIS IS A LINT-GRADE TRIPWIRE, NOT PROOF. It is a textual scanner: it catches the ways a create
 * has gone missing in practice and the evasions listed below, but a determined or unusual construct
 * (a delegate passed through a function argument, code generated at runtime, a wrapper that sets the
 * field from somewhere it cannot follow) can still slip past it. The real guarantees are the read-side
 * NULL = deny paths, the tenant-isolation tests, and the migration postconditions; this only makes the
 * obvious regression loud.
 *
 * It parses the call rather than grepping a window, and it fails closed on shapes it
 * cannot verify (spreads, non-literal `data`, dynamic delegates, nested writes), which
 * forces the field to be written out where a reviewer sees it:
 *   - delegate calls are found across newlines, optional chaining (`solution?.create(`), a generic
 *     argument (`create<T>(`), destructured delegates (`const { solution } = tx`), renamed ones
 *     (`const { objective: obj } = prisma`) and aliases (`const sol = tx.solution`); `tx[model].create(...)`
 *     is rejected as unverifiable;
 *   - nested writes (`data: { solutions: { create ... } }`) are rejected outright;
 *   - the `workspaceId` VALUE must be derived: not undefined/null/a literal, not a member of something
 *     named like request input (`input.workspaceId`, `args.workspaceId`, ...), and a bare identifier must
 *     be a local binding whose initialiser is an authorization/resolution call (`requireProduct*`,
 *     `assert*`, `resolve*`) or a member of an already-authorized row (`cycle.workspaceId`), so
 *     `const workspaceId = input.workspaceId` is NOT accepted;
 *   - raw SQL (in .ts, .cjs, .mts, .sh, .sql, .md, ... alike) must list `workspace_id` in the INSERT
 *     column list, INSERT ... SELECT included; an insert with no column list is rejected, and so is a
 *     dynamic table name (`INSERT INTO ${table}`);
 *   - the set of known create sites is an EXACT map, so a site the scanner cannot see
 *     fails the count instead of passing silently.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SELF = "__tests__/tenant-isolation/solution-objective-write-paths.test.ts";
// Directories never scanned: dependencies and build output only. docs/ and public/ ARE scanned (text files only).
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", ".worktrees", ".pnpm-store", "test-results", "playwright-report"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|sql|md|mdx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

// ── A tiny balanced-bracket reader (strings and template literals are skipped) ──

function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === quote) return j;
    else if (quote === "`" && text[j] === "$" && text[j + 1] === "{") j = matchClose(text, j + 1);
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

type Keys = { keys: Set<string>; hasSpread: boolean; workspaceIdExpr: string | null };

/** Top-level keys of an object literal whose `{` is at `open`, plus the expression given for workspaceId. */
function objectKeys(text: string, open: number): Keys {
  const close = matchClose(text, open);
  const body = stripComments(text.slice(open + 1, close));
  const keys = new Set<string>();
  let hasSpread = false;
  let workspaceIdExpr: string | null = null;
  let depth = 0;
  let segmentStart = 0;
  const flush = (end: number) => {
    const segment = body.slice(segmentStart, end).trim();
    if (segment.startsWith("...")) hasSpread = true;
    else {
      const m = /^(?:\[[^\]]*\]|["'`]?([A-Za-z_$][\w$]*)["'`]?)\s*(?::|$|\()/.exec(segment);
      if (m?.[1]) {
        keys.add(m[1]);
        if (m[1] === "workspaceId") workspaceIdExpr = segment.includes(":") && !/^workspaceId\s*$/.test(segment) ? segment.slice(segment.indexOf(":") + 1).trim() : "workspaceId";
      }
    }
    segmentStart = end + 1;
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(body, i); continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) flush(i);
  }
  flush(body.length);
  return { keys, hasSpread, workspaceIdExpr };
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
      let j = text.indexOf(":", i + name.length) + 1;
      while (/\s/.test(text[j])) j += 1;
      return j;
    }
  }
  return null;
}

type Verdict = string | null; // null = ok, otherwise why not

const INPUT_NAMES = /^(input|args|arg|params|param|body|data|payload|req|request|formData|parsed|fields|searchParams|query|options|opts|rest)$/;

/** Is the expression given for workspaceId derived from an authorized parent rather than raw input? */
function derivedVerdict(expr: string, text: string, callIndex: number): Verdict {
  const e = expr.trim();
  if (/^(undefined|null|void 0|""|''|``)$/.test(e)) return `workspaceId is ${e || "empty"}`;
  if (/^["'`][^"'`$]*["'`]$|^\d+$/.test(e)) return "workspaceId is a literal";
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (INPUT_NAMES.test(e)) return `workspaceId comes straight from "${e}"`;
    // A bare identifier must be a local binding whose initialiser is itself derived: the result of an
    // authorization/resolution call, or a member of an already-authorized row. A function parameter, an
    // undeclared name, or a copy of request input (`const workspaceId = input.workspaceId`) is rejected.
    const before = stripComments(text.slice(0, callIndex));
    const declaration = new RegExp(String.raw`\b(?:const|let|var)\s+(?:\{[^}]*\b${e}\b[^}]*\}|${e})\s*(?::[^=]+)?=\s*([^;\n]+)`, "g");
    let init: string | null = null;
    for (const m of before.matchAll(declaration)) init = m[1];
    if (init === null) return `workspaceId "${e}" is not derived locally (a function parameter or an undeclared name)`;
    return initialiserVerdict(init.trim(), e);
  }
  const root = /^([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|\[)/.exec(e)?.[1];
  if (root && INPUT_NAMES.test(root)) return `workspaceId comes straight from "${root}"`;
  return null;
}

/** Is the right-hand side of `const workspaceId = <init>` an authorized derivation? */
function initialiserVerdict(init: string, name: string): Verdict {
  const awaited = init.replace(/^await\s+/, "");
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(awaited)?.[1];
  if (call) {
    const callee = call.split(".").pop()!;
    return /^(require[A-Z]\w*|assert[A-Z]\w*|resolve[A-Z]\w*)$/.test(callee) ? null : `workspaceId "${name}" comes from ${callee}(...), which is not a recognised authorization call`;
  }
  const root = /^([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|\[)/.exec(awaited)?.[1];
  if (root) return INPUT_NAMES.test(root) ? `workspaceId "${name}" is copied from "${root}"` : null;
  return `workspaceId "${name}" is initialised from an expression that cannot be verified`;
}

function checkObjectLiteral(text: string, at: number | null, label: string, callIndex: number): Verdict {
  if (at === null) return `${label}: not found`;
  if (text[at] !== "{") return `${label}: not an object literal (cannot verify workspaceId)`;
  const { keys, hasSpread, workspaceIdExpr } = objectKeys(text, at);
  if (hasSpread) return `${label}: uses a spread (write workspaceId out explicitly)`;
  if (!keys.has("workspaceId")) return `${label}: no top-level workspaceId`;
  const derived = derivedVerdict(workspaceIdExpr ?? "", text, callIndex);
  return derived ? `${label}: ${derived}` : null;
}

/** Verdict for one delegate create/upsert call whose `(` is at `openParen`. */
export function checkPrismaCall(text: string, op: string, openParen: number): Verdict {
  const argStart = openParen + 1;
  const firstNonSpace = text.slice(argStart).search(/\S/) + argStart;
  if (text[firstNonSpace] !== "{") return "argument is not an object literal";
  if (op === "upsert") return checkObjectLiteral(text, valueOf(text, firstNonSpace, "create"), "upsert.create", openParen);
  const data = valueOf(text, firstNonSpace, "data");
  if (op === "create") return checkObjectLiteral(text, data, "create.data", openParen);
  // createMany / createManyAndReturn: data is an array of literals
  if (data === null) return `${op}: no data`;
  if (text[data] !== "[") return `${op}.data: not an array literal`;
  const end = matchClose(text, data);
  let i = data + 1;
  while (i < end) {
    if (text[i] === "{") {
      const v = checkObjectLiteral(text, i, `${op}.data[]`, openParen);
      if (v) return v;
      i = matchClose(text, i) + 1;
    } else i += 1;
  }
  return null;
}

const OPS = "createManyAndReturn|createMany|create|upsert";
/** Delegate calls: `.solution.create(`, `solution.create(` (destructured or aliased), across newlines. */
const DELEGATE_CALL = new RegExp(String.raw`\b(solution|objective)\s*(?:\?\.|\.)\s*(${OPS})\s*(?:<[^>()]*>)?\s*\(`, "g");
/** Local names that stand for a Solution/Objective delegate: `const sol = tx.solution`, `const { objective: obj } = prisma`. */
function delegateAliases(text: string): Array<{ alias: string; model: string }> {
  const out: Array<{ alias: string; model: string }> = [];
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[\w$.?]*?\.\s*(solution|objective)\s*(?=[;\n,)])/g)) out.push({ alias: m[1], model: m[2] });
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[\w$.()?\s]+/g)) {
    for (const part of m[1].split(",")) {
      const renamed = /^\s*(solution|objective)\s*:\s*(\w+)\s*$/.exec(part);
      if (renamed) out.push({ alias: renamed[2], model: renamed[1] });
    }
  }
  return out.filter(({ alias, model }) => alias !== model);
}
/** `tx[model].create(`: the delegate is not statically known, so it cannot be verified. */
const DYNAMIC_CALL = new RegExp(String.raw`\]\s*(?:\?\.|\.)\s*(${OPS})\s*(?:<[^>()]*>)?\s*\(`, "g");
/** Nested writes through a relation: `data: { solutions: { create: ... } }`. */
const NESTED_WRITE = /\b(solutions|objectives)\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert)\b/g;

export type Finding = { kind: "prisma" | "dynamic" | "nested"; label: string; verdict: Verdict };

/** Every create site in one file's text, with its verdict. */
export function scanFile(text: string): Finding[] {
  const stripped = stripComments(text);
  const findings: Finding[] = [];
  for (const m of stripped.matchAll(DELEGATE_CALL)) {
    findings.push({ kind: "prisma", label: `${m[1]}.${m[2]}`, verdict: checkPrismaCall(stripped, m[2], m.index! + m[0].length - 1) });
  }
  for (const { alias, model } of delegateAliases(stripped)) {
    const aliasCall = new RegExp(String.raw`\b${alias}\s*(?:\?\.|\.)\s*(${OPS})\s*(?:<[^>()]*>)?\s*\(`, "g");
    for (const m of stripped.matchAll(aliasCall)) findings.push({ kind: "prisma", label: `${model} (as ${alias}).${m[1]}`, verdict: checkPrismaCall(stripped, m[1], m.index! + m[0].length - 1) });
  }
  for (const m of stripped.matchAll(DYNAMIC_CALL)) {
    findings.push({ kind: "dynamic", label: `[...].${m[1]}`, verdict: "dynamic delegate: cannot verify it is not a Solution/Objective create" });
  }
  for (const m of stripped.matchAll(NESTED_WRITE)) {
    findings.push({ kind: "nested", label: `${m[1]}: { ${m[2]} }`, verdict: "nested write through a relation cannot be checked; create the row directly with workspaceId" });
  }
  return findings;
}

/** Verdicts for every INSERT INTO solutions/objectives in a file's text (any file type). */
export function checkRawInserts(text: string): { table: string; verdict: Verdict }[] {
  const out: { table: string; verdict: Verdict }[] = [];
  // INSERT INTO ${table} (...) : the whole table name is interpolated, so it cannot be verified to not be solutions/objectives.
  // Also the realistic evasion where only the table is dynamic after a schema-qualified prefix: INSERT INTO "${S}".${table} (...).
  // Whitespace is allowed around each dot and up to two prefix segments (db."${S}".${table}).
  for (const m of text.matchAll(/INSERT\s+INTO\s+(?:(?:"?[\w$]+"?|"?\$\{[^}]+\}"?)\s*\.\s*){0,2}"?\$\{[^}]+\}"?(?=[\s(])/gi)) out.push({ table: m[0], verdict: "dynamic table name cannot be verified" });
  for (const m of text.matchAll(/INSERT\s+INTO\s+[^\s(]*?"?(solutions|objectives)"?\s*(\(([^)]*)\))?/gi)) {
    const table = m[1];
    if (!m[2]) out.push({ table, verdict: "no column list (cannot verify workspace_id)" });
    else if (!/\bworkspace_id\b/.test(m[3])) out.push({ table, verdict: `column list has no workspace_id: (${m[3].replace(/\s+/g, " ").trim()})` });
    else out.push({ table, verdict: null });
  }
  return out;
}

// ── Canary: the checker must reject every evasion it claims to catch ─────────

describe("the write-path checker itself (canaries: a miss cannot pass vacuously)", () => {
  const bad = (src: string) => scanFile(src).filter((f) => f.verdict);
  const good = (src: string) => scanFile(src);

  it("accepts a derived workspaceId, long-form, shorthand, or a member of an authorized parent", () => {
    const ok = [
      "const { workspaceId } = await requireProductEntity('opportunity', id);\nawait tx.solution.create({ data: { workspaceId, title } })",
      "await prisma.solution.create({ data: { workspaceId: opp.workspaceId, title: t } })",
      "await prisma.objective.create({\n data: {\n // workspaceId is set below\n workspaceId: cycle.workspaceId,\n cycleId,\n },\n })",
    ];
    for (const src of ok) {
      expect(good(src)).toHaveLength(1);
      expect(bad(src)).toEqual([]);
    }
  });

  it("rejects a create that never sets it, even when 'workspaceId' appears elsewhere in the call", () => {
    for (const src of [
      "prisma.solution.create({ data: { opportunityId, title: `for ${workspaceId}` } })",
      "prisma.solution.create({ data: { opportunityId }, select: { workspaceId: true } })",
      "prisma.solution.create({ data: { title, opp: { connect: { workspaceId } } } })",
      "prisma.solution.create({ data: { title } }) /* workspaceId */",
      "prisma.solution.create({ data: { title } }) // workspaceId: x",
    ]) expect(bad(src)[0]?.verdict).toMatch(/no top-level workspaceId/);
  });

  it("finds calls split across lines, with whitespace before the dot or paren", () => {
    expect(bad("prisma\n  .solution\n  .create\n  (\n{ data: { title } })")).toHaveLength(1);
    expect(bad("prisma.objective.\n  create(\n{ data: { title } })")).toHaveLength(1);
  });

  it("finds destructured delegates", () => {
    expect(bad("const { solution } = tx;\nawait solution.create({ data: { title } })")).toHaveLength(1);
  });

  it("finds renamed and aliased delegates (the alias is followed, not just the model name)", () => {
    expect(bad("const { objective: obj } = prisma\nawait obj.create({ data: { title } })")[0]?.label).toBe("objective (as obj).create");
    expect(bad("const { solution: sol, other } = tx\nawait sol.createMany({ data: [{ title }] })")[0]?.label).toBe("solution (as sol).createMany");
    expect(bad("const sol = tx.solution;\nawait sol.create({ data: { title } })")[0]?.label).toBe("solution (as sol).create");
    expect(bad("const obj = this.prisma?.objective\nawait obj?.upsert({ where, update: {}, create: { title } })")[0]?.label).toBe("objective (as obj).upsert");
    // and an aliased create that does set a derived workspaceId is fine
    expect(bad("const { workspaceId } = await requireProductEntity('x', 'y');\nconst sol = tx.solution;\nawait sol.create({ data: { workspaceId, title } })")).toEqual([]);
  });

  it("finds optional chaining and a generic argument", () => {
    expect(bad("await tx.solution?.create({ data: { title } })")).toHaveLength(1);
    expect(bad("await prisma.objective.create<Prisma.ObjectiveCreateArgs>({ data: { title } })")).toHaveLength(1);
    expect(bad("await prisma.solution?.createMany<X>({ data: [{ title }] })")).toHaveLength(1);
    expect(bad("await prisma.objective?.create<X>({ data: { workspaceId: cycle.workspaceId } })")).toEqual([]);
  });

  it("rejects dynamic delegates it cannot verify", () => {
    expect(bad("await tx[model].create({ data: { workspaceId, title } })")[0]?.kind).toBe("dynamic");
    expect(bad("await db['solution'].upsert({ where, update, create: { workspaceId } })")[0]?.kind).toBe("dynamic");
  });

  it("rejects nested writes through a relation", () => {
    expect(bad("prisma.opportunity.create({ data: { workspaceId, solutions: { create: { title } } } })").map((f) => f.kind)).toContain("nested");
    expect(bad("prisma.okrCycle.create({ data: { workspaceId, objectives: { createMany: { data: [] } } } })").map((f) => f.kind)).toContain("nested");
  });

  it("rejects a workspaceId that is not derived: undefined, null, literals, raw input", () => {
    for (const [expr, why] of [
      ["undefined", /undefined/], ["null", /null/], ["''", /workspaceId is ''/], ["'ws-1'", /literal/],
      ["input.workspaceId", /straight from "input"/], ["args.workspaceId", /straight from "args"/], ["body?.workspaceId", /straight from "body"/],
    ] as const) {
      expect(bad(`prisma.solution.create({ data: { workspaceId: ${expr}, title } })`)[0]?.verdict, expr).toMatch(why);
    }
  });

  it("rejects a bare identifier that is only a function parameter, accepts one bound locally", () => {
    expect(bad("async function f(workspaceId: string) {\n await prisma.solution.create({ data: { workspaceId, title } })\n}")[0]?.verdict).toMatch(/not derived locally/);
    expect(bad("async function f() {\n const { workspaceId } = await requireProductEntity('x', 'y');\n await prisma.solution.create({ data: { workspaceId, title } })\n}")).toEqual([]);
    expect(bad("async function f() {\n const workspaceId = cycle.workspaceId;\n await prisma.solution.create({ data: { workspaceId, title } })\n}")).toEqual([]);
  });

  it("does NOT accept a local that merely copies request input, or comes from an unrecognised call", () => {
    for (const init of ["input.workspaceId", "args?.workspaceId", "body['workspaceId']", "data.workspaceId"]) {
      const src = `async function f(input) {\n const workspaceId = ${init};\n await prisma.solution.create({ data: { workspaceId, title } })\n}`;
      expect(bad(src)[0]?.verdict, init).toMatch(/copied from/);
    }
    expect(bad("async function f(input) {\n const workspaceId = await getWorkspaceId(input);\n await prisma.solution.create({ data: { workspaceId, title } })\n}")[0]?.verdict).toMatch(/not a recognised authorization call/);
    expect(bad("async function f(input) {\n const { workspaceId } = parse(input);\n await prisma.solution.create({ data: { workspaceId, title } })\n}")[0]?.verdict).toMatch(/not a recognised authorization call/);
    expect(bad("async function f() {\n const workspaceId = 'ws-1';\n await prisma.solution.create({ data: { workspaceId, title } })\n}")[0]?.verdict).toMatch(/cannot be verified/);
  });

  it("rejects unverifiable shapes: spread and non-literal data", () => {
    expect(bad("prisma.solution.create({ data: { ...fields, title } })")[0]?.verdict).toMatch(/spread/);
    expect(bad("prisma.solution.create({ data: payload })")[0]?.verdict).toMatch(/not an object literal/);
    expect(bad("prisma.solution.create(args)")[0]?.verdict).toMatch(/not an object literal/);
  });

  it("checks upsert's create branch and every createMany element", () => {
    expect(bad("prisma.solution.upsert({ where: { id }, update: { workspaceId }, create: { title } })")[0]?.verdict).toMatch(/no top-level workspaceId/);
    expect(bad("const { workspaceId } = await requireProductEntity('x','y');\nprisma.solution.upsert({ where: { id }, update: {}, create: { workspaceId, title } })")).toEqual([]);
    expect(bad("prisma.solution.createMany({ data: [{ workspaceId: a.workspaceId, title }, { title }] })")[0]?.verdict).toMatch(/no top-level workspaceId/);
    expect(bad("prisma.solution.createMany({ data: [{ workspaceId: a.workspaceId, title }, { workspaceId: b.workspaceId, title }] })")).toEqual([]);
  });

  it("checks raw INSERTs through their column list, INSERT ... SELECT included, in any file type, and rejects a missing list", () => {
    const verdicts = (t: string) => checkRawInserts(t).map((r) => r.verdict);
    expect(verdicts("INSERT INTO s.solutions (id, workspace_id, title) VALUES ($1,$2,$3)")).toEqual([null]);
    expect(verdicts('INSERT INTO "${S}".objectives (id, workspace_id, cycle_id) SELECT gen_random_uuid(), w, c FROM x')).toEqual([null]);
    expect(verdicts("INSERT INTO s.solutions (id, title) SELECT id, title FROM legacy WHERE workspace_id = 1")[0]).toMatch(/no workspace_id/);
    expect(verdicts("```sql\nINSERT INTO objectives SELECT * FROM legacy;\n```")[0]).toMatch(/no column list/);
    // a dynamic table name cannot be shown not to be solutions/objectives
    expect(verdicts("await pool.query(`INSERT INTO ${table} (id, workspace_id) VALUES ($1, $2)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO \"${S}\" (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    // the realistic evasion: a schema-qualified prefix with a dynamic table after it
    expect(verdicts("await pool.query(`INSERT INTO \"${S}\".${table} (id, workspace_id) VALUES ($1, $2)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO ${schema}.${table} (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO public.${table} (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO db.\"${S}\".${table} (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO \"${S}\" . ${table} (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    expect(verdicts("await pool.query(`INSERT INTO public\n  .\n  ${table} (id) VALUES ($1)`)")[0]).toMatch(/dynamic table name/);
    // ...but a schema-qualified literal table is checked normally
    expect(verdicts("await pool.query(`INSERT INTO \"${S}\".solutions (id, workspace_id) VALUES ($1, $2)`)")).toEqual([null]);
    expect(verdicts("INSERT INTO ${S}.objectives (id, workspace_id) VALUES ($1, $2)")).toEqual([null]);
    expect(verdicts("-- migration\nINSERT INTO solutions (id, opportunity_id) VALUES (1, 2);")[0]).toMatch(/no workspace_id/);
  });
});

// ── The repository ───────────────────────────────────────────────────────────

const files = walk(ROOT)
  .map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(file, "utf-8") }))
  .filter(({ file }) => file !== SELF);

/**
 * Exact, reviewed inventory of Solution/Objective create sites. A new or renamed site the scanner finds (or
 * fails to find) changes these numbers and fails the test, so the inventory can only change on purpose.
 */
const KNOWN_PRISMA_CREATE_SITES: Record<string, number> = {
  "__tests__/preview-automation-qa/postgres-integration.test.ts": 1,
  "__tests__/typed-link-tables-migration.integration.test.ts": 2, // objective + solution in the old-client CRUD check; both set a workspaceId derived from the created rows
  "app/[orgSlug]/[workspaceSlug]/discovery/actions.ts": 1,
  "app/[orgSlug]/[workspaceSlug]/okrs/actions.ts": 1,
  "app/api/mcp/route.ts": 2,
  "e2e/functional/specs/decisions.spec.ts": 1,
  "e2e/functional/specs/pm-interview.spec.ts": 1,
};
const KNOWN_RAW_INSERT_SITES: Record<string, number> = {
  "__tests__/workspace-id-on-solution-objective-migration.integration.test.ts": 12,
  "__tests__/typed-link-tables-migration.integration.test.ts": 3, // objectives: one before 068 exists (allow-listed below), two listing workspace_id
  "__tests__/typed-links-residual-migration.integration.test.ts": 1, // objectives, listing workspace_id (068 is applied first)
  "__tests__/typed-links-race.integration.test.ts": 2, // one objective and one solution, each listing workspace_id
  // INSERT INTO ${ownerTable}: the managed-pilot ownership table (see DYNAMIC_INSERT_ALLOWED); counted so a second one is noticed.
  "lib/preview-automation/managed-migrations.ts": 1,
  "e2e/functional/fixtures/seed-e2e.ts": 2,
  "e2e/functional/specs/kanban-mobile-scroll.spec.ts": 2, // 1 literal solutions insert + 1 allow-listed dynamic (board.table)
  "e2e/functional/specs/markdown-description.spec.ts": 1, // allow-listed dynamic (kind)
  "e2e/functional/specs/opportunity-composer.spec.ts": 1,
  "e2e/functional/specs/opportunity-detail.spec.ts": 1,
  "e2e/functional/specs/opportunity-relationships.spec.ts": 1,
  "e2e/functional/specs/typed-links.spec.ts": 1, // objectives for the typed-link fixture, listing workspace_id
  "scripts/seed-canvas-scale.ts": 2,
  "scripts/verify-managed-pilot-migrations.ts": 1, // allow-listed dynamic (sentinel table)
  "seed-screenshots.ts": 2,
};
/** Creates that deliberately leave workspaceId unset. Each must carry the marker comment at the site. */
const INTENTIONAL_NULL_CREATES: Record<string, string> = {
  "__tests__/preview-automation-qa/postgres-integration.test.ts": "exercises the NULL-workspaceId arm of preview cleanup on purpose",
};
/** Raw inserts that deliberately omit workspace_id (they simulate rows written by pre-068 code). Same marker rule. */
const INTENTIONAL_NULL_RAW_INSERTS: Record<string, string> = {
  "__tests__/typed-link-tables-migration.integration.test.ts": "inserts objectives before 068 has added the column, so 068's backfill has pre-068 rows to fill",
  "__tests__/workspace-id-on-solution-objective-migration.integration.test.ts": "simulates pre-068 rows and late rows inserted by old instances so the backfill has something to fill",
};
/** Dynamic-table inserts that are reviewed and known not to target solutions/objectives. Matched by file AND the exact interpolated name. */
const DYNAMIC_INSERT_ALLOWED: Record<string, Array<{ name: string; reason: string }>> = {
  "lib/preview-automation/managed-migrations.ts": [{ name: "${ownerTable}", reason: "the managed-pilot ownership table, resolved by table(context); never solutions or objectives" }],
  "e2e/functional/specs/kanban-mobile-scroll.spec.ts": [{ name: "${board.table}", reason: "board.table comes from a fixed list: tasks, opportunities, experiments, roadmap_items" }],
  "e2e/functional/specs/markdown-description.spec.ts": [{ name: "compass_dev.${kind}", reason: "kind is typed to 'opportunities' | 'tasks' | 'roadmap_items'" }],
  "scripts/verify-managed-pilot-migrations.ts": [{ name: "${table}", reason: "table comes from a fixed list of synthetic OAuth sentinel tables" }],
};
const INTENTIONAL_MARKER = "INTENTIONAL NULL workspaceId";

const tally = (rows: Array<{ file: string }>) => {
  const out: Record<string, number> = {};
  for (const { file } of rows) out[file] = (out[file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

describe("every Solution and Objective create sets workspaceId", () => {
  const findings = files.flatMap(({ file, text }) => scanFile(text).map((f) => ({ file, ...f })));

  it("the inventory of Prisma create sites is exactly the reviewed one", () => {
    expect(tally(findings.filter((f) => f.kind === "prisma"))).toEqual(KNOWN_PRISMA_CREATE_SITES);
  });

  it("no dynamic-delegate or nested-relation create exists", () => {
    expect(findings.filter((f) => f.kind !== "prisma").map((f) => `${f.file}: ${f.label}`)).toEqual([]);
  });

  it("every Prisma create sets a derived, top-level workspaceId (or is an explicitly marked NULL exercise)", () => {
    const offenders: string[] = [];
    for (const f of findings.filter((x) => x.kind === "prisma" && x.verdict)) {
      const allowed = INTENTIONAL_NULL_CREATES[f.file];
      const marked = allowed && files.find((x) => x.file === f.file)!.text.includes(INTENTIONAL_MARKER);
      if (!marked) offenders.push(`${f.file}: ${f.label}: ${f.verdict}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the intentional NULL allow-list is marked at its site and covers nothing else", () => {
    for (const file of Object.keys(INTENTIONAL_NULL_CREATES)) {
      expect(files.find((x) => x.file === file)!.text, file).toContain(INTENTIONAL_MARKER);
      // Only the marked create may be unverified in that file.
      expect(findings.filter((f) => f.file === file && f.verdict)).toHaveLength(1);
    }
  });

  const raw = files.flatMap(({ file, text }) => checkRawInserts(text).map((r) => ({ file, ...r })));

  it("the inventory of raw-SQL insert sites is exactly the reviewed one", () => {
    expect(tally(raw)).toEqual(KNOWN_RAW_INSERT_SITES);
  });

  it("raw-SQL inserts (seeds, fixtures, .sql, .md) list workspace_id, except explicitly marked simulations of pre-068 rows", () => {
    const offenders = raw
      .filter((r) => r.verdict)
      .filter((r) => !(INTENTIONAL_NULL_RAW_INSERTS[r.file] && files.find((x) => x.file === r.file)!.text.includes(INTENTIONAL_MARKER)))
      .filter((r) => !(DYNAMIC_INSERT_ALLOWED[r.file] ?? []).some((allowed) => r.verdict === "dynamic table name cannot be verified" && r.table.includes(allowed.name)))
      .map((r) => `${r.file}: INSERT INTO ${r.table}: ${r.verdict}`);
    expect(offenders).toEqual([]);
    for (const file of Object.keys(INTENTIONAL_NULL_RAW_INSERTS)) expect(files.find((x) => x.file === file)!.text, file).toContain(INTENTIONAL_MARKER);
  });
});

describe("no authorization or scoping path reads the parent chain for a Solution or Objective", () => {
  const allowed = new Set([
    // Legacy 046 shared-comments backfill: SQL that may run on schemas that predate migration 068.
    "lib/shared-comments-backfill.ts",
    // The 068/069 backfill itself derives from the parent by definition.
    "lib/migrations/workspace-id-on-solution-objective.ts",
    // Teardown reaches un-backfilled rows through the parent, only while their own workspaceId is NULL.
    "lib/delete-workspace-cascade.ts",
    "app/[orgSlug]/[workspaceSlug]/settings/actions.ts",
    // Deliberately exercises the NULL arm (see INTENTIONAL_NULL_CREATES).
    "__tests__/preview-automation-qa/postgres-integration.test.ts",
  ]);

  /** Text of each balanced `(...)` / `{...}` body that starts right after `marker`. */
  function bodiesAfter(text: string, marker: RegExp, open: "(" | "{"): string[] {
    const bodies: string[] = [];
    for (const m of text.matchAll(marker)) {
      const at = text.indexOf(open, m.index! + m[0].length - 1);
      if (at >= 0) bodies.push(text.slice(at, matchClose(text, at) + 1));
    }
    return bodies;
  }

  const PARENT_CHAIN: Record<"solution" | "objective", RegExp[]> = {
    solution: [
      /\bopportunity\s*:\s*\{\s*workspaceId/,
      /\bopportunity\s*:\s*\{\s*select\s*:\s*\{[^}]*\bworkspaceId/,
      /\bopportunity\s*:\s*\{\s*workspace\s*:/,
      /\bopportunity\s*:\s*\{\s*select\s*:\s*\{[^}]*\bworkspace\s*:/,
    ],
    objective: [
      /\bcycle\s*:\s*\{\s*workspaceId/,
      /\bcycle\s*:\s*\{\s*select\s*:\s*\{[^}]*\bworkspaceId/,
      /\bcycle\s*:\s*\{\s*workspace\s*:/,
      /\bcycle\s*:\s*\{\s*select\s*:\s*\{[^}]*\bworkspace\s*:/,
    ],
  };

  /** Every place in `text` where a Solution/Objective is being selected or filtered, with the parent-chain patterns it must not contain. */
  function parentChainHits(text: string): string[] {
    const stripped = stripComments(text);
    const hits: string[] = [];
    for (const model of ["solution", "objective"] as const) {
      const bodies = [
        // delegate calls: prisma.solution.findFirst({ ... })
        ...bodiesAfter(stripped, new RegExp(String.raw`\.\s*${model}\s*\.\s*\w+\s*\(`, "g"), "("),
        // relation selections / filters: assumption.findMany({ where: { solution: { ... } }, select: { solution: { select: { ... } } } })
        ...bodiesAfter(stripped, new RegExp(String.raw`\b${model}\s*:\s*\{`, "g"), "{"),
      ];
      for (const body of bodies) for (const pattern of PARENT_CHAIN[model]) if (pattern.test(body)) hits.push(`${model}: ${pattern}`);
    }
    if (/\.opportunity\??\.workspaceId\s*(===|!==)/.test(stripped)) hits.push("compares .opportunity.workspaceId");
    return hits;
  }

  it("nothing in the repository reads it (outside the explicit allow-list)", () => {
    const offenders = files.filter(({ file }) => !allowed.has(file)).flatMap(({ file, text }) => parentChainHits(text).map((h) => `${file}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it("canaries: every parent-chain form is caught", () => {
    const forms = [
      "prisma.solution.findFirst({ where: { id, opportunity: { workspaceId } } })",
      "prisma.solution.findUnique({ where: { id }, select: { opportunity: { select: { workspaceId: true } } } })",
      "prisma.solution.findFirst({ where: { id, opportunity: { workspace: { members: { some: { userId } } } } } })",
      "prisma.assumption.findUnique({ where: { id }, select: { solution: { select: { opportunity: { select: { workspaceId: true } } } } } })",
      "prisma.assumption.findMany({ where: { solution: { opportunity: { workspaceId } } } })",
      "prisma.objective.findFirst({ where: { id, cycle: { workspaceId } } })",
      "prisma.objective.findUnique({ where: { id }, select: { cycle: { select: { workspaceId: true } } } })",
      "prisma.keyResult.findUnique({ where: { id }, select: { objective: { select: { cycle: { select: { workspaceId: true } } } } } })",
      "prisma.keyResult.findMany({ where: { objective: { cycle: { workspaceId } } } })",
      "prisma.objective.findFirst({\n where: { id, cycle: { workspace: { members: { some: { userId } } } } },\n })",
      "if (solution.opportunity.workspaceId === workspaceId) {}",
    ];
    for (const src of forms) expect(parentChainHits(src), src).not.toEqual([]);
  });

  it("canaries: legitimate parent lookups on OTHER models are not flagged", () => {
    const fine = [
      "prisma.opportunityScore.findUnique({ where: { id }, select: { opportunity: { select: { workspaceId: true } } } })",
      "prisma.opportunity.findFirst({ where: { id, workspaceId } })",
      "prisma.objective.findFirst({ where: { id, workspaceId }, include: { cycle: { select: { id: true, title: true } } } })",
      "prisma.solution.findMany({ where: { workspaceId }, include: { opportunity: { select: { id: true, title: true } } } })",
    ];
    for (const src of fine) expect(parentChainHits(src), src).toEqual([]);
  });
});
