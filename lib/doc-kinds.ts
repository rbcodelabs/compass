// Red-phase stub: real implementation lands in the next commit.
export const DOC_KINDS = [] as readonly string[]
export type DocKind = string
export const DOC_KIND_LABELS: Record<string, string> = {}
export const NO_KIND_LABEL = ""
export function normalizeDocKind(_value: unknown): DocKind | null {
  return null
}
export function isDocKind(_value: unknown): _value is DocKind {
  return false
}
export function docKindLabel(_kind: string | null | undefined): string {
  return ""
}
