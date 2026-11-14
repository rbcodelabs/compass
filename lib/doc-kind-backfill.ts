import type { DocKind } from "@/lib/doc-kinds"

/**
 * Pure classifier behind the 118_doc_kind_backfill migration (lib/migrations/doc-kind-backfill.ts): what kind an existing doc gets from
 * its title and its parent page's title. First matching rule wins; `null` means "not sure", and the doc is left unset rather than guessed.
 *
 *   ADR         the title starts with "ADR" (so "ADR - ...", "ADR-0020 ..."), or with a zero-padded four digit number (0001 to 0999)
 *               followed by a space, dot, colon or dash ("0018 Fold ..."). ADR numbers here are zero-padded, so a title that starts with
 *               a year or a date ("2026 Roadmap", "1999 retrospective", "2026-11-07 ...") is never read as a decision number.
 *   QA_REPORT   the title starts with "QA Report", or the parent page is "QA Reports".
 *   DESIGN      the parent page is "Design" or "Designs", or the title starts with "Design:" or "Design_".
 *
 * Case-insensitive. Container pages ("Architecture Decisions", "QA Reports", ...), Spec and Discovery Plan docs and loose notes match
 * nothing and stay unset. docType plays no part: a SPEC doc is classified by the same title and parent rules as any other doc.
 */
export type DocKindClassifierInput = { title: string; parentTitle: string | null }

const ADR_TITLE = /^ADR\b/i
const NUMBERED_TITLE = /^0\d{3}[ .:-]/
// \b so the container page "QA Reports" is not a report itself.
const QA_REPORT_TITLE = /^QA Report\b/i
const DESIGN_TITLE = /^Design[:_]/i

const normalizeParent = (parentTitle: string | null) => parentTitle?.trim().toLowerCase() ?? null

export function classifyDocKind({ title, parentTitle }: DocKindClassifierInput): DocKind | null {
  const text = title.trim()
  const parent = normalizeParent(parentTitle)

  if (ADR_TITLE.test(text)) return "ADR"
  if (NUMBERED_TITLE.test(text)) return "ADR"
  if (QA_REPORT_TITLE.test(text) || parent === "qa reports") return "QA_REPORT"
  if (parent === "design" || parent === "designs" || DESIGN_TITLE.test(text)) return "DESIGN"
  return null
}
