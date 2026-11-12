// Deliberately NOT exported here: the decision channel token (channel.ts), the approval decision entry point (decide.ts) and
// the executor (executor.ts). Import those by path, only from the places __tests__/tool-approval-imports.test.ts allows.
export * from "@/lib/tool-approval/gate"
export * from "@/lib/tool-approval/errors"
export * from "@/lib/tool-approval/packet"
export * from "@/lib/tool-approval/registry"
export * from "@/lib/tool-approval/request"
export type { ExecuteOutcome, RefusalReason } from "@/lib/tool-approval/executor"
export { interceptToolForApproval } from "@/lib/tool-approval/mcp-hook"
export { restOperationIsApprovalGated } from "@/lib/tool-approval/rest-guard"
