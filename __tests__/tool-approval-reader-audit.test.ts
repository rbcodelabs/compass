/**
 * Regression guard for the TOOL_APPROVAL list-hiding decision (FILTER OUT): every read of ReviewRequest / ReviewRevision /
 * ReviewOption / DecisionRecord / DecisionApplication in app, lib and components must carry the gate predicate INSIDE the same
 * call expression, or be a listed, count-asserted exemption with a reason.
 *
 * What counts as a read:
 *  - a delegate call (`x.reviewRequest.findMany(`, also split across lines: `tx.reviewRequest\n  .findMany(`);
 *  - a relation traversal into these models from elsewhere (`reviewRequests:` on Workspace, `authorizationDecisionRecord:`,
 *    `decisionRecord:`, `reviewRevision:`), which Prisma include/select can use to read them without a delegate call;
 *  - raw SQL against review_requests.
 * A relation hop between the review models themselves (`include: { request: true }`) is part of the enclosing delegate call, so
 * it is covered by the same-expression rule on that call.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(__dirname, "..")
const DELEGATE = /\b(reviewRequest|reviewRevision|reviewOption|decisionRecord|decisionApplication)\s*\.\s*(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g
/** Relation keys that reach the review models from NON-review models (derived from prisma/schema.prisma; asserted below). */
const FOREIGN_RELATIONS = ["reviewRequests", "authorizationDecisionRecord", "decisionRecord", "reviewRevision"]
const FOREIGN = new RegExp(`\\b(${FOREIGN_RELATIONS.join("|")})\\s*:\\s*(true|\\{)`, "g")
const RAW_SQL = /\breview_requests\b/g
/** The specific gate predicate. A bare `gateType` mention (select/compare) does not count. */
const PREDICATE = /excludeToolApprovals|gateType\s*:\s*(TRACKED_GATE|TOOL_APPROVAL_GATE|"TRACKED_DECISION"|"RELEASE_AUTHORIZATION"|\{\s*not\s*:\s*"TOOL_APPROVAL"\s*\})/

export type Site = { file: string; kind: string; line: number; expression: string }

/** Text from the opening bracket at `start` to its matching close (string/template aware enough for source scanning). */
function balanced(text: string, start: number): string {
  const open = text[start]
  const close = open === "(" ? ")" : "}"
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue }
    if (c === open) depth += 1
    else if (c === close && --depth === 0) return text.slice(start, i + 1)
  }
  return text.slice(start)
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

export function scan(file: string, text: string): Site[] {
  const sites: Site[] = []
  for (const m of text.matchAll(DELEGATE)) {
    const open = m.index! + m[0].length - 1
    sites.push({ file, kind: `${m[1]}.${m[2]}`, line: lineOf(text, m.index!), expression: balanced(text, open) })
  }
  for (const m of text.matchAll(FOREIGN)) {
    const open = m.index! + m[0].length - 1
    // `key: true` has no block; its expression is the key itself, which can carry no predicate.
    sites.push({ file, kind: `relation:${m[1]}`, line: lineOf(text, m.index!), expression: m[2] === "{" ? balanced(text, open) : m[0] })
  }
  for (const m of text.matchAll(RAW_SQL)) sites.push({ file, kind: "raw:review_requests", line: lineOf(text, m.index!), expression: "" })
  return sites
}

export const hasPredicate = (site: Site) => PREDICATE.test(site.expression)

/**
 * Reads that legitimately carry no same-expression predicate. Keyed `file :: kind`, with an EXACT expected count so a new
 * unscoped read in the same file still fails. `reason` must explain why approvals cannot leak through that read.
 */
