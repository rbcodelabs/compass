import { Suspense } from "react"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { ExperimentBoard } from "@/components/experiments/experiment-board"
import { NewExperimentButton } from "@/components/experiments/new-experiment-button"
import { ExperimentsFilters } from "@/components/experiments/experiments-filters"
import { ExperimentsGallery } from "@/components/experiments/experiments-gallery"
import { ExperimentsViewToggle } from "@/components/experiments/experiments-view-toggle"
import { ExperimentsGroupByToggle } from "@/components/experiments/experiments-group-by-toggle"
import { loadExperimentGalleryExtras } from "@/lib/experiments/gallery-server"
import { parseExperimentGalleryGroupMode, parseExperimentsView, type ExperimentGalleryItem } from "@/lib/experiments/gallery"
import type { ExperimentStatus, SquadData } from "@/lib/types"
import { experimentComposerId } from "@/lib/experiment-draft"
import type { ExperimentCardData } from "@/components/experiments/experiment-card"
import { WorkspacePage } from "@/components/patterns/workspace-page"

export const metadata = {
  title: "Experiments",
}

interface ExperimentsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ squad?: string; assumptionId?: string; view?: string; groupBy?: string }>
}

export default async function ExperimentsPage({
  params,
  searchParams,
}: ExperimentsPageProps) {
  const { orgSlug, workspaceSlug } = await params
  const { squad: squadFilter, assumptionId: legacyAssumptionId, view: viewParam, groupBy: groupByParam } = await searchParams
  const view = parseExperimentsView(viewParam)

  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    redirect("/login")
  }

  const workspace = await getWorkspace(orgSlug, workspaceSlug, userId)
  if (!workspace) {
    redirect("/dashboard")
  }

  // Links from before the composer moved into the side panel used
  // ?assumptionId=<id>. Forward them so old bookmarks and shared URLs still land
  // on the composer with that assumption preset.
  if (legacyAssumptionId) {
    const params = new URLSearchParams()
    if (squadFilter) params.set("squad", squadFilter)
    if (view === "gallery") params.set("view", view)
    params.set("detail", `experiment-new:${experimentComposerId(legacyAssumptionId)}`)
    redirect(`/${orgSlug}/${workspaceSlug}/experiments?${params.toString()}`)
  }

  const prisma = getPrisma()

  const [rawSquads, rawExperiments] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        hypothesis: true,
        killCondition: true,
        status: true,
        sortOrder: true,
        conclusion: true,
        squadId: true,
      },
    }),
  ])

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }))

  const experiments: ExperimentCardData[] = rawExperiments.map((e) => ({
    id: e.id,
    title: e.title,
    hypothesis: e.hypothesis,
    killCondition: e.killCondition,
    status: e.status as ExperimentStatus,
    sortOrder: e.sortOrder,
    conclusion: e.conclusion,
  }))

  // Only the Gallery pays for artifact + screenshot lookups.
  const gallery = view === "gallery"
  const squadById = new Map(squads.map((s) => [s.id, s]))
  const galleryItems: ExperimentGalleryItem[] = gallery
    ? rawExperiments.map((e) => ({
        id: e.id,
        title: e.title,
        hypothesis: e.hypothesis,
        status: e.status as ExperimentStatus,
        conclusion: e.conclusion,
        squad: (e.squadId ? squadById.get(e.squadId) : undefined) ?? null,
      }))
    : []
  const galleryExtras = gallery ? await loadExperimentGalleryExtras(prisma, workspace.id, rawExperiments.map((e) => e.id)) : null
  const groupMode = parseExperimentGalleryGroupMode(groupByParam)

  return (
    <WorkspacePage
      title="Experiments"
      contentClassName="p-0 sm:p-0 md:p-0"
      actions={(
        <>
          <ExperimentsViewToggle view={view} />
          {gallery && <ExperimentsGroupByToggle value={groupMode} />}
          <Suspense>
            <ExperimentsFilters squads={squads} />
          </Suspense>
          <NewExperimentButton />
        </>
      )}
    >
      {gallery && galleryExtras ? (
        <ExperimentsGallery
          experiments={galleryItems}
          extras={galleryExtras}
          squads={squads}
          groupMode={groupMode}
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      ) : (
        <ExperimentBoard
          key={experiments.map((e) => e.id).join(",")}
          experiments={experiments}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
        />
      )}
    </WorkspacePage>
  )
}
