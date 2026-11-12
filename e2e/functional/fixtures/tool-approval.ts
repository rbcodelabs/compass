/**
 * Seeds TOOL_APPROVAL review requests straight through the production creator (createToolApprovalRequest), without the MCP
 * hook or the tool registry: the production registry ships empty, so no real tool can raise one from a browser flow yet.
 * The title, summary and arguments carry unique marker strings so a surface that leaks any of them is caught by text search.
 *
 * FOR QA / VISUAL REVIEW (TASK-149): every state the approval page and the chat card can show can be put on a workspace with
 *   npx tsx --env-file=.env.local scripts/seed-tool-approval-qa.ts <orgSlug>/<workspaceSlug>
 * which calls seedToolApproval* below. Decided states are written directly (decision + executor receipt rows) because the
 * registry is empty outside NODE_ENV=test, so the real executor cannot be reached from a running dev server: an Approve click
 * in the browser records the decision and the executor answers "tool not registered", which the page shows as "Approved, not
 * run". That is the furthest a browser flow goes today; the applied effect is covered by the real-Postgres integration test
 * (__tests__/tool-approval-surface.integration.test.ts) with an injected test registry.
 */
import { randomUUID } from "node:crypto"
import getPrisma from "../../../lib/db"
import { createToolApprovalRequest } from "../../../lib/tool-approval/request"
import { EFFECT_PACKET_SCHEMA_VERSION, argsHashOf, deterministicSubjectId, type EffectPacket, type Json } from "../../../lib/tool-approval/packet"

export type SeededToolApproval = { requestId: string; marker: string; title: string; summary: string; argText: string; revisionId: string; tool: string }

export async function seedToolApprovalWith(
  workspaceId: string,
  opts: { marker?: string; before?: Json; after?: Json; args?: Json; titleSuffix?: string; expiresAt?: Date } = {},
): Promise<SeededToolApproval> {
  const marker = opts.marker ?? randomUUID().slice(0, 8)
  const title = `QA-TITLE-${marker} ${opts.titleSuffix ?? "Set workspace description"}`
  const summary = `QA-SUMMARY-${marker} Changes the workspace description.`
  const argText = `QA-ARGS-${marker}`
  const tool = `qa_tool_${marker}`
  const args = opts.args ?? { workspaceId, description: argText }
  const packet: EffectPacket = {
    schemaVersion: EFFECT_PACKET_SCHEMA_VERSION, tool, capabilityClass: "workspace.description", workspaceId,
    args, before: opts.before ?? { description: `QA-BEFORE-${marker}` }, after: opts.after ?? argText,
  }
  const { request, revision } = await createToolApprovalRequest(getPrisma(), {
    workspaceId, subjectId: deterministicSubjectId(workspaceId, tool, argsHashOf(tool, workspaceId, args), 0), packet, title, summary,
    requestedById: null, requestedByAgentId: null, expiresAt: opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  return { requestId: request.id, revisionId: revision.id, marker, title, summary, argText, tool }
}

export const seedToolApproval = (workspaceId: string) => seedToolApprovalWith(workspaceId)

/** A nested, array-bearing before/after with an add, a remove and a change: the shape the diff renderer has to get right. */
export async function seedRichToolApproval(workspaceId: string): Promise<SeededToolApproval> {
  const marker = randomUUID().slice(0, 8)
  const before: Json = { name: `QA-NAME-${marker}`, labels: ["alpha", "beta", "gamma"], limits: { maxItems: 10, burst: true }, owner: { email: "a@example.com" } }
  const after: Json = { name: `QA-NAME-${marker}-renamed`, labels: ["alpha", "gamma", "delta"], limits: { maxItems: 25, burst: true, region: "eu" } , owner: null }
  return seedToolApprovalWith(workspaceId, { marker, before, after, args: { workspaceId, patch: after }, titleSuffix: "Update workspace settings" })
}

/** Long strings, a very long unbroken token and HTML-looking text: nothing may widen the page or render as markup. */
export async function seedHostileToolApproval(workspaceId: string): Promise<SeededToolApproval> {
  const long = `${"word ".repeat(400)}${"x".repeat(1500)}`
  const html = '<script>window.__approval_xss = true</script><img src=x onerror="window.__approval_xss = true">'
  return seedToolApprovalWith(workspaceId, { before: { note: "short", html: "plain" }, after: { note: long, html }, args: { workspaceId, note: long, html }, titleSuffix: `<b>bold?</b> ${html.slice(0, 20)}` })
}

export type DecidedState = "DENIED" | "APPLIED" | "FAILED" | "STALE" | "BLOCKED" | "UNKNOWN_OUTCOME" | "NOT_RUN" | "EXPIRED" | "APPLYING"

/**
 * A request already in one of the end states, written the way the decision service and executor would leave it. Fixture only:
 * it bypasses recordDecision and the executor on purpose (see the header).
 */
export async function seedDecidedToolApproval(workspaceId: string, state: DecidedState, deciderUserId: string): Promise<SeededToolApproval> {
  const prisma = getPrisma()
  const seeded = await seedToolApprovalWith(workspaceId, { titleSuffix: `Seeded as ${state}` })
  if (state === "EXPIRED") {
    await prisma.reviewRevision.update({ where: { id: seeded.revisionId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    return seeded
  }
  const revision = await prisma.reviewRevision.findUniqueOrThrow({ where: { id: seeded.revisionId }, include: { options: true } })
  const option = revision.options.find((o) => o.actionKey === (state === "DENIED" ? "REJECT" : "APPROVE"))!
  const old = new Date(Date.now() - 10 * 60 * 1000)
  const decision = await prisma.decisionRecord.create({
    data: {
      workspaceId, requestId: seeded.requestId, revisionId: revision.id, optionId: option.id, fingerprint: revision.fingerprint,
      actorUserId: deciderUserId, actorRole: "ADMIN", idempotencyKey: `qa-${randomUUID()}`, decidedAt: state === "APPLYING" ? new Date() : old,
    },
  })
  await prisma.reviewRequest.update({ where: { id: seeded.requestId }, data: { state: "DECIDED" } })
  const receiptStatus: Partial<Record<DecidedState, { status: string; lastError?: string; appliedAt?: Date; updatedAt: Date }>> = {
    APPLIED: { status: "APPLIED", appliedAt: old, updatedAt: old },
    FAILED: { status: "FAILED", lastError: "Error: the target rejected the change", updatedAt: old },
    STALE: { status: "STALE", lastError: "The state changed after approval.", updatedAt: old },
    BLOCKED: { status: "BLOCKED", lastError: "description is too long", updatedAt: old },
    UNKNOWN_OUTCOME: { status: "PENDING", updatedAt: old },
    APPLYING: { status: "PENDING", updatedAt: new Date() },
  }
  const receipt = receiptStatus[state]
  if (receipt) {
    await prisma.decisionApplication.create({
      data: { decisionId: decision.id, continuationKey: "EXECUTE_TOOL_APPROVAL", targetType: "TOOL_APPROVAL", targetId: seeded.requestId, receiptKey: `tool-approval:${decision.id}:v1`, attemptCount: 1, ...receipt },
    })
  }
  return seeded
}