type Exemption = { file: string; kind: string; count: number; reason: string }
const EXEMPT: Exemption[] = [
  { file: "app/[orgSlug]/[workspaceSlug]/reviews/[requestId]/page.tsx", kind: "reviewRequest.findFirst", count: 1, reason: "The generic page renders approvals deliberately: notFound() for non-admins, notice and link only for admins, no decision buttons (review-request-page.test.tsx)." },
  { file: "app/[orgSlug]/[workspaceSlug]/reviews/actions.ts", kind: "reviewRevision.findUnique", count: 1, reason: "decideReviewAction reads the revision only to refuse a TOOL_APPROVAL gate before any write (tool-approval-surfaces.test.ts)." },
  { file: "app/[orgSlug]/[workspaceSlug]/reviews/actions.ts", kind: "reviewOption.findUnique", count: 1, reason: "Runs after the TOOL_APPROVAL refusal, for the release-dispatch continuation of a non-approval gate." },
  { file: "lib/comments.ts", kind: "reviewRequest.findUnique", count: 1, reason: "Selects gateType and returns a target only when it equals TRACKED_DECISION on the next line." },
  { file: "lib/decision-service.ts", kind: "reviewRequest.findUnique", count: 1, reason: "Replay repair of request state for the decision just recorded; no content is returned." },
  { file: "lib/decision-service.ts", kind: "decisionRecord.findUnique", count: 2, reason: "recordDecision idempotency replays keyed by the caller's own idempotency key; the guarded write path itself." },
  { file: "lib/decision-service.ts", kind: "reviewRevision.findUnique", count: 1, reason: "recordDecision loads the revision, then refuses TOOL_APPROVAL without the channel token." },
  { file: "lib/decision-service.ts", kind: "decisionRecord.findFirst", count: 2, reason: "Concurrent-winner lookup inside recordDecision after the guard has already run for this revision." },
  { file: "lib/decision-tool-handlers.ts", kind: "decisionRecord.findUnique", count: 1, reason: "applyRecordedDecision reads the decision, then refuses TOOL_APPROVAL via isToolApprovalGate before applying anything." },
  { file: "lib/delete-workspace-cascade.ts", kind: "reviewRequest.findMany", count: 1, reason: "Workspace deletion must remove every row, approvals included; returns ids only to the deleter." },
  { file: "lib/delete-workspace-decision-data.ts", kind: "reviewRequest.findMany", count: 1, reason: "Workspace deletion must remove every row, approvals included." },
  { file: "lib/delete-workspace-decision-data.ts", kind: "relation:decisionRecord", count: 1, reason: "Workspace deletion scope for decision applications; deletes, never reads for display." },
  { file: "lib/delete-workspace-decision-data.ts", kind: "relation:reviewRevision", count: 1, reason: "Workspace deletion scope for evidence refs; deletes, never reads for display." },
  { file: "lib/legacy-decision-repair.ts", kind: "reviewRequest.findFirst", count: 2, reason: "Repair tool; each read is followed by a gateType !== TRACKED_DECISION refusal before any write." },
  { file: "lib/legacy-decision-repair.ts", kind: "relation:reviewRevision", count: 1, reason: "Type declaration of the repair client's query model, not a read." },
  { file: "lib/links/endpoints.ts", kind: "reviewRequest.findMany", count: 1, reason: "Rows are filtered with isToolApprovalGate(row.gateType) immediately after the read (a fake-prisma test cannot evaluate the not-operator)." },
  { file: "lib/mcp-authz.ts", kind: "reviewRequest.findUnique", count: 1, reason: "Resolves only a referenced row's workspaceId for the authorization gate; returns no content." },
  { file: "lib/mcp-authz.ts", kind: "decisionRecord.findUnique", count: 1, reason: "Resolves only a referenced row's workspaceId for the authorization gate; returns no content." },
  { file: "lib/migrations/entity-links-artifact-backfill.ts", kind: "raw:review_requests", count: 4, reason: "Registered migration SQL run only via the authenticated migrate endpoint; not a request-time reader." },
  { file: "lib/migrations/entity-links-read-parity.ts", kind: "raw:review_requests", count: 3, reason: "Registered migration SQL run only via the authenticated migrate endpoint; not a request-time reader." },
  { file: "lib/migrations/entity-links-task-backfill.ts", kind: "raw:review_requests", count: 3, reason: "Registered migration SQL run only via the authenticated migrate endpoint; not a request-time reader." },
  { file: "lib/migrations/runner.ts", kind: "raw:review_requests", count: 3, reason: "Schema/table-name lists for migration verification; not a request-time reader." },
  { file: "lib/release-authorization.ts", kind: "decisionRecord.findUnique", count: 2, reason: "The RELEASE_AUTHORIZATION module's own reads; each decision is checked against gateType RELEASE_AUTHORIZATION immediately after." },
  { file: "lib/release-authorization.ts", kind: "decisionApplication.findUnique", count: 1, reason: "Receipt lookup by this module's own release receipt key." },
  { file: "lib/tracked-decisions.ts", kind: "reviewRequest.findFirst", count: 2, reason: "Scoped through identityWhere, which carries gateType TRACKED_GATE." },
  { file: "lib/tracked-decisions.ts", kind: "reviewRequest.findUnique", count: 1, reason: "Revise path; refuses unless request.gateType === TRACKED_GATE on the next line." },
  { file: "lib/tracked-decisions.ts", kind: "decisionRecord.findUnique", count: 2, reason: "Reads a prior decision by id inside a tracked flow whose request is TRACKED_GATE-checked in the same function." },
  { file: "lib/tracked-decisions.ts", kind: "reviewRequest.findMany", count: 1, reason: "The list's `where` variable is gateType TRACKED_GATE, or excludeToolApprovals when includeLegacy (tool-approval-surfaces.test.ts asserts both)." },
  { file: "lib/tracked-decisions.ts", kind: "reviewRequest.count", count: 1, reason: "Counts with the same `where` variable as the list above." },
  { file: "lib/tracked-decisions.ts", kind: "decisionApplication.findUnique", count: 2, reason: "Receipt lookups by receipt key in applyTrackedDecision, which refuses any gate other than TRACKED_GATE." },
  { file: "lib/work-item-ids.ts", kind: "raw:review_requests", count: 1, reason: "Table-name registry for sequence allocation, not a reader." },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", "__tests__", ".git"].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".generated.ts")) out.push(full)
  }
  return out
}

