import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import getPrisma from "@/lib/db";
import { createFirstDoc } from "./actions";
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
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center p-6">
      <EmptyState className="w-full max-w-xl" icon={<BookOpen className="size-6" />} title="No pages yet" description="Create your first page to start documenting." primaryAction={
      <form action={createFirstDoc.bind(null, orgSlug, workspaceSlug)}>
        <Button type="submit">Create your first page</Button>
      </form>
      } />
    </div>
  );
}
