import { MCP_REST_PARITY_MANIFEST } from "@/lib/rest/parity-manifest"
import { registeredToolApprovalNames } from "@/lib/tool-approval/registry"

/**
 * True when a REST operation is the parity twin of an MCP tool that requires approval. REST does not run the MCP register()
 * hook, so without this guard a tool that opted in could be called directly over REST. The REST executor refuses such an
 * operation; an opted-in tool is reachable only through the MCP tool, which files the approval request.
 */
export function restOperationIsApprovalGated(operationId: string): boolean {
  const manifest = MCP_REST_PARITY_MANIFEST as Record<string, { kind: string; operationId?: string; operationIds?: readonly string[] } | undefined>
  return registeredToolApprovalNames().some((tool) => {
    const disposition = manifest[tool]
    if (!disposition) return false
    if (disposition.kind === "direct") return disposition.operationId === operationId
    if (disposition.kind === "composition") return disposition.operationIds?.includes(operationId) ?? false
    return false
  })
}