const allSites = (): Site[] =>
  ["app", "lib", "components"].flatMap((dir) => walk(join(ROOT, dir))).flatMap((file) => scan(relative(ROOT, file), readFileSync(file, "utf8")))

describe("scanner", () => {
  it("sees a delegate call split across lines (the B1 shape)", () => {
    const src = "const x = [\n  tx.reviewRequest\n    .findMany({\n      where: { workspaceId },\n    })\n    .then(f),\n]"
    const [site] = scan("x.ts", src)
    expect(site).toMatchObject({ kind: "reviewRequest.findMany", line: 2 })
    expect(hasPredicate(site)).toBe(false)
  })
  it("requires the predicate inside the same call, not in a neighbouring statement", () => {
    const src = "a = tx.reviewRequest.findMany({ where: { workspaceId } })\nb = { gateType: TRACKED_GATE }\n"
    const [site] = scan("x.ts", src)
    expect(hasPredicate(site)).toBe(false)
    expect(hasPredicate(scan("x.ts", "tx.reviewRequest.findMany({ where: { workspaceId, ...excludeToolApprovals } })")[0])).toBe(true)
    expect(hasPredicate(scan("x.ts", 'tx.reviewRequest.findFirst({ where: { gateType: "TRACKED_DECISION" } })')[0])).toBe(true)
    expect(hasPredicate(scan("x.ts", "tx.reviewRequest.findFirst({ select: { gateType: true } })")[0])).toBe(false)
  })
  it("sees relation traversals and raw SQL", () => {
    expect(scan("x.ts", "workspace.findMany({ include: { reviewRequests: true } })").map((s) => s.kind)).toEqual(["relation:reviewRequests"])
    expect(scan("x.ts", 'sql`select * from review_requests`').map((s) => s.kind)).toEqual(["raw:review_requests"])
  })
  it("treats the foreign relation list as complete against the schema", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
    const review = new Set(["ReviewRequest", "ReviewRevision", "ReviewOption", "DecisionRecord", "DecisionApplication"])
    const found = new Set<string>()
    let model = ""
    for (const line of schema.split("\n")) {
      const m = /^model (\w+)/.exec(line)
      if (m) { model = m[1]; continue }
      if (line.startsWith("}")) { model = ""; continue }
      const f = /^\s+(\w+)\s+(\w+)(\?|\[\])?(\s|$)/.exec(line)
      if (model && !review.has(model) && f && review.has(f[2])) found.add(f[1])
    }
    expect([...found].sort()).toEqual([...FOREIGN_RELATIONS].sort())
  })
})

describe("every ReviewRequest/Decision read carries the gate predicate in its own call, or is an asserted exemption", () => {
  const sites = allSites()

  it("finds the reads it is meant to audit", () => {
    expect(sites.filter((s) => s.kind.startsWith("reviewRequest.")).length).toBeGreaterThan(20)
  })

  it("has no unscoped read outside the exemptions", () => {
    const exempt = new Set(EXEMPT.map((e) => `${e.file} :: ${e.kind}`))
    const offenders = sites
      .filter((s) => !s.file.startsWith("lib/tool-approval/"))
      .filter((s) => !exempt.has(`${s.file} :: ${s.kind}`))
      .filter((s) => !hasPredicate(s))
      .map((s) => `${s.file}:${s.line} ${s.kind}`)
    expect(offenders).toEqual([])
  })

  it("keeps the exemptions exact: no stale entry, and no extra unscoped read hiding in an exempt file", () => {
    const mismatches = EXEMPT.flatMap((e) => {
      const n = sites.filter((s) => s.file === e.file && s.kind === e.kind && !hasPredicate(s)).length
      return n === e.count && e.reason.length > 20 ? [] : [`${e.file} :: ${e.kind}: expected ${e.count}, found ${n}`]
    })
    expect(mismatches).toEqual([])
  })
})
