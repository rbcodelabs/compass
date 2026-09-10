// This source is host-owned; the curated action accepts no client source fields.
export const AGENTIC_PM_PACK = {
  repositoryUrl: "https://github.com/rbcodelabs/agent-pm-playbook",
  packPath: "packs/compass",
  packId: "agentic-pm-compass",
} as const

export function isAgenticPmPack(source: { packId: string; sourceRepository: string; sourcePath: string }) {
  return source.packId === AGENTIC_PM_PACK.packId && source.sourceRepository === AGENTIC_PM_PACK.repositoryUrl && source.sourcePath === AGENTIC_PM_PACK.packPath
}
