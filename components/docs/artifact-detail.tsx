"use client"

import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { createPortal } from "react-dom"
import { Camera, Info, MessageSquare, PanelRightClose, RefreshCw, X } from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  archiveArtifact,
  captureArtifactThumbnail,
  linkArtifact,
  refreshArtifactFromV0,
  replaceArtifactRevision,
  unlinkArtifact,
  unlinkArtifactDecision,
  updateArtifact,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { ArtifactViewer } from "./artifact-viewer"
import type { ArtifactSlideDto } from "@/lib/artifact-slides"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { PanelResizeHandle, PANEL_WIDTH_PROPERTY } from "@/components/panels/panel-resize-handle"
import { Discussion } from "@/components/comments/discussion"
import { useMediaQuery } from "@/hooks/use-media-query"
import {
  PANEL_MIN_MAIN,
  PANEL_PIN_MEDIA_QUERY,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  panelPinCookieString,
  type PanelPin,
} from "@/lib/panel-pin"
import { DocsLibraryButton } from "@/components/docs/docs-library-button"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"
import { isGoogleDriveUrl } from "@/lib/google-drive-links"
import { ArtifactSharePanel } from "./artifact-share-panel"
import type { OwnerShareState } from "@/lib/artifact-share"
import { useLiveRefresh } from "@/hooks/use-live-refresh"
import { LinkedEntitiesSection } from "@/components/links/linked-entities-section"
import { cn } from "@/lib/utils"

export const ARTIFACT_INSPECTOR_DEFAULT_WIDTH = 360

export type InspectorTab = "details" | "links" | "share" | "history" | "comments"
type NonCommentTab = Exclude<InspectorTab, "comments">

const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: "details", label: "Details" },
  { id: "links", label: "Links" },
  { id: "share", label: "Share" },
  { id: "history", label: "History" },
  { id: "comments", label: "Comments" },
]

type ArtifactDetailProps = {
  artifact: {
    id: string
    title: string
    description: string | null
    sourceType: string
    kind?: "DOCUMENT" | "SLIDE_DECK"
    status: string
    currentRevision: { externalUrl: string | null; thumbnail: ArtifactThumbnailDto | null } | null
    revisions: Array<{ id: string; revisionNumber: number; filename: string | null; byteSize: number | null; externalUrl: string | null; createdAt: string }>
  }
  html?: string
  /** Present only for a SLIDE_DECK Artifact. */
  slides?: ArtifactSlideDto[]
  /** Zero-based slide to open on, from `?slide=`. */
  initialSlideIndex?: number
  initialCommentsPin?: PanelPin
  initialFocusedCommentId?: string | null
  /** V0_CHAT only: v0's running preview, fetched per view with the viewer's own grant. */
  livePreviewSrc?: string | null
  /** HTML_UPLOAD only: the owner's external-share state. Absent for other sources. */
  shareState?: OwnerShareState
  workspaceId: string
  basePath: string
  solutions: Array<{ id: string; title: string; linked: boolean }>
  decisions: Array<{ id: string; title: string; state: string }>
}

