import type { DocKind } from "@/lib/doc-kinds"

/**
 * Pure classifier behind the 118_doc_kind_backfill migration (lib/migrations/doc-kind-backfill.ts): what kind an existing doc gets from
 * its title and its parent page's title. First matching rule wins; `null` means "not sure", and the doc is left unset rather than guessed.
 *
 *   ADR         the title starts with "ADR" (so "ADR - ...", "ADR-0020 ..."), or with a four digit number followed by a space, dot,
 *               colon or dash ("0018 Fold ..."). A four digit ISO date prefix ("2026-11-07 ...") is a date, not a decision number.
 *   QA_REPORT   the title starts with "QA Report", or the parent page is "QA Reports".
 *   DESIGN      the parent page is "Design" or "Designs", or the title starts with "Design:" or "Design_".
 *
 * Case-insensitive. Container pages ("Architecture Decisions", "QA Reports", ...), Spec and Discovery Plan docs and loose notes match
 * nothing and stay unset. docType plays no part: a SPEC doc is classified by the same title and parent rules as any other doc.
 */
export type DocKindClassifierInput = { title: string; parentTitle: string | null }

const ADR_TITLE = /^ADR\b/i
const NUMBERED_TITLE = /^\d{4}[ .:-]/
const ISO_DATE_PREFIX = /^\d{4}-\d{2}(?:-\d{2})?(?!\d)/
const QA_REPORT_TITLE = /^QA Report/i
const DESIGN_TITLE = /^Design[:_]/i

const normalizeParent = (parentTitle: string | null) => parentTitle?.trim().toLowerCase() ?? null

export function classifyDocKind({ title, parentTitle }: DocKindClassifierInput): DocKind | null {
  const text = title.trim()
  const parent = normalizeParent(parentTitle)

  if (ADR_TITLE.test(text)) return "ADR"
  if (NUMBERED_TITLE.test(text) && !ISO_DATE_PREFIX.test(text)) return "ADR"
  if (QA_REPORT_TITLE.test(text) || parent === "qa reports") return "QA_REPORT"
  if (parent === "design" || parent === "designs" || DESIGN_TITLE.test(text)) return "DESIGN"
  return null
}
