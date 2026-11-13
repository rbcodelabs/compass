import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import getPrisma from "@/lib/db";
import { resolveWorkspaceAccess } from "@/lib/workspace-context";
import { createFirstDoc } from "./actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { DocsLibraryButton } from "@/components/docs/docs-library-button";
import { DocsLibraryViewToggle } from "@/components/docs/docs-library-view-toggle";
import { LibraryByType, LibraryOverview, LibraryRecent } from "@/components/docs/docs-library-views";
import {
  LIBRARY_LATEST_LIMIT,
  groupDocsByKind,
  kindCounts,
  parseLibraryView,
  recentDocs,
  LIBRARY_RECENT_LIMIT,
  type LibraryDoc,
} from "@/lib/docs-library";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
};

export const metadata = {
  title: "Docs",
};

/**
 * The Docs index is the Library overview: what is in this workspace by type, and what changed lately. It used to redirect to the first
 * doc; the tree itself stays in the agent rail's Library view (components/agent/rail-library-pane.tsx), opened by the header button.
 * Views are `?view=overview` (default), `by-type` and `recent`. Docs only: artifacts stay in the rail.
 */
export default async function DocsIndexPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const view = parseLibraryView((await searchParams).view);
  const prisma = getPrisma();

  // Membership-or-org-read-only-fallback check. Redundant with docs/layout.tsx's
  // own requireWorkspaceContext() gate above this page in the tree, but kept
  // (rather than trusting the layout alone) for the same reason the original
  // membership-only version of this query existed: a page that renders under a
  // gated layout should not silently rely on that layout never changing.
  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id);
  if (!access) notFound();
  const canCreate = !access.isReadOnly;

  const rows = await prisma.doc.findMany({
    where: { workspaceId: access.workspaceId },
    select: { id: true, title: true, kind: true, docType: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const docs: LibraryDoc[] = rows;

  // Empty workspace.
  if (docs.length === 0) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center p-6">
        <EmptyState
          className="w-full max-w-xl"
          icon={<BookOpen className="size-6" />}
          title="No pages yet"
          description={canCreate ? "Create your first page to start documenting." : "Nothing has been documented in this workspace yet."}
          primaryAction={
            canCreate ? (
              <form action={createFirstDoc.bind(null, orgSlug, workspaceSlug)}>
                <Button type="submit">Create your first page</Button>
              </form>
            ) : undefined
          }
        />
      </div>
    );
  }

  const basePath = `/${orgSlug}/${workspaceSlug}/docs`;
  const counts = kindCounts(docs);

  return (
    <WorkspacePage
      leading={<DocsLibraryButton />}
      title="Docs"
      description={`${counts.total} ${counts.total === 1 ? "doc" : "docs"} in this workspace`}
      contentClassName="p-0 sm:p-0 md:overflow-auto md:p-0"
      actions={
        <>
          <DocsLibraryViewToggle view={view} />
          {canCreate && (
            <form action={createFirstDoc.bind(null, orgSlug, workspaceSlug)}>
              <Button type="submit" size="sm">New doc</Button>
            </form>
          )}
        </>
      }
    >
      {view === "by-type" ? (
        <LibraryByType groups={groupDocsByKind(docs)} basePath={basePath} />
      ) : view === "recent" ? (
        <LibraryRecent docs={recentDocs(docs, LIBRARY_RECENT_LIMIT)} basePath={basePath} />
      ) : (
        <LibraryOverview counts={counts} latest={recentDocs(docs, LIBRARY_LATEST_LIMIT)} basePath={basePath} />
      )}
    </WorkspacePage>
  );
}