export function ArtifactDetail({
  artifact,
  html,
  slides,
  initialSlideIndex,
  workspaceId,
  basePath,
  solutions,
  decisions,
  initialCommentsPin,
  initialFocusedCommentId = null,
  livePreviewSrc,
  shareState,
}: ArtifactDetailProps) {
  const labels = useLabels()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [seenArtifactId, setSeenArtifactId] = useState(artifact.id)
  const [error, setError] = useState<string | null>(null)
  const [selectedSolution, setSelectedSolution] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  if (artifact.id !== seenArtifactId) {
    setSeenArtifactId(artifact.id)
    setError(null)
    setNotice(null)
    setSelectedSolution("")
  }

  // The viewer below is intentionally not keyed on the revision: a refresh swaps
  // `html`/`slides` in place, so the slide index, pick state and any comment
  // draft survive an agent publishing a new revision.
  // basePath is `/<org>/<workspace>/docs`; the slugs address the change-token route.
  const [, orgSlug = "", workspaceSlug = ""] = basePath.split("/")
  useLiveRefresh({ orgSlug, workspaceSlug, scope: `artifact:${artifact.id}`, paused: pending, enabled: Boolean(orgSlug && workspaceSlug) })
  const latestRevisionNumber = artifact.revisions.reduce((max, revision) => Math.max(max, revision.revisionNumber), 0)
  const newRevisionNotice = useNewRevisionNotice(latestRevisionNumber)

  const [inspectorOpen, setInspectorOpen] = useState(Boolean(initialFocusedCommentId))
  const [activeTab, setActiveTab] = useState<InspectorTab>(initialFocusedCommentId ? "comments" : "details")
  const [lastDetailTab, setLastDetailTab] = useState<NonCommentTab>("details")
  const [visitedTabs, setVisitedTabs] = useState<Record<InspectorTab, boolean>>(() => ({
    details: false,
    links: false,
    share: false,
    history: false,
    comments: Boolean(initialFocusedCommentId),
  }))
  const [commentsVisits, setCommentsVisits] = useState(initialFocusedCommentId ? 1 : 0)
  const [commentsSlot, setCommentsSlot] = useState<HTMLElement | null>(null)
  // Where ArtifactViewer portals its actions (Leave feedback, View full screen) so they sit in the top bar.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)

  const commentsTriggerRef = useRef<HTMLButtonElement>(null)
  const detailsTriggerRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({})
  const rowRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  const [inspectorWidth, setInspectorWidth] = useState(() =>
    clampPanelWidth(initialCommentsPin?.width ?? ARTIFACT_INSPECTOR_DEFAULT_WIDTH),
  )
  const isDesktopViewport = useMediaQuery(PANEL_PIN_MEDIA_QUERY, true)
  const [rowWidth, setRowWidth] = useState(0)

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = () => setRowWidth(row.getBoundingClientRect().width)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(row)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  // In non-layout unit environments (rowWidth === 0), honour the media query; in real browsers, enforce the 480px main floor.
  const roomAllowsAside = rowWidth === 0 || rowWidth >= PANEL_MIN_MAIN + PANEL_WIDTH_MIN
  const isDesktopAside = isDesktopViewport && roomAllowsAside
  const effectiveWidth =
    rowWidth > 0
      ? Math.min(inspectorWidth, Math.max(PANEL_WIDTH_MIN, rowWidth - PANEL_MIN_MAIN))
      : inspectorWidth

  const resolveMaxWidth = useCallback(() => {
    const column = rowRef.current?.querySelector('[data-slot="artifact-content-column"]')
    if (!(column instanceof HTMLElement)) return PANEL_WIDTH_MAX
    const colWidth = column.getBoundingClientRect().width
    if (colWidth === 0) return PANEL_WIDTH_MAX
    const actualPanelWidth = asideRef.current?.getBoundingClientRect().width || effectiveWidth
    return Math.max(
      PANEL_WIDTH_MIN,
      Math.min(PANEL_WIDTH_MAX, actualPanelWidth + colWidth - PANEL_MIN_MAIN),
    )
  }, [effectiveWidth])

  const commitInspectorWidth = useCallback((next: number) => {
    const clamped = clampPanelWidth(next)
    setInspectorWidth(clamped)
    document.cookie = panelPinCookieString("artifactComments", { pinned: true, width: clamped })
    window.dispatchEvent(new Event("resize"))
  }, [])

  const closeInspector = useCallback((focusTarget?: "comments" | "details") => {
    const target = focusTarget ?? (activeTab === "comments" ? "comments" : "details")
    setInspectorOpen(false)
    if (target === "comments") commentsTriggerRef.current?.focus()
    else detailsTriggerRef.current?.focus()
  }, [activeTab])

  const activateTab = (tab: InspectorTab, refreshComments = false) => {
    setActiveTab(tab)
    if (tab !== "comments") setLastDetailTab(tab)
    setVisitedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }))
    if (tab === "comments" && (refreshComments || !visitedTabs.comments)) {
      setCommentsVisits((visits) => visits + 1)
    }
  }

  const handleCommentsButtonClick = () => {
    if (!inspectorOpen) {
      activateTab("comments", true)
      setInspectorOpen(true)
      return
    }
    if (activeTab !== "comments") {
      activateTab("comments", !visitedTabs.comments)
      return
    }
    closeInspector("comments")
  }

  const handleDetailsButtonClick = () => {
    if (!inspectorOpen) {
      activateTab(lastDetailTab)
      setInspectorOpen(true)
      return
    }
    if (activeTab === "comments") {
      activateTab(lastDetailTab)
      return
    }
    closeInspector("details")
  }

  const handleSheetOpenChange = (open: boolean) => {
    if (open) {
      setInspectorOpen(true)
      setVisitedTabs((prev) => (prev[activeTab] ? prev : { ...prev, [activeTab]: true }))
    } else {
      setInspectorOpen(false)
    }
  }

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === "ArrowRight") nextIndex = (index + 1) % INSPECTOR_TABS.length
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
    else if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = INSPECTOR_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = INSPECTOR_TABS[nextIndex].id
    activateTab(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  const artifactTypeLabel =
    artifact.sourceType === "V0_CHAT"
      ? "v0 chat"
      : artifact.sourceType === "EXTERNAL_LINK"
        ? "External"
        : artifact.kind === "SLIDE_DECK"
          ? "Slide deck"
          : "HTML prototype"

  const linked = solutions.filter((solution) => solution.linked)
  const available = solutions.filter((solution) => !solution.linked)
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      try {
        setError(null)
        await fn()
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Action failed")
      }
    })

  const externalUrl = artifact.currentRevision?.externalUrl ?? null
  const isEmbeddedExternal = Boolean(externalUrl && (isGoogleDriveUrl(externalUrl) || livePreviewSrc))
  const isCardStage = (artifact.sourceType === "EXTERNAL_LINK" || artifact.sourceType === "V0_CHAT") && !isEmbeddedExternal

  const commentsButtonActive = inspectorOpen && activeTab === "comments"
  const detailsButtonActive = inspectorOpen && activeTab !== "comments"

  const inspectorBody = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-default px-2">
        <div
          role="tablist"
          aria-label="Inspector sections"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {INSPECTOR_TABS.map((tab, index) => {
            const selected = activeTab === tab.id
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el
                }}
                type="button"
                role="tab"
                id={`artifact-inspector-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`artifact-inspector-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => activateTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={cn(
                  "relative shrink-0 cursor-pointer border-b-2 px-2 py-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                  selected
                    ? "border-primary text-primary"
                    : "border-transparent text-text-subtle hover:text-text-primary",
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => closeInspector()}
          aria-label="Close panel"
          title="Close panel"
          className="shrink-0"
        >
          {isDesktopAside ? <PanelRightClose aria-hidden /> : <X aria-hidden />}
        </Button>
      </div>

      {notice && !error && (
        <p role="status" className="shrink-0 border-b border-border-default bg-surface-inset px-4 py-2 text-xs text-text-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="shrink-0 border-b border-border-default bg-status-danger-surface px-4 py-2 text-xs text-status-danger">
          {error}
        </p>
      )}

      {visitedTabs.details && (
        <div
          role="tabpanel"
          id="artifact-inspector-panel-details"
          aria-labelledby="artifact-inspector-tab-details"
          hidden={activeTab !== "details"}
          className={activeTab === "details" ? "min-h-0 flex-1 space-y-5 overflow-y-auto p-4" : "hidden"}
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              run(() =>
                updateArtifact(
                  workspaceId,
                  artifact.id,
                  {
                    title: String(data.get("title")),
                    description: String(data.get("description")),
                    ...(artifact.sourceType === "HTML_UPLOAD"
                      ? { kind: data.get("kind") === "SLIDE_DECK" ? ("SLIDE_DECK" as const) : ("DOCUMENT" as const) }
                      : {}),
                  },
                  basePath,
                ),
              )
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor={`artifact-title-${artifact.id}`} className="block text-xs font-semibold uppercase tracking-wide text-text-subtle">
                Title
              </label>
              <Input id={`artifact-title-${artifact.id}`} key={artifact.title} name="title" defaultValue={artifact.title} required />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`artifact-description-${artifact.id}`} className="block text-xs font-semibold uppercase tracking-wide text-text-subtle">
                Description
              </label>
              <Textarea id={`artifact-description-${artifact.id}`} key={artifact.description ?? ""} name="description" defaultValue={artifact.description ?? ""} rows={3} />
            </div>
            {artifact.sourceType === "HTML_UPLOAD" && (
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <Checkbox name="kind" value="SLIDE_DECK" defaultChecked={artifact.kind === "SLIDE_DECK"} />
                Show as a slide deck
              </label>
            )}
            <Button type="submit" size="sm" disabled={pending}>
              Save details
            </Button>
          </form>

          <form
            className="space-y-3 border-t border-border-default pt-4"
            onSubmit={(event) => {
              event.preventDefault()
              run(() => replaceArtifactRevision(workspaceId, artifact.id, artifact.sourceType, new FormData(event.currentTarget), basePath))
            }}
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">New revision</h2>
            {artifact.sourceType === "V0_CHAT" ? (
              <p className="text-xs text-text-subtle">Revisions of a v0 chat come from v0. Use “Refresh from v0” in the top bar.</p>
            ) : artifact.sourceType === "EXTERNAL_LINK" ? (
              <Input name="url" type="url" aria-label="New revision URL" required placeholder="https://…" />
            ) : (
              <Input name="file" type="file" aria-label="New revision HTML file" accept=".html,text/html" required />
            )}
            {artifact.sourceType !== "V0_CHAT" && (
              <Button type="submit" variant="outline" size="sm" disabled={pending}>
                Replace current revision
              </Button>
            )}
          </form>

          {artifact.status === "ACTIVE" && (
            <div className="flex items-center justify-between gap-3 border-t border-border-default pt-4">
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-primary">Archive artifact</p>
                <p className="text-xs text-text-subtle">Removes it from the active Docs library.</p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => archiveArtifact(workspaceId, artifact.id, basePath))}>
                Archive
              </Button>
            </div>
          )}

          <div className="border-t border-border-default pt-3">
            <Link href={basePath} className="text-xs font-medium text-primary hover:underline">
              Back to Docs
            </Link>
          </div>
        </div>
      )}

      {visitedTabs.links && (
        <div
          role="tabpanel"
          id="artifact-inspector-panel-links"
          aria-labelledby="artifact-inspector-tab-links"
          hidden={activeTab !== "links"}
          className={activeTab === "links" ? "min-h-0 flex-1 space-y-4 overflow-y-auto p-4" : "hidden"}
        >
          <section className="space-y-3 rounded-lg border border-border-default p-4">
            <h2 className="text-base font-semibold text-text-primary">{`Linked ${labels.solution.lowerPlural}`}</h2>
            {linked.length === 0 ? (
              <p className="text-sm text-text-subtle">{`Not linked to ${labels.solution.indefinite}.`}</p>
            ) : (
              <ul className="space-y-2">
                {linked.map((solution) => (
                  <li key={solution.id} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm text-text-primary">{solution.title}</span>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unlinkArtifact(workspaceId, artifact.id, solution.id, basePath))}>
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {available.length > 0 && (
              <div className="flex min-w-0 gap-2">
                <select
                  aria-label={`${labels.solution.singular} to link`}
                  className="min-w-0 flex-1 rounded-md border border-border-default bg-surface-panel px-2.5 py-1.5 text-sm text-text-primary"
                  value={selectedSolution}
                  onChange={(event) => setSelectedSolution(event.target.value)}
                >
                  <option value="">{`Select ${labels.solution.indefinite}…`}</option>
                  {available.map((solution) => (
                    <option key={solution.id} value={solution.id}>
                      {solution.title}
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={!selectedSolution || pending} onClick={() => run(() => linkArtifact(workspaceId, artifact.id, selectedSolution, basePath))}>
                  Link
                </Button>
              </div>
            )}
          </section>

          {orgSlug && workspaceSlug && (
            <LinkedEntitiesSection
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              title="Linked experiments"
              fullWidth
              refreshKey={artifact.status}
              target={{ linkType: "ARTIFACT_ATTACHED_TO_EXPERIMENT", entityType: "ARTIFACT", entityId: artifact.id }}
            />
          )}

          <section className="min-w-0 space-y-3 rounded-lg border border-border-default p-4">
            <div>
              <h2 className="text-base font-semibold text-text-primary">Linked decisions</h2>
              <p className="text-xs text-muted-foreground">Live supporting material, not frozen approval evidence.</p>
            </div>
            {decisions.length === 0 ? (
              <p className="text-sm text-text-subtle">Not linked to a Decision. Add this Artifact from a Decision’s “Linked to” section.</p>
            ) : (
              <ul className="space-y-2">
                {decisions.map((decision) => (
                  <li key={decision.id} className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border-default p-2.5 sm:flex-row sm:items-center">
                    <Link
                      className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-medium text-primary hover:underline"
                      href={`${basePath.replace(/\/docs$/, "")}/reviews/${decision.id}`}
                    >
                      {decision.title}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">{decision.state === "DECIDED" ? "Decided" : "Pending"}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Unlink ${decision.title}`}
                      onClick={() => run(() => unlinkArtifactDecision(workspaceId, artifact.id, decision.id, basePath))}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {visitedTabs.share && (
        <div
          role="tabpanel"
          id="artifact-inspector-panel-share"
          aria-labelledby="artifact-inspector-tab-share"
          hidden={activeTab !== "share"}
          className={activeTab === "share" ? "min-h-0 flex-1 overflow-y-auto p-4" : "hidden"}
        >
          {shareState && artifact.sourceType === "HTML_UPLOAD" && (artifact.status === "ACTIVE" || shareState.enabled) ? (
            <ArtifactSharePanel workspaceId={workspaceId} artifactId={artifact.id} basePath={basePath} state={shareState} />
          ) : (
            <div className="rounded-lg border border-border-default bg-surface-inset/50 p-4 text-sm text-text-subtle">
              External sharing is available for active HTML artifacts.
            </div>
          )}
        </div>
      )}

      {visitedTabs.history && (
        <div
          role="tabpanel"
          id="artifact-inspector-panel-history"
          aria-labelledby="artifact-inspector-tab-history"
          hidden={activeTab !== "history"}
          className={activeTab === "history" ? "min-h-0 flex-1 space-y-3 overflow-y-auto p-4" : "hidden"}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Revision history</h2>
          {artifact.revisions.length === 0 ? (
            <p className="text-sm text-text-subtle">No revisions recorded.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {artifact.revisions.map((revision) => {
                const isCurrent = revision.revisionNumber === latestRevisionNumber
                const sourceDetail = revision.filename ?? (artifact.sourceType === "V0_CHAT" ? "v0 chat" : "External URL")
                return (
                  <li
                    key={revision.id}
                    data-current={isCurrent ? "true" : undefined}
                    className={cn(
                      "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2",
                      isCurrent ? "border border-primary/25 bg-primary/8" : "border border-transparent hover:bg-surface-inset",
                    )}
                  >
                    <span className={cn("font-semibold", isCurrent ? "text-primary" : "text-text-primary")}>
                      Revision {revision.revisionNumber}
                    </span>
                    <span className="truncate text-xs leading-5 text-text-secondary" title={sourceDetail}>
                      {sourceDetail}
                    </span>
                    <time dateTime={revision.createdAt} className="col-start-2 text-xs text-text-subtle">
                      {new Date(revision.createdAt).toLocaleString()}
                    </time>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}

      {visitedTabs.comments && (
        <div
          role="tabpanel"
          id="artifact-inspector-panel-comments"
          aria-labelledby="artifact-inspector-tab-comments"
          hidden={activeTab !== "comments"}
          className={activeTab === "comments" ? "min-h-0 flex-1 overflow-y-auto p-4" : "hidden"}
        >
          <p className="mb-3 text-xs text-muted-foreground">Whole-artifact discussion · continues across revisions.</p>
          <div ref={setCommentsSlot} />
        </div>
      )}
    </>
  )

  return (
    <div ref={rowRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      {/* @container: layout responds to this column's width, not the viewport's — the docked inspector narrows the column without changing the viewport. */}
      <div data-slot="artifact-content-column" className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border-default bg-surface-panel/95 px-3 py-1.5 backdrop-blur-sm @2xl:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <DocsLibraryButton />
            <h1 className="min-w-0 truncate text-sm font-semibold text-text-primary @4xl:text-base" title={artifact.title}>
              {artifact.title}
            </h1>
            <span className="hidden shrink-0 items-center rounded-full bg-surface-inset px-2.5 py-0.5 text-xs font-medium text-text-secondary @2xl:inline-flex">
              {artifactTypeLabel}
            </span>
            {latestRevisionNumber > 0 && (
              <span className="hidden shrink-0 text-xs text-text-subtle @3xl:inline">
                Rev {latestRevisionNumber}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 @3xl:gap-2">
            <div ref={setToolbarSlot} className="contents" />
            {artifact.sourceType === "V0_CHAT" && artifact.status === "ACTIVE" && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={pending ? "Refreshing…" : "Refresh from v0"}
                title={pending ? "Refreshing…" : "Refresh from v0"}
                onClick={() =>
                  run(async () => {
                    setNotice(null)
                    const result = await refreshArtifactFromV0(workspaceId, artifact.id, basePath)
                    if (result.error !== undefined) throw new Error(result.error)
                    setNotice(result.changed ? `New version captured as revision ${result.revisionNumber}.` : "Already up to date with v0.")
                  })
                }
              >
                <RefreshCw className={pending ? "animate-spin" : undefined} aria-hidden />
                <span className="hidden @3xl:inline">{pending ? "Refreshing…" : "Refresh from v0"}</span>
              </Button>
            )}
            <Button
              ref={commentsTriggerRef}
              variant="outline"
              size="sm"
              aria-expanded={commentsButtonActive}
              aria-label="Comments"
              title="Comments"
              className={cn(
                commentsButtonActive && "border-border-interactive bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
              onClick={handleCommentsButtonClick}
            >
              <MessageSquare aria-hidden />
              <span className="hidden @3xl:inline">Comments</span>
            </Button>
            <Button
              ref={detailsTriggerRef}
              variant="outline"
              size="sm"
              aria-expanded={detailsButtonActive}
              aria-label="Details"
              title="Details"
              className={cn(
                detailsButtonActive && "border-border-interactive bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
              onClick={handleDetailsButtonClick}
            >
              <Info aria-hidden />
              <span className="hidden @3xl:inline">Details</span>
            </Button>
          </div>
        </header>

        {artifact.status === "ARCHIVED" && (
          <div className="shrink-0 border-b border-border-default bg-status-warning-surface px-4 py-2 text-xs font-medium text-status-warning">
            This artifact is archived.
          </div>
        )}
        {newRevisionNotice !== null && (
          <p role="status" aria-live="polite" className="shrink-0 border-b border-border-default bg-surface-inset px-4 py-1.5 text-xs text-text-subtle">
            {`New revision ${newRevisionNotice} is now showing.`}
          </p>
        )}
        {!inspectorOpen && notice && !error && (
          <p role="status" className="shrink-0 border-b border-border-default bg-surface-inset px-4 py-1.5 text-xs text-text-secondary">
            {notice}
          </p>
        )}
        {!inspectorOpen && error && (
          <p role="alert" className="shrink-0 border-b border-border-default bg-status-danger-surface px-4 py-1.5 text-xs text-status-danger">
            {error}
          </p>
        )}

        {isCardStage ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 @2xl:p-6">
            <div className="mx-auto w-full max-w-4xl space-y-4">
              <ArtifactViewer
                title={artifact.title}
                html={html}
                slides={slides}
                initialSlideIndex={initialSlideIndex}
                toolbarSlot={toolbarSlot}
                externalUrl={externalUrl}
                thumbnail={artifact.currentRevision?.thumbnail}
                livePreviewSrc={livePreviewSrc}
                artifactId={artifact.id}
                fullScreenHref={`${basePath}/artifacts/${artifact.id}/full-screen`}
                onFeedbackPosted={() => setCommentsVisits((visits) => (visits > 0 ? visits + 1 : 0))}
              />
              {artifact.sourceType === "EXTERNAL_LINK" && artifact.status === "ACTIVE" && externalUrl && !isGoogleDriveUrl(externalUrl) && (
                <ArtifactScreenshotControls
                  key={latestRevisionCreatedAt(artifact.revisions)}
                  workspaceId={workspaceId}
                  artifactId={artifact.id}
                  basePath={basePath}
                  hasThumbnail={Boolean(artifact.currentRevision?.thumbnail)}
                  revisionCreatedAt={latestRevisionCreatedAt(artifact.revisions)}
                />
              )}
            </div>
          </div>
        ) : (
          <ArtifactViewer
            title={artifact.title}
            html={html}
            slides={slides}
            initialSlideIndex={initialSlideIndex}
            toolbarSlot={toolbarSlot}
            externalUrl={externalUrl}
            thumbnail={artifact.currentRevision?.thumbnail}
            livePreviewSrc={livePreviewSrc}
            artifactId={artifact.id}
            fullScreenHref={`${basePath}/artifacts/${artifact.id}/full-screen`}
            onFeedbackPosted={() => setCommentsVisits((visits) => (visits > 0 ? visits + 1 : 0))}
            bleed
          />
        )}
      </div>

      {isDesktopAside ? (
        inspectorOpen && (
          <aside
            ref={asideRef}
            aria-label="Artifact inspector"
            data-slot="artifact-inspector"
            className="relative hidden lg:flex shrink-0 min-h-0 min-w-0 flex-col overflow-hidden border-l border-border-default bg-surface-panel print:hidden"
            style={
              {
                [PANEL_WIDTH_PROPERTY]: `${effectiveWidth}px`,
                width: "var(--panel-w)",
                maxWidth: `calc(100% - ${PANEL_MIN_MAIN}px)`,
              } as CSSProperties
            }
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) {
                closeInspector()
              }
            }}
          >
            <PanelResizeHandle
              width={effectiveWidth}
              surfaceRef={asideRef}
              resolveMaxWidth={resolveMaxWidth}
              onCommit={commitInspectorWidth}
            />
            {inspectorBody}
          </aside>
        )
      ) : (
        <Sheet open={inspectorOpen} onOpenChange={handleSheetOpenChange}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            finalFocus={activeTab === "comments" ? commentsTriggerRef : detailsTriggerRef}
            className="flex h-[68dvh] max-h-[85dvh] w-full flex-col gap-0 rounded-t-2xl border-t border-border-default bg-surface-panel p-0 sm:max-w-none"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Artifact inspector</SheetTitle>
            </SheetHeader>
            <div aria-hidden className="mx-auto mt-2 mb-0.5 h-1 w-9 shrink-0 rounded-full bg-border-strong/60" />
            {inspectorBody}
          </SheetContent>
        </Sheet>
      )}

      {commentsVisits > 0 && (
        <Discussion
          key={artifact.id}
          targetType="ARTIFACT"
          targetId={artifact.id}
          refreshKey={commentsVisits}
          focusedCommentId={initialFocusedCommentId}
          render={(content) => (commentsSlot ? createPortal(content, commentsSlot) : null)}
        />
      )}
    </div>
  )
}

/** How long the "New revision N" indicator stays up. */
const NEW_REVISION_NOTICE_MS = 6_000

/**
 * The revision number to announce after the artifact gains a revision while the
 * page is open (an agent or another viewer published it), else null. The first
 * render and any revision already present never announce.
 */
function useNewRevisionNotice(latestRevisionNumber: number): number | null {
  const [seen, setSeen] = useState(latestRevisionNumber)
  const [announced, setAnnounced] = useState<number | null>(null)
  // Adjusting state during render (not in an effect) is the React-recommended way to derive from a changed prop.
  if (latestRevisionNumber !== seen) {
    setSeen(latestRevisionNumber)
    setAnnounced(latestRevisionNumber > seen ? latestRevisionNumber : null)
  }
  useEffect(() => {
    if (announced === null) return
    const timer = setTimeout(() => setAnnounced(null), NEW_REVISION_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [announced])
  return announced
}

/** How long after a link is saved the page keeps checking for its background capture. */
const BACKGROUND_CAPTURE_WINDOW_MS = 2 * 60_000
const BACKGROUND_CAPTURE_POLL_MS = 5_000

function latestRevisionCreatedAt(revisions: Array<{ revisionNumber: number; createdAt: string }>) {
  return revisions.reduce<{ revisionNumber: number; createdAt: string } | null>(
    (latest, revision) => (!latest || revision.revisionNumber > latest.revisionNumber ? revision : latest),
    null,
  )?.createdAt ?? ""
}

/**
 * The "Capture screenshot" / "Refresh screenshot" button for an external link.
 *
 * Saving a link schedules a background capture (scheduleArtifactThumbnailCapture),
 * which lands a few seconds after the page has already rendered without one. So
 * for a just-saved revision with no thumbnail yet, the page refreshes itself on a
 * short interval until the screenshot appears or the window closes — after that
 * the background capture is assumed to have failed, and the button is the retry.
 */
function ArtifactScreenshotControls({
  workspaceId,
  artifactId,
  basePath,
  hasThumbnail,
  revisionCreatedAt,
}: {
  workspaceId: string
  artifactId: string
  basePath: string
  hasThumbnail: boolean
  revisionCreatedAt: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(() => !hasThumbnail && Date.now() - Date.parse(revisionCreatedAt) < BACKGROUND_CAPTURE_WINDOW_MS)
  const showWaiting = waiting && !hasThumbnail

  useEffect(() => {
    if (!showWaiting) return
    const remaining = BACKGROUND_CAPTURE_WINDOW_MS - (Date.now() - Date.parse(revisionCreatedAt))
    const poll = setInterval(() => router.refresh(), BACKGROUND_CAPTURE_POLL_MS)
    const stop = setTimeout(() => setWaiting(false), Math.max(remaining, 0))
    return () => {
      clearInterval(poll)
      clearTimeout(stop)
    }
  }, [showWaiting, revisionCreatedAt, router])

  const capture = () =>
    startTransition(async () => {
      setError(null)
      const result = await captureArtifactThumbnail(workspaceId, artifactId, `${basePath}/artifacts/${artifactId}`)
      if (result.ok) {
        setWaiting(false)
        router.refresh()
      } else {
        setError(result.error)
      }
    })

  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <Button variant="outline" size="sm" disabled={pending} onClick={capture}>
        <Camera aria-hidden />
        {pending ? "Capturing…" : hasThumbnail ? "Refresh screenshot" : "Capture screenshot"}
      </Button>
      <p role="status" aria-live="polite" className="text-xs text-text-subtle">
        {pending ? "Rendering the page in a sandboxed browser — this takes a few seconds." : showWaiting ? "Capturing a screenshot in the background…" : null}
      </p>
      {error && (
        <p role="alert" className="text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  )
}
