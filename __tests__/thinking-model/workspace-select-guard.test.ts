import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/**
 * TRIPWIRE, not a proof. Keeps the deploy-order list in PR #339 from rotting.
 *
 * Declaring thinkingModel / thinkingModelLabels on the Prisma Workspace model makes
 * Prisma include both columns in every workspace read or write that does not pass a
 * `select` (and in every `include: { workspace: ... }` / `workspace: true`). Until
 * migration 073 is applied on a schema, each such site fails there with P2022.
 *
 * This scans app/, lib/, components/, scripts/ and root-level .ts files for
 *   - prisma.workspace.{find*, create, update, upsert, delete}(...) with no `select:`
 *   - a relation load of a workspace via `workspace: true`, `workspace: { include`
 *     or `workspaces: true`
 * and requires the set of sites to EQUAL the list below. A new site fails the test
 * until someone either adds a `select` or consciously adds it here (and to the PR
 * banner); a fixed site fails it until removed from the list. It is a heuristic text
 * scan: it does not parse TypeScript, cannot see calls built dynamically, and a
 * `select` appearing anywhere in the call text counts as satisfied.
 *
 * Counts are per file, so reformatting does not break the list.
 */

const ROOT = process.cwd()
const SCAN_DIRS = ["app", "lib", "components", "scripts"]
const SKIP = new Set(["node_modules", ".next", ".claude", ".worktrees", "__tests__", "e2e", ".pnpm-store"])

/** Every site that fails before 073 is applied. Update together with the PR banner. */
export const SELECTLESS_WORKSPACE_SITES: Record<string, number> = {
  "app/[orgSlug]/[workspaceSlug]/canvas/page.tsx": 1,
  "app/[orgSlug]/[workspaceSlug]/okrs/[cycleId]/page.tsx": 1,
  "app/[orgSlug]/[workspaceSlug]/okrs/page.tsx": 1,
  "app/[orgSlug]/[workspaceSlug]/reviews/[requestId]/page.tsx": 1,
  "app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx": 1,
  "app/[orgSlug]/[workspaceSlug]/settings/actions.ts": 6,
  "app/[orgSlug]/[workspaceSlug]/settings/feedback-source-actions.ts": 1,
  "app/api/admin/portal-sso-resync/route.ts": 1,
  "app/dashboard/page.tsx": 1,
  "app/onboarding/actions.ts": 1,
  "lib/delete-workspace-cascade.ts": 1,
  "lib/preview-automation/service.ts": 1,
  "lib/preview-login.ts": 2,
  "lib/workspace-service.ts": 1,
  "lib/workspace.ts": 2,
  // Dev/ops scripts, run by hand; see the PR for whether any runs against a shared schema.
  "scripts/seed-card-sort-demo.ts": 2,
  "scripts/verify-geode-document-migration.ts": 1,
  "scripts/verify-geode-documents.ts": 1,
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return []
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mjs)$/.test(entry) ? [full] : []
  })
}

/** Text of the call starting at the "(" at `open`, via bracket matching. */
function callText(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++
    else if (source[i] === ")" && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

export function selectlessWorkspaceSites(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1")
  let count = 0
  for (const m of code.matchAll(/\.workspace\.(?:findFirst|findUnique|findMany|findFirstOrThrow|findUniqueOrThrow|create|createManyAndReturn|update|upsert|delete)\(/g)) {
    const text = callText(code, m.index! + m[0].length - 1)
    if (!/\bselect\s*:/.test(text)) count++
  }
  count += [...code.matchAll(/\bworkspaces?\s*:\s*(?:true\b|\{\s*include\b)/g)].length
  return count
}

describe("workspace reads that break before migration 073 (tripwire)", () => {
  it("the set of select-less workspace sites equals the documented list", () => {
    const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...readdirSync(ROOT).filter((f) => /\.ts$/.test(f)).map((f) => path.join(ROOT, f))]
    expect(files.length).toBeGreaterThan(300)
    const found: Record<string, number> = {}
    for (const file of files) {
      const n = selectlessWorkspaceSites(readFileSync(file, "utf-8"))
      if (n > 0) found[path.relative(ROOT, file)] = n
    }
    expect(found).toEqual(SELECTLESS_WORKSPACE_SITES)
  })

  it("canary: the detector flags select-less calls and accepts selected ones", () => {
    expect(selectlessWorkspaceSites("await prisma.workspace.findFirst({ where: { id } })")).toBe(1)
    expect(selectlessWorkspaceSites("await prisma.workspace.update({ where: { id }, data: { name } })")).toBe(1)
    expect(selectlessWorkspaceSites("await getPrisma().workspace.findMany({ include: { organization: true } })")).toBe(1)
    expect(selectlessWorkspaceSites("include: { workspace: true }")).toBe(1)
    expect(selectlessWorkspaceSites("include: { workspace: { include: { organization: true } } }")).toBe(1)
    expect(selectlessWorkspaceSites("await prisma.workspace.findFirst({ where: { id }, select: { id: true } })")).toBe(0)
    expect(selectlessWorkspaceSites("await prisma.workspace.update({ where: { id }, data: {}, select: { id: true } })")).toBe(0)
    expect(selectlessWorkspaceSites("await prisma.workspace.count({ where: { id } })")).toBe(0)
    expect(selectlessWorkspaceSites("// prisma.workspace.findFirst({})")).toBe(0)
    expect(selectlessWorkspaceSites("select: { workspace: { select: { id: true } } }")).toBe(0)
  })
})
