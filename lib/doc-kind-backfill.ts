// Red-phase stub: real implementation lands in the next commit.
import type { DocKind } from "@/lib/doc-kinds"

export type DocKindClassifierInput = { title: string; parentTitle: string | null }

export function classifyDocKind(_input: DocKindClassifierInput): DocKind | null {
  return null
}
