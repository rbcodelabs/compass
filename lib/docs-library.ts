// Red-phase stub: real implementation lands in the next commit.
import type { DocKind } from "@/lib/doc-kinds"

export type LibraryDoc = { id: string; title: string; kind: string | null; updatedAt: Date; docType?: string | null }
export type LibraryView = "overview" | "by-type" | "recent"
export type KindGroup = { kind: DocKind | null; label: string; docs: LibraryDoc[] }
export type KindCounts = { total: number; byKind: { kind: DocKind; label: string; count: number }[]; noType: number }

export function parseLibraryView(_raw: string | string[] | undefined): LibraryView {
  return "overview"
}
export function kindCounts(_docs: LibraryDoc[]): KindCounts {
  return { total: 0, byKind: [], noType: 0 }
}
export function groupDocsByKind(_docs: LibraryDoc[]): KindGroup[] {
  return []
}
export function recentDocs(_docs: LibraryDoc[], _limit?: number): LibraryDoc[] {
  return []
}
