import type { AppPrismaClient } from "@/lib/db"
import type { Json } from "@/lib/tool-approval/packet"

/** What a tool's callbacks may rely on. `prisma` is the application client; never a transaction. */
export type ToolApprovalContext = {
  workspaceId: string
  prisma: AppPrismaClient
  requestedByUserId: string | null
  requestedByAgentId: string | null
}

/** Context for `execute`: who approved and which rows authorise this run. Taken from the database, never from a caller. */
export type ToolApprovalExecuteContext = ToolApprovalContext & {
  approverUserId: string
  decisionId: string
  requestId: string
}

export type ToolApprovalArgs = Record<string, unknown>

/**
 * How one MCP tool opts in to human approval. Contract:
 *
 * - `describe`      pure, human-readable title (<= 255 chars, clipped) and summary shown on the approval page.
 * - `readBefore`    reads the CURRENT state the call would change, live from the database. It is re-run at execution time and
 *                   must deep-equal the approved packet's `before`, otherwise nothing runs (STALE).
 * - `computeAfter`  pure: the state the call would leave behind, shown next to `before`. Not trusted at execution time.
 * - `floors`        optional hard limits. Any returned reason blocks the call, at request time and again at execution time,
 *                   no matter who approved it.
 * - `execute`       performs the real write: the same code path the tool's handler used before it opted in. Runs only from
 *                   executeApprovedToolCall, as the approving admin, after every re-verification passes.
 *
 * All values crossing the boundary must be JSON-serialisable.
 */
export type ToolApprovalSpec = {
  toolName: string
  /** Stable capability label, e.g. "workspace.github_repos". Bound into the packet; a change invalidates old approvals. */
  capabilityClass: string
  describe(args: ToolApprovalArgs, ctx: ToolApprovalContext): { title: string; summary: string }
  readBefore(args: ToolApprovalArgs, ctx: ToolApprovalContext): Promise<unknown> | unknown
  computeAfter(args: ToolApprovalArgs, before: Json): unknown
  floors?(args: ToolApprovalArgs, before: Json, ctx: ToolApprovalContext): Promise<string[]> | string[]
  execute(args: ToolApprovalArgs, ctx: ToolApprovalExecuteContext): Promise<unknown>
}

/**
 * The production registry. It ships EMPTY on purpose: no tool opts in until its pilot (TASK-141) and the A5 security review.
 * Every unlisted tool therefore behaves exactly as it did before this gate existed. Adding a tool is a code change to THIS
 * map, reviewed like any other authorization change; there is no runtime or configuration route in.
 */
const PRODUCTION_REGISTRY: ReadonlyMap<string, ToolApprovalSpec> = new Map<string, ToolApprovalSpec>()

let testRegistry: ReadonlyMap<string, ToolApprovalSpec> | null = null

const isTestRuntime = (): boolean => process.env.NODE_ENV === "test"

export function getToolApprovalSpec(toolName: string): ToolApprovalSpec | undefined {
  if (testRegistry && isTestRuntime()) return testRegistry.get(toolName)
  return PRODUCTION_REGISTRY.get(toolName)
}

export function registeredToolApprovalNames(): string[] {
  return [...(testRegistry && isTestRuntime() ? testRegistry : PRODUCTION_REGISTRY).keys()].sort()
}

/**
 * Test-only injection. Throws outside NODE_ENV=test, and getToolApprovalSpec ignores an injected registry outside it, so
 * this cannot widen the production registry even if a production path called it. Pass null to restore the real registry.
 */
export function setToolApprovalRegistryForTest(specs: Record<string, ToolApprovalSpec> | null): void {
  if (!isTestRuntime()) throw new Error("setToolApprovalRegistryForTest is only available when NODE_ENV is 'test'.")
  if (specs === null) { testRegistry = null; return }
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.toolName !== name) throw new Error(`Tool approval spec key "${name}" does not match its toolName "${spec.toolName}".`)
    if (!spec.capabilityClass.trim()) throw new Error(`Tool approval spec "${name}" needs a capabilityClass.`)
  }
  testRegistry = new Map(Object.entries(specs))
}
