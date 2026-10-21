import { resolveWorkItemPage, type PageSearchParams } from "@/lib/work-item-page";
import { resolveWorkItemId } from "@/lib/work-item-resolve";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import getPrisma from "@/lib/db";
import { getWorkspaceContext, requireWorkspaceContext } from "@/lib/workspace-context";
import { RoadmapItemDetail } from "@/components/roadmap/roadmap-item-detail";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; itemId: string }>;
  searchParams?: Promise<PageSearchParams>;
};

// The segment is a UUID or a display ID (RM-7); the resolver turns anything else into a 404, never a 500.

export async function generateMetadata({ params }: Props) {
  const { orgSlug, workspaceSlug, itemId } = await params;
  // Raw resolver, not requireWorkspaceContext: metadata degrades to a fallback
  // title rather than redirecting or 404ing, and never discloses a title to a
  // caller without workspace access.
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status !== "ok") return { title: "Roadmap item" };
  const resolvedId = await resolveWorkItemId(getPrisma(), context.workspace.id, "roadmapItem", itemId);
  const item = resolvedId ? await getPrisma().roadmapItem.findFirst({
    where: { id: resolvedId, workspaceId: context.workspace.id },
    select: { title: true },
  }) : null;
  return { title: item?.title ?? "Roadmap item" };
}

// Thin route shell: auth, a workspace-scoped existence check for the 404, and
// the breadcrumb chrome. The heavy per-field data loads client-side through the
// same scoped panel API the side panel uses. Private items are visible here to
// workspace members exactly as they are on the roadmap board; only the public
// portal hides them, and it does not use this route.
export default async function RoadmapItemPage({ params, searchParams }: Props) {
  const { orgSlug, workspaceSlug, itemId } = await params;
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);
  const item = await resolveWorkItemPage({ type: "roadmapItem", param: itemId, workspaceId: workspace.id, basePath: `/${orgSlug}/${workspaceSlug}/roadmap`, searchParams: await searchParams });

  return (
    <div className="min-h-full min-w-0 p-4 sm:p-6 md:p-8">
      <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6">
        <Link href={`/${orgSlug}/${workspaceSlug}/roadmap`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeftIcon className="size-4" /> Roadmap
        </Link>
        <RoadmapItemDetail itemId={item.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} variant="page" />
      </div>
    </div>
  );
}
