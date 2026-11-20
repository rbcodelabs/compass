export interface HomeOptions {
  unavailable?: true
  roadmapItems: { id: string; title: string; horizon: string; isPrivate: boolean }[]
  docs: { id: string; title: string; isPublished?: boolean }[]
  /** Optional so older cached responses still type-check; the forms treat a missing list as empty. */
  artifacts?: { id: string; title: string; kind: string | null; sourceType: string }[]
  okrCycles?: { id: string; title: string; status: string }[]
  objectives?: { id: string; title: string; cycleTitle: string | null }[]
}

export interface RendererProps<C, D = unknown> {
  config: C
  data: D
}

export interface ConfigFormProps<C> {
  config: C
  onChange: (config: C) => void
  options: HomeOptions | null
}
