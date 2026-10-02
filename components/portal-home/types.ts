export interface HomeOptions {
  roadmapItems: { id: string; title: string; horizon: string; isPrivate: boolean }[]
  docs: { id: string; title: string }[]
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
