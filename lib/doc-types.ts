/**
 * Doc.docType values. The column is a free-form VarChar (no DB enum), so adding
 * a type needs no migration; this list is the single source for validation.
 *
 * - STANDARD: markdown page (TipTap editor).
 * - GTM_POSITIONING_BRIEF: markdown brief linked 1:1 to a roadmap item.
 * - CANVAS: a JSON Canvas 1.0 document stored as a JSON string in Doc.content
 *   (see lib/json-canvas.ts).
 */
export const DOC_TYPES = ["STANDARD", "GTM_POSITIONING_BRIEF", "CANVAS"] as const
export type DocType = (typeof DOC_TYPES)[number]

export function isCanvasDocType(docType: string | null | undefined): boolean {
  return docType === "CANVAS"
}
