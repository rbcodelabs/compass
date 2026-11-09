export type ToolApprovalErrorCode =
  | "WORKSPACE_REQUIRED"
  | "TOO_MANY_PENDING"
  | "REQUESTER_LIMIT"
  | "REQUEST_CONFLICT"
  | "GENERATIONS_EXHAUSTED"
  | "ADMIN_REQUIRED"
  | "REQUEST_NOT_FOUND"
  | "OPTION_NOT_FOUND"

export class ToolApprovalError extends Error {
  constructor(public readonly code: ToolApprovalErrorCode, message: string) {
    super(message)
    this.name = "ToolApprovalError"
  }
}
