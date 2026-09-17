/**
 * "Send to agent" hand-off resolver.
 *
 * Turns an entity reference (`{entityType, entityId}`, carried in a URL param
 * or in the /api/agent/turn request body — see the "Send to agent" plan) into
 * a small context bundle for the agent chat: a chip label/summary, a suggested
 * (editable) composer instruction, a prompt-fold block, and a link back to the
 * source.
 *
 * Resolved twice by design (page-load for the chip, turn-POST for the prompt
 * fold) so staleness — the plan/decision changing state between click and
 * Send — is handled by silently returning `null` rather than failing the
 * turn. Every failure mode (unknown entity type, not found, wrong workspace,
 * not approved) degrades to `null`; callers never surface an error for this,
 * consistent with this app's no-toast convention.
 *
 * Deliberately reads `SolutionComment.planStatus` — the field the live
 * `approveSolutionPlan`/`rejectSolutionPlan` actions actually write — not the
 * newer `Comment`/`SolutionPlanProposal` mirror. See ADR 0005 for why
 * `planStatus` is mutable/non-authoritative in general but is still the
 * correct read here: this hand-off only *reads* current state, it never uses
 * it as a decision-ledger authorization.
 */

import getPrisma from "@/lib/db"

export type AgentHandoffEntityType = "solutionPlan" | "decision"

export type AgentHandoffContext = {
  /** Short label for the dismissible context chip. */
  label: string
  /** One- or two-line summary shown under the chip label. */
  summary: string
  /** Prefilled (editable) composer instruction. */
  suggestedInstruction: string
  /** Labeled section folded into the turn-1 prompt — never persisted as a message. */
  promptBlock: string
  /** Link back to the source Solution/Decision page. */
  sourceUrl: string
}

/**
 * The "Send to agent" hand-off payload posted across the Geode bridge
 * (`window.__geode.postEvent("agent.handoff", payload)`, see
 * components/agent/send-to-agent-picker.tsx). Mirrors `AgentHandoffContext`
 * verbatim plus the identifying fields Geode needs to open its own thread —
 * these field names are the authoritative cross-repo contract for this
 * integration (Compass Task cd908f23-f96d-4b16-b32a-6fc9a98baa56 / Geode
 * Solution 17be677b-ea4b-4325-9f72-d8a3a526f69d); do not rename casually.
 */
export type GeodeAgentHandoffPayload = {
  entityType: AgentHandoffEntityType
  entityId: string
  orgSlug: string
  workspaceSlug: string
  label: string
  summary: string
  suggestedInstruction: string
  promptBlock: string
  /**
   * Same key name as `AgentHandoffContext.sourceUrl` — the Geode receiver's
   * contract is pinned to `sourceUrl` (see Compass Task cd908f23 comment from
   * the receiver team, 2026-09-17), not `url`. Sent as an **absolute** URL
   * (the receiver absolutizes against its own Web Viewer frame origin if
   * given a relative one, but accepts absolute too — sending absolute here
   * is strictly more correct since Compass already knows its own origin and
   * Geode doesn't have to guess it).
   */
  sourceUrl: string
}

// A tracked decision's `context` field can be up to 20,000 chars — truncate
// what we fold into the prompt so a single hand-off can't blow out per-turn
// token/cost, and point back to the source page for the full text instead.
const DECISION_CONTEXT_MAX_CHARS = 4000

// Geode's bridge (`normalizeWebViewerEvent`) enforces a hard
// MAX_PAYLOAD_JSON_LENGTH = 8192 bytes and silently drops anything over it —
// there is no error, just a dead button (see Task cd908f23 comment from the
// receiver team, 2026-09-17). `promptBlock` is the only unbounded field in
// this payload (an approved Solution plan body has no length cap elsewhere),
// so the /api/agent/handoff-context route truncates it to this budget before
// it ever reaches the client. Mirrors DECISION_CONTEXT_MAX_CHARS for
// consistency — the decision path already caps its own context input at the
// same 4000 chars, so capping the *output* promptBlock at the same size
// keeps both entity types under a predictable, comparable budget, well
// inside Geode's 8192-byte ceiling even after JSON-encoding overhead and the
// other payload fields.
export const GEODE_HANDOFF_PROMPT_BLOCK_MAX_CHARS = 4000

