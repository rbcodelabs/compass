import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panels = [
  ["objective-panel.tsx", "OBJECTIVE"], ["key-result-panel.tsx", "KEY_RESULT"],
  ["opportunity-panel.tsx", "OPPORTUNITY"], ["solution-panel.tsx", "SOLUTION"],
  ["assumption-panel.tsx", "ASSUMPTION"], ["experiment-panel.tsx", "EXPERIMENT"],
  ["roadmap-item-panel.tsx", "ROADMAP_ITEM"], ["feedback-panel.tsx", "FEEDBACK_ITEM"],
] as const

describe("entity panel discussion wiring", () => {
  it("connects Task detail to its own TASK discussion", () => {
    const source = readFileSync(new URL("../../app/[orgSlug]/[workspaceSlug]/tasks/[taskId]/page.tsx", import.meta.url), "utf8")
    expect(source).toContain('<Discussion targetType="TASK" targetId={task.id} />')
  })

  it.each(panels)("wires %s to %s", (filename, targetType) => {
    const source = readFileSync(new URL(`../../components/panels/${filename}`, import.meta.url), "utf8")
    expect(source).toContain('import { Discussion } from "@/components/comments/discussion"')
    expect(source).toContain(`<Discussion targetType="${targetType}"`)
  })

  it("keeps Solution plans specialized while ordinary comments use Discussion", () => {
    const panel = readFileSync(new URL("../../components/panels/solution-panel.tsx", import.meta.url), "utf8")
    const plans = readFileSync(new URL("../../components/panels/solution-plan-discussion.tsx", import.meta.url), "utf8")
    expect(panel).toContain("<SolutionPlanDiscussion")
    expect(panel).toContain('<Discussion targetType="SOLUTION"')
    expect(plans).toContain('filter((comment) => comment.commentType === "PLAN")')
    expect(plans).not.toContain('<SelectItem value="COMMENT">')
  })
})
