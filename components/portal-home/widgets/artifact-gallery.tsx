import Link from "next/link"
import { Boxes } from "lucide-react"
import { ARTIFACT_GALLERY_MAX_ITEMS, type ArtifactGalleryConfig } from "@/lib/portal-home/widgets/artifact-gallery"
import type { ArtifactCardItem, ResolvedWidgetData } from "@/lib/portal-home/data"
import { formatDocDate } from "@/lib/portal-docs/format"
import { StatusBadge } from "@/components/patterns/status-badge"
import { MoreLink, WidgetCard } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import { OrderedPicker } from "../ordered-picker"
import type { ConfigFormProps, RendererProps } from "../types"

type GalleryData = Extract<ResolvedWidgetData, { type: "artifact_gallery" }>

const SOURCE_LABEL: Record<string, string> = {
  HTML_UPLOAD: "Prototype",
  EXTERNAL_LINK: "Link",
  V0_CHAT: "v0",
  REPO_PREVIEW: "Repo app",
}

function kindLabel(artifact: ArtifactCardItem): string {
  if (artifact.kind === "SLIDE_DECK") return "Deck"
  return SOURCE_LABEL[artifact.sourceType] ?? "Artifact"
}

function ArtifactCard({ artifact }: { artifact: ArtifactCardItem }) {
  return (
    <li className="min-w-0">
      <Link
        href={artifact.href}
        className="group flex h-full flex-col overflow-hidden rounded-lg border border-border-default bg-surface-panel transition-[border-color,box-shadow] hover:border-border-focus hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex aspect-video w-full items-center justify-center overflow-hidden bg-surface-inset text-text-subtle" data-testid="artifact-gallery-thumb">
          {artifact.thumbnailSrc ? (
            // eslint-disable-next-line @next/next/no-img-element -- private, cookie-authenticated route; next/image would proxy it without the session
            <img src={artifact.thumbnailSrc} alt="" loading="lazy" className="size-full object-cover object-top" />
          ) : (
            <Boxes className="size-8" strokeWidth={1.5} aria-hidden />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1 p-3">
          <span className="truncate text-sm font-semibold text-text-primary group-hover:text-primary">{artifact.title || "Untitled"}</span>
          <span className="flex items-center gap-2 text-xs text-text-subtle">
            <StatusBadge status="neutral">{kindLabel(artifact)}</StatusBadge>
            <span>Updated {formatDocDate(artifact.updatedAt)}</span>
          </span>
        </span>
      </Link>
    </li>
  )
}

/** Team-only card grid of recent Artifacts. The grid reads the widget's own width (container query), so it adapts in every template. */
export function ArtifactGalleryRenderer({ config, data }: RendererProps<ArtifactGalleryConfig, GalleryData>) {
  return (
    <WidgetCard title={config.title}>
      <div className="@container">
        <ul className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3" data-testid="artifact-gallery-list">
          {data.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </ul>
      </div>
      <MoreLink href={data.galleryHref}>Open Docs</MoreLink>
    </WidgetCard>
  )
}

export function ArtifactGalleryForm({ config, onChange, options }: ConfigFormProps<ArtifactGalleryConfig>) {
  const items = (options?.artifacts ?? []).map((artifact) => ({
    id: artifact.id,
    label: artifact.title,
    hint: artifact.kind === "SLIDE_DECK" ? "Deck" : SOURCE_LABEL[artifact.sourceType],
  }))
  return (
    <div className="flex flex-col gap-3">
      <TextField id="ag-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <SelectField
        id="ag-mode"
        label="Which artifacts"
        value={config.mode}
        onChange={(mode) => onChange({ ...config, mode: mode as ArtifactGalleryConfig["mode"] })}
        options={[
          { value: "recent", label: "Most recently updated" },
          { value: "selected", label: "Selected artifacts" },
        ]}
      />
      <SelectField
        id="ag-max"
        label="Maximum artifacts shown"
        value={String(config.maxItems)}
        onChange={(maxItems) => onChange({ ...config, maxItems: Number(maxItems) })}
        options={Array.from({ length: ARTIFACT_GALLERY_MAX_ITEMS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
      />
      {config.mode === "selected" ? (
        <OrderedPicker
          idPrefix="ag"
          heading="Choose artifacts"
          noun="artifact"
          items={items}
          selectedIds={config.artifactIds}
          max={ARTIFACT_GALLERY_MAX_ITEMS}
          loading={options === null}
          onChange={(artifactIds) => onChange({ ...config, artifactIds })}
        />
      ) : (
        <p className="text-xs leading-5 text-text-subtle">Shows your most recently updated active artifacts. Add more than one gallery to group different artifacts.</p>
      )}
    </div>
  )
}
