import getPrisma from "@/lib/db";
import { requireWorkspaceContext } from "@/lib/workspace-context";
import { cookies } from "next/headers";
import type { DocTreeItem } from "@/components/docs/doc-tree-sidebar";
import { DocsLibraryPane } from "@/components/docs/docs-library-pane";
import { DocsLibraryProvider } from "@/components/docs/docs-library-context";
import {
  DOCS_LIBRARY_COOKIE_NAME,
  parseDocsLibraryState,
} from "@/lib/docs-library-pane";
import { DocsMobileDrawer } from "@/components/docs/docs-mobile-drawer";

interface DocsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

function buildDocTree(
  docs: Array<{
    id: string;
    title: string;
    icon: string | null;
    parentId: string | null;
    sortOrder: number;
    docType?: string;
  }>
): DocTreeItem[] {
  const sorted = [...docs].sort((a, b) => a.sortOrder - b.sortOrder);
  const map = new Map<string, DocTreeItem>();

  for (const doc of sorted) {
    map.set(doc.id, { ...doc, children: [] });
  }

  const roots: DocTreeItem[] = [];
  for (const doc of sorted) {
    const node = map.get(doc.id)!;
    if (doc.parentId && map.has(doc.parentId)) {
      map.get(doc.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export default async function DocsLayout({
  children,
  params,
}: DocsLayoutProps) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();
  const cookieStore = await cookies();

  // Resolves from the request memo — the parent workspace layout already
  // asked for this exact context, so this costs no additional statements.
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);

  const [rawDocs, artifacts] = await Promise.all([prisma.doc.findMany({
    where: { workspaceId: workspace.id },
    select: {
      id: true,
      title: true,
      icon: true,
      parentId: true,
      sortOrder: true,
      docType: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  }), prisma.artifact.findMany({
    where: { workspaceId: workspace.id, status: "ACTIVE" },
    select: { id: true, title: true, sourceType: true },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  })]);

  const tree = buildDocTree(rawDocs);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Mobile-only toolbar: Pages drawer trigger */}
      <div className="flex md:hidden items-center px-3 py-2 border-b border-border-default bg-surface-panel shrink-0">
        <DocsMobileDrawer
          docs={tree}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
          artifacts={artifacts}
        />
      </div>

      <DocsLibraryProvider
        initialState={parseDocsLibraryState(cookieStore.get(DOCS_LIBRARY_COOKIE_NAME)?.value)}
      >
        <div className="flex flex-1 overflow-hidden">
          {/* Library sidebar — hidden on mobile (drawer above), resizable and
              collapsible on md+. State comes from a cookie so the first paint
              is already the user's width. */}
          <DocsLibraryPane
            docs={tree}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            workspaceId={workspace.id}
            artifacts={artifacts}
          />
          <div className="flex-1 overflow-y-auto min-w-0">{children}</div>
        </div>
      </DocsLibraryProvider>
    </div>
  );
}
