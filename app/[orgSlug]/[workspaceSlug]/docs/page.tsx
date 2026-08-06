import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import getPrisma from "@/lib/db";
import { createDoc } from "./actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export const metadata = {
  title: "Docs",
};

export default async function DocsIndexPage({ params }: Props) {
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

  const firstDoc = await prisma.doc.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  if (firstDoc) {
    redirect(`/${orgSlug}/${workspaceSlug}/docs/${firstDoc.id}`);
  }

  // Empty state
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`;

  return (
    <div className="flex h-full min-h-[400px] items-center justify-center p-6">
      <EmptyState className="w-full max-w-xl" icon={<BookOpen className="size-6" />} title="No pages yet" description="Create your first page to start documenting." primaryAction={
      <form
        action={async () => {
          "use server";
          const prismaInner = getPrisma();
          const ws = await prismaInner.workspace.findFirst({
            where: {
              slug: workspaceSlug,
              organization: { slug: orgSlug },
            },
            select: { id: true },
          });
          if (!ws) return;
          await createDoc(ws.id, null, basePath);
          redirect(`/${orgSlug}/${workspaceSlug}/docs`);
        }}
      >
        <Button type="submit">Create your first page</Button>
      </form>
      } />
    </div>
  );
}
