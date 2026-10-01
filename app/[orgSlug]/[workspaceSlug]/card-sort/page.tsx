import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { listCardSortFactors, listCardSortRounds } from "@/lib/card-sort"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { NewRoundForm } from "@/components/card-sort/new-round-form"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

export default async function CardSortIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) notFound()

  const [factors, rounds] = await Promise.all([
    listCardSortFactors({ workspaceId: workspace.id, objectType: "OPPORTUNITY" }),
    listCardSortRounds({ workspaceId: workspace.id, userId: session.user.id }),
  ])

  return (
    <WorkspacePage
      title="Card sort"
      description="Propose moves on any SELECT custom field, then tally what the room actually thinks."
      contentClassName="gap-5 md:overflow-y-auto"
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Start a round</h2>
        <NewRoundForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          factors={factors.map((factor) => ({
            id: factor.id,
            name: factor.name,
            options: factor.options,
            sharedOptionSetName: factor.sharedOptionSetName,
          }))}
        />
        <p className="text-xs text-text-secondary">
          A round is a container so this quarter&rsquo;s opinions do not pollute next
          quarter&rsquo;s. Proposals are recorded against the round, never written back to the
          official field value.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Rounds</h2>
        {rounds.length === 0 ? (
          <p className="text-sm text-text-secondary">No rounds yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rounds.map((round) => (
              <li key={round.id}>
                <Link
                  href={`/${orgSlug}/${workspaceSlug}/card-sort/${round.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm ring-1 ring-border-default hover:bg-surface-panel"
                >
                  <Badge variant={round.state === "OPEN" ? "default" : "secondary"}>
                    {round.state}
                  </Badge>
                  <span className="font-medium">{round.name}</span>
                  <span className="text-text-secondary">factor {round.factorName}</span>
                  <span className="ml-auto text-xs text-text-secondary">
                    {/*
                      proposalCount is null when the caller may not know it yet.
                      Rendering `?? 0` here would print a false zero and undo the
                      redaction, which is why the type is nullable rather than a
                      number the UI is trusted to hide.
                    */}
                    {round.myProposalCount} from you
                    {round.proposalCount !== null && ` · ${round.proposalCount} total`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </WorkspacePage>
  )
}
