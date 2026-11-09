/**
 * Seeds a TOOL_APPROVAL review request straight through the production creator (createToolApprovalRequest), without the MCP
 * hook or the tool registry: the production registry ships empty, so no real tool can raise one from a browser flow yet.
 * The title, summary and arguments carry unique marker strings so a surface that leaks any of them is caught by text search.
 */
import { randomUUID } from "node:crypto"
import getPrisma from "../../../lib/db"
import { createToolApprovalRequest } from "../../../lib/tool-approval/request"
import { EFFECT_PACKET_SCHEMA_VERSION, argsHashOf, deterministicSubjectId, type EffectPacket } from "../../../lib/tool-approval/packet"

export type SeededToolApproval = { requestId: string; marker: string; title: string; summary: string; argText: string }

export async function seedToolApproval(workspaceId: string): Promise<SeededToolApproval> {
  const marker = randomUUID().slice(0, 8)
  const title = `QA-TITLE-${marker} Set workspace description`
  const summary = `QA-SUMMARY-${marker} Changes the workspace description.`
  const argText = `QA-ARGS-${marker}`
  const tool = `qa_tool_${marker}`
  const args = { workspaceId, description: argText }
  const packet: EffectPacket = {
    schemaVersion: EFFECT_PACKET_SCHEMA_VERSION, tool, capabilityClass: "workspace.description", workspaceId,
    args, before: { description: `QA-BEFORE-${marker}` }, after: argText,
  }
  const { request } = await createToolApprovalRequest(getPrisma(), {
    workspaceId, subjectId: deterministicSubjectId(workspaceId, tool, argsHashOf(tool, workspaceId, args), 0), packet, title, summary,
    requestedById: null, requestedByAgentId: null, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  return { requestId: request.id, marker, title, summary, argText }
}
