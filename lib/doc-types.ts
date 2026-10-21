/**
 * Doc.docType values. The column is a free-form VarChar (no DB enum), so adding
 * a type needs no migration; this list is the single source for validation.
 *
 * - STANDARD: markdown page (TipTap editor).
 * - GTM_POSITIONING_BRIEF: markdown brief linked 1:1 to a roadmap item.
 * - CANVAS: a JSON Canvas 1.0 document stored as a JSON string in Doc.content
 *   (see lib/json-canvas.ts).
 * - SPEC: a markdown Spec (solution scope) or Discovery Plan (opportunity scope)
 *   whose body embeds Compass records as `[title](compass://kind/uuid)` links
 *   (lib/doc-embeds). Scoped to its Solution/Opportunity by DOC_SPECIFIES_SCOPE
 *   entity_links rows (lib/spec-docs). Created only by createSpecCore: write_doc's
 *   docType enum deliberately stays STANDARD | CANVAS.
 */
export const DOC_TYPES = ["STANDARD", "GTM_POSITIONING_BRIEF", "CANVAS", "SPEC"] as const
export type DocType = (typeof DOC_TYPES)[number]

/** A stored Doc.docType as a known DocType; the column is free-form, so anything unrecognised reads as STANDARD. */
export function normalizeDocType(docType: string | null | undefined): DocType {
  return (DOC_TYPES as readonly string[]).includes(docType ?? "") ? (docType as DocType) : "STANDARD"
}

export function isCanvasDocType(docType: string | null | undefined): boolean {
  return docType === "CANVAS"
}
