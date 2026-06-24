import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { DocTreeSidebar, type DocTreeItem } from "@/components/docs/doc-tree-sidebar";

interface DocsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export function buildDocTree(
  docs: Array<{
    id: string;
    title: string;
    icon: string | null;
    parentId: string | null;
    sortOrder: number;
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
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId: session.user.id } },
    },
    select: { id: true },
  });

  if (!workspace) notFound();

  const rawDocs = await prisma.doc.findMany({
    where: { workspaceId: workspace.id },
    select: {
      id: true,
      title: true,
      icon: true,
      parentId: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const tree = buildDocTree(rawDocs);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-60 shrink-0 border-r border-slate-200 overflow-y-auto bg-white p-2">
        <DocTreeSidebar
          docs={tree}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
        />
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
