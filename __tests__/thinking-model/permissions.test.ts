import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { canChangeThinkingModel } from "@/lib/thinking-model/permissions"

/**
 * The Settings form is offered only to people updateThinkingModel will accept (resolveWorkspaceAdmin): a real workspace
 * membership, and then workspace ADMIN or org owner/admin. The rows mirror the tenant fake used by
 * __tests__/actions/thinking-model-authorization.test.ts.
 */
describe("canChangeThinkingModel", () => {
  it.each([
    ["workspace admin (carol)", "ADMIN", "MEMBER", true],
    ["org admin who is also a workspace member (dave)", "MEMBER", "ADMIN", true],
    ["org owner who is a member", "MEMBER", "OWNER", true],
    ["lowercase stored roles are normalized", "admin", "member", true],
    ["plain workspace member (alice)", "MEMBER", "MEMBER", false],
    ["org admin who is NOT a workspace member, read-only fallback (gina)", undefined, "ADMIN", false],
    ["org admin with a null workspace role", null, "OWNER", false],
    ["read-only org member (frank)", undefined, "MEMBER", false],
    ["no roles at all", undefined, undefined, false],
  ] as const)("%s", (_name, workspaceRole, orgRole, expected) => {
    expect(canChangeThinkingModel({ workspaceRole, orgRole })).toBe(expected)
  })

  it("the Settings page shows the form only through this predicate, not through canManageCapabilityPacks", () => {
    const page = readFileSync(path.join(process.cwd(), "app/[orgSlug]/[workspaceSlug]/settings/page.tsx"), "utf-8")
    expect(page).toContain("canChangeThinkingModel({ workspaceRole: currentWorkspaceRole")
    const before = page.slice(0, page.indexOf("<ThinkingModelPanel"))
    const gate = before.slice(before.lastIndexOf("{canEditThinkingModel"))
    expect(gate).toContain("{canEditThinkingModel && (")
    expect(gate).not.toContain("canManageCapabilityPacks")
  })
})
