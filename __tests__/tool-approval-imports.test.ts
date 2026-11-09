/**
 * Static access control for the three capabilities that make a tool approval take effect. A file that imports one without being
 * listed here fails the build, so a new route cannot start deciding or executing approvals by accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full)
  }
  return out
}
const files = ["app", "lib", "components", "scripts", "__tests__"].filter((d) => { try { return statSync(join(ROOT, d)).isDirectory() } catch { return false } })
  .flatMap((d) => walk(join(ROOT, d))).map((f) => ({ rel: relative(ROOT, f), text: readFileSync(f, "utf8") }))
const mentioning = (re: RegExp, ignore: (rel: string) => boolean = () => false) => files.filter((f) => re.test(f.text) && !ignore(f.rel) && f.rel !== "__tests__/tool-approval-imports.test.ts").map((f) => f.rel)
const isTest = (rel: string) => rel.startsWith("__tests__/")
const approvalRoute = (rel: string) => /^app\/\[orgSlug\]\/\[workspaceSlug\]\/approvals\//.test(rel)

describe("who may use the approval capabilities", () => {
  it("only decide.ts (and the module that defines it) names the decision channel token in production code", () => {
    expect(mentioning(/TOOL_APPROVAL_DECISION_CHANNEL/, (rel) => isTest(rel) || rel === "lib/tool-approval/channel.ts")).toEqual(["lib/tool-approval/decide.ts"])
  })
  it("nothing re-exports the channel module", () => {
    expect(mentioning(/tool-approval\/channel/, (rel) => isTest(rel))).toEqual(["lib/decision-service.ts", "lib/tool-approval/decide.ts"])
  })
  it("only tests and the approval route may use decideToolApproval", () => {
    expect(mentioning(/\bdecideToolApproval\b/, (rel) => isTest(rel) || approvalRoute(rel) || rel === "lib/tool-approval/decide.ts")).toEqual([])
  })
  it("only decide.ts, tests and the approval route may use executeApprovedToolCall", () => {
    expect(mentioning(/\bexecuteApprovedToolCall\b/, (rel) => isTest(rel) || approvalRoute(rel) || rel === "lib/tool-approval/decide.ts" || rel === "lib/tool-approval/executor.ts")).toEqual([])
  })
})