type ResolveInput = {
  workspaceId: string
  userId: string
  entityType: string
  entityId: string
}

export async function resolveAgentHandoffContext(input: ResolveInput): Promise<AgentHandoffContext | null> {
  try {
    if (input.entityType === "solutionPlan") return await resolveSolutionPlan(input)
    if (input.entityType === "decision") return await resolveDecision(input)
    return null
  } catch (error) {
    // The contract above promises `null`, never a throw — callers render a
    // page or complete an agent turn around this and must not 500 because a
    // hand-off link was malformed. Every id column here is `@db.Uuid`, so a
    // non-UUID entityId (hand-edited URL, truncated paste) makes Postgres
    // reject the cast and Prisma throw before any of our own guards run.
    console.warn(
      `[agent-context] resolve failed (entityType=${input.entityType}, entityId=${input.entityId}); treating as no context.`,
      error
    )
    return null
  }
}

async function resolveSolutionPlan({ workspaceId, userId, entityId }: ResolveInput): Promise<AgentHandoffContext | null> {
  const prisma = getPrisma()
  const plan = await prisma.solutionComment.findFirst({
    where: {
      id: entityId,
      commentType: "PLAN",
      solution: {
        opportunity: {
          workspaceId,
          workspace: { members: { some: { userId } } },
        },
      },
    },
    select: {
      id: true,
      body: true,
      planStatus: true,
      solution: {
        select: {
          id: true,
          title: true,
          opportunity: {
            select: {
              id: true,
              workspace: { select: { slug: true, organization: { select: { slug: true } } } },
            },
          },
        },
      },
    },
  })
  if (!plan || plan.planStatus !== "APPROVED") return null

  const { solution } = plan
  const { opportunity } = solution
  const base = `/${opportunity.workspace.organization.slug}/${opportunity.workspace.slug}`
  const sourceUrl = `${base}/discovery/${opportunity.id}?detail=solution:${solution.id}`
  const summary = plan.body.trim().slice(0, 280)

  return {
    label: `Approved plan · ${solution.title}`,
    summary,
    suggestedInstruction: `Help me move forward with the approved plan for "${solution.title}".`,
    promptBlock:
      `Approved Solution Plan for "${solution.title}":\n\n${plan.body.trim()}\n\n` +
      `(Source: ${sourceUrl})`,
    sourceUrl,
  }
}

/** Minimal, tolerant read of the tracked-decision packet's free-text context. */
function packetContext(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return typeof value.context === "string" ? value.context : null
  } catch {
    return null
  }
}

async function resolveDecision({ workspaceId, userId, entityId }: ResolveInput): Promise<AgentHandoffContext | null> {
  const prisma = getPrisma()
  const request = await prisma.reviewRequest.findFirst({
    where: {
      id: entityId,
      workspaceId,
      gateType: "TRACKED_DECISION",
      workspace: { members: { some: { userId } } },
    },
    select: {
      id: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
      currentRevision: {
        select: {
          id: true,
          title: true,
          summary: true,
          packetJson: true,
          decisions: { select: { option: { select: { outcomeClass: true } } } },
        },
      },
    },
  })
  if (!request?.currentRevision) return null

  const decision = request.currentRevision.decisions[0]
  if (!decision || decision.option.outcomeClass !== "APPROVE") return null

  const base = `/${request.workspace.organization.slug}/${request.workspace.slug}`
  const sourceUrl = `${base}/reviews/${request.id}`

  const rawContext = packetContext(request.currentRevision.packetJson) ?? request.currentRevision.summary ?? ""
  const truncated = rawContext.length > DECISION_CONTEXT_MAX_CHARS
  const contextForPrompt = truncated ? `${rawContext.slice(0, DECISION_CONTEXT_MAX_CHARS)}…` : rawContext

  return {
    label: `Approved decision · ${request.currentRevision.title}`,
    summary: (request.currentRevision.summary ?? rawContext).trim().slice(0, 280),
    suggestedInstruction: `Help me act on the approved decision "${request.currentRevision.title}".`,
    promptBlock:
      `Approved Decision Record "${request.currentRevision.title}":\n\n${contextForPrompt}` +
      (truncated ? `\n\n(Truncated — full context at the source link below.)` : "") +
      `\n\n(Source: ${sourceUrl})`,
    sourceUrl,
  }
}
