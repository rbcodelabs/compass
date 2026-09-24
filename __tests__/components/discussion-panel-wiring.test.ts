import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panels = [
  ["objective-panel.tsx", "OBJECTIVE"], ["key-result-panel.tsx", "KEY_RESULT"],
  ["solution-panel.tsx", "SOLUTION"],
  ["assumption-panel.tsx", "ASSUMPTION"], ["experiment-panel.tsx", "EXPERIMENT"],
  ["roadmap-item-panel.tsx", "ROADMAP_ITEM"], ["feedback-panel.tsx", "FEEDBACK_ITEM"],
] as const

describe("entity panel discussion wiring", () => {
  it("connects the shared opportunity detail to its discussion", () => {
    const source = readFileSync(new URL("../../components/discovery/opportunity-detail.tsx", import.meta.url), "utf8")
    expect(source).toContain('<Discussion targetType="OPPORTUNITY" targetId={opportunityId} />')
  })
  it("connects Task detail to its own TASK discussion", () => {
    // TaskDetail is the shared "one component, two mount points" body (the
    // panel sidebar and the standalone page both render it) — same place
    // every other entity type wires up its Discussion, not the page route.
    const source = readFileSync(new URL("../../components/tasks/task-detail.tsx", import.meta.url), "utf8")
    expect(source).toContain('import { Discussion } from "@/components/comments/discussion"')
    expect(source).toContain('<Discussion targetType="TASK" targetId={taskId} />')
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
