/**
 * Which embedded record kinds a spec doc's card can edit in place (spec docs phase 4), and with which fields.
 *
 * A card edit goes through the same endpoint the record's own detail panel uses (PATCH /api/panels/entity/<type>/<id>, see
 * components/panels/panel-parts.tsx patchEntityField), so it is exactly as authorized and validated as editing the record there. This
 * module only decides which kinds and fields the CARD offers; the server remains the authority and rejects anything else.
 *
 * Pure: no DB, no React. The status lists mirror lib/entity-mutations.ts (EDIT_CONFIG, TASK_STATUSES); __tests__/spec-docs/card-edit.test.ts
 * fails if they drift apart.
 *
 * Deliberately not editable from a card: metric, doc and artifact (no simple record-page field edit for the embed), roadmap items (their
 * one enum is a horizon, not a status) and key results' status (they have none). Key results get a title edit only.
 */
import type { DocEmbedKind } from "@/lib/doc-embeds"

export const CARD_TITLE_MAX_LENGTH = 255

/** The entity types the detail-panel PATCH endpoint accepts that a card can address (a subset of EntityPanelType). */
export type CardEntityType = "opportunity" | "solution" | "assumption" | "experiment" | "task" | "objective" | "keyResult"

export type CardEditSpec = {
  entityType: CardEntityType
  /** Allowed statuses, or null when the card offers no status control. */
  statuses: readonly string[] | null
}

const SPECS: Partial<Record<DocEmbedKind, CardEditSpec>> = {
  opportunity: { entityType: "opportunity", statuses: ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] },
  solution: { entityType: "solution", statuses: ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"] },
  assumption: { entityType: "assumption", statuses: ["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"] },
  experiment: { entityType: "experiment", statuses: ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"] },
  task: { entityType: "task", statuses: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"] },
  objective: { entityType: "objective", statuses: ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"] },
  keyResult: { entityType: "keyResult", statuses: null },
}

export function cardEditSpec(kind: DocEmbedKind): CardEditSpec | null {
  return SPECS[kind] ?? null
}

/** The trimmed title to send, or a message saying why nothing should be sent. */
export function validateCardTitle(raw: string): { ok: true; title: string } | { ok: false; error: string } {
  const title = raw.trim()
  if (!title) return { ok: false, error: "A title is required." }
  if (title.length > CARD_TITLE_MAX_LENGTH) return { ok: false, error: `Titles can be at most ${CARD_TITLE_MAX_LENGTH} characters.` }
  return { ok: true, title }
}
