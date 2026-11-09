/**
 * Regression guard for the TOOL_APPROVAL list-hiding decision (FILTER OUT): every reader of ReviewRequest / DecisionRecord /
 * ReviewRevision / DecisionApplication in app, lib and components must either scope itself to one gate or exclude
 * TOOL_APPROVAL explicitly. A reader added later without either fails here, so approvals cannot leak into a generic surface
 * (inbox, lists, links, search, panels) by accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(__dirname, "..")
const READ = /\b(reviewRequest|decisionRecord|reviewRevision|decisionApplication|reviewOption)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/g
const SCOPED = /excludeToolApprovals|isToolApprovalGate|gateType:\s*(TRACKED_GATE|TOOL_APPROVAL_GATE|"TRACKED_DECISION"|"RELEASE_AUTHORIZATION")|gateType\s*[!=]==/

/** Files whose reads are deliberately unscoped, with the reason. */
const EXEMPT: Record<string, string> = {
  "lib/decision-service.ts": "recordDecision is the guarded write path itself; it refuses TOOL_APPROVAL without the channel token",
  "lib/mcp-authz.ts": "resolves only the workspace id of a referenced row for the authorization gate; returns no content",
  "lib/delete-workspace-cascade.ts": "workspace deletion must remove every row, approvals included",
  "lib/delete-workspace-decision-data.ts": "workspace deletion must remove every row, approvals included",
  "app/[orgSlug]/[workspaceSlug]/reviews/[requestId]/page.tsx": "the generic page renders approvals read-only with a link to the approval surface and no decision buttons",
  "app/[orgSlug]/[workspaceSlug]/reviews/actions.ts": "reads the revision only to refuse TOOL_APPROVAL (decideReviewAction) before any write",
  "lib/legacy-decision-repair.ts": "repairs TRACKED_DECISION rows only; refuses any other gate before writing (gateType checks after each read)",
  "lib/release-authorization.ts": "the RELEASE_AUTHORIZATION gate's own module; every decision it reads is then gate-checked",
  "lib/tracked-decisions.ts": "the TRACKED_DECISION gate's own module: reads are scoped through identityWhere/TRACKED_GATE or a tracked request, and the includeLegacy list excludes TOOL_APPROVAL (see tool-approval-surfaces.test.ts)",
  "lib/followable.ts": "REVIEW_REQUEST resolveDisplay is TRACKED_DECISION-scoped",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", "__tests__", "migrations", "workspace-export", ".git"].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".generated.ts")) out.push(full)
  }
  return out
}

describe("every ReviewRequest/Decision reader is gate-scoped or excludes TOOL_APPROVAL", () => {
  const files = ["app", "lib", "components"].flatMap((dir) => walk(join(ROOT, dir)))

  it("finds the readers it is meant to audit", () => {
    const withReads = files.filter((file) => { READ.lastIndex = 0; return READ.test(readFileSync(file, "utf8")) })
    expect(withReads.length).toBeGreaterThan(15)
  })

  it("has no unscoped reader outside the documented exemptions", () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (rel.startsWith("lib/tool-approval/") || EXEMPT[rel]) continue
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(READ)) {
        const window = text.slice(match.index, match.index + 520)
        if (!SCOPED.test(window)) offenders.push(`${rel}: ${text.slice(0, match.index).split("\n").length}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps the exemption list honest (every exempt file still exists)", () => {
    for (const rel of Object.keys(EXEMPT)) expect(() => statSync(join(ROOT, rel))).not.toThrow()
  })
})
