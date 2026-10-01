import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { GitFork, Table2 } from "lucide-react"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { CardSortError, getCardSortTally } from "@/lib/card-sort"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { CardSortFlowView } from "@/components/card-sort/card-sort-flow-view"
import { CardSortTallyView } from "@/components/card-sort/card-sort-tally-view"
import { TallySummary } from "@/components/card-sort/card-sort-tally-intro"
import { CardSortViewToggle } from "@/components/card-sort/card-sort-view-toggle"

export const dynamic = "force-dynamic"

export default async function CardSortTallyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; roundId: string }>
  searchParams: Promise<{ view?: string }>
}) {
  const { orgSlug, workspaceSlug, roundId } = await params
  // Flow arrows by default; the table is one click away. Same lenient parse as
  // the round board — an unrecognised value renders the default.
  const view = (await searchParams).view === "table" ? "table" : "flow"
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) notFound()

  // getCardSortTally throws HIDDEN_UNTIL_REVEALED for a participant on an OPEN
  // round. This page renders that as a message rather than swallowing it,
  // because the gate is in the data layer and the page is downstream of it —
  // there is no branch here that could accidentally fetch the data anyway.
  let tally
  try {
    tally = await getCardSortTally({ workspaceId: workspace.id, roundId, userId: session.user.id })
  } catch (error) {
    if (error instanceof CardSortError) {
      if (error.code === "NOT_FOUND") notFound()
      if (error.code === "HIDDEN_UNTIL_REVEALED") {
        return (
          <WorkspacePage title="Tally not available yet" description="Card sort">
            <p className="max-w-prose text-sm text-text-secondary">{error.message}</p>
            <p className="mt-3 text-sm">
              <Link href={`/${orgSlug}/${workspaceSlug}/card-sort/${roundId}`} className="underline">
                Back to the board
              </Link>
            </p>
          </WorkspacePage>
        )
      }
    }
    throw error
  }

  return (
    <WorkspacePage
      title={`${tally.round.name} — tally`}
      description={
        <TallySummary
          tally={tally}
          boardHref={`/${orgSlug}/${workspaceSlug}/card-sort/${roundId}`}
        />
      }
      actions={
        <CardSortViewToggle
          label="Tally view"
          options={[
            {
              href: `/${orgSlug}/${workspaceSlug}/card-sort/${roundId}/tally?view=flow`,
              label: "Flow",
              icon: GitFork,
              current: view === "flow",
            },
            {
              href: `/${orgSlug}/${workspaceSlug}/card-sort/${roundId}/tally?view=table`,
              label: "Table",
              icon: Table2,
              current: view === "table",
            },
          ]}
        />
      }
      contentClassName="md:overflow-y-auto"
    >
      {view === "flow" ? (
        <CardSortFlowView tally={tally} />
      ) : (
        <CardSortTallyView tally={tally} />
      )}
    </WorkspacePage>
  )
}
