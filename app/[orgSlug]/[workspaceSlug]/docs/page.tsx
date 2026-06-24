import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import getPrisma from "@/lib/db";
import { createDoc } from "./actions";

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
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
      <div className="w-14 h-14 rounded-2xl bg-indigo-50 flex items-center justify-center">
        <BookOpen className="w-7 h-7 text-indigo-400" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-slate-800">No pages yet</h2>
        <p className="text-sm text-slate-500 mt-1">
          Create your first page to start documenting.
        </p>
      </div>
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
        <button
          type="submit"
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          Create your first page
        </button>
      </form>
    </div>
  );
}
