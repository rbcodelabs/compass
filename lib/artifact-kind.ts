/**
 * Presentation kind of an Artifact's content (`artifacts.kind`, migration 077).
 *
 * Orthogonal to `sourceType`: sourceType says where the bytes come from, kind
 * says how to present them. A slide deck is still an HTML_UPLOAD, stored and
 * revised like any other, and is just rendered one slide at a time.
 *
 * The column is a nullable VARCHAR with no CHECK (Aurora DSQL rejects
 * constraints on ADD COLUMN), so this module is where the allowed values live.
 * NULL — every row written before 077 — reads as DOCUMENT, and DOCUMENT is
 * written back as NULL so there is exactly one stored spelling of "ordinary".
 *
 * Dependency-free so client components can import it.
 */
export const ARTIFACT_KINDS = ["DOCUMENT", "SLIDE_DECK"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** Reads a stored `artifacts.kind`. Unknown values degrade to DOCUMENT rather than throwing. */
export function readArtifactKind(stored: string | null | undefined): ArtifactKind {
  return stored === "SLIDE_DECK" ? "SLIDE_DECK" : "DOCUMENT"
}

/** Validates caller input. Throws on an unknown value; `undefined` means "not supplied". */
export function parseArtifactKind(value: unknown): ArtifactKind | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error("kind must be DOCUMENT or SLIDE_DECK")
  const normalized = value.trim().toUpperCase()
  if (normalized === "DOCUMENT" || normalized === "SLIDE_DECK") return normalized
  throw new Error("kind must be DOCUMENT or SLIDE_DECK")
}

/** The value to write to `artifacts.kind`: SLIDE_DECK, or NULL for DOCUMENT. */
export function storedArtifactKind(kind: ArtifactKind): string | null {
  return kind === "SLIDE_DECK" ? "SLIDE_DECK" : null
}

/** Only uploaded HTML can be split into slides; an external link has no bytes to split. */
export function assertKindAllowedForSource(kind: ArtifactKind, sourceType: string): void {
  if (kind === "SLIDE_DECK" && sourceType !== "HTML_UPLOAD") {
    throw new Error("Only HTML upload artifacts can be slide decks")
  }
}
