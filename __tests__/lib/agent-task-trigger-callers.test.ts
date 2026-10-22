import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import path from "node:path"

/**
 * Which code may start an agent run from an assignment is a decision, not an accident (see the header of
 * lib/agent-task-trigger.ts): only places where a signed-in PERSON assigns a task or mentions an agent. MCP and REST task
 * writes, decision follow-through, notification and following hooks, and every other automated writer of
 * `assigneeAgentId` must NOT, because their caller may itself be an agent or a service key and chained assignments would
 * start runs nobody asked for. Adding a caller here is a review-worthy change; this test makes that visible.
 */
const ALLOWED_CALLERS = [
  "app/[orgSlug]/[workspaceSlug]/tasks/actions.ts",
  "app/api/panels/entity/[type]/[id]/route.ts",
  "lib/doc-comment-tasks.ts",
]

describe("who may start a run from an assignment", () => {
  it("is only the person-driven UI paths", () => {
    const root = process.cwd()
    const files = execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx", "from \"@/lib/agent-task-trigger\"", "app", "lib", "components"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((file) => path.normalize(file))
      .sort()
    expect(files).toEqual([...ALLOWED_CALLERS].sort())
  })
})
