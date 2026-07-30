import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { getCanvasOverview } from "@/lib/canvas/data";
import { CanvasFlow } from "@/components/canvas/canvas-flow";

export const metadata = {
  title: "Canvas",
};

interface CanvasPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function CanvasPage({ params }: CanvasPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  // Resolve workspace by slug + org slug — membership already gated by the
  // parent layout.tsx, same pattern as okrs/page.tsx.
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  // Scope: all OKR cycles, not just active. This is deliberate — the
  // Canvas viewer's stated acceptance criterion is validating render/pan/
  // zoom at scale across a full portfolio; scoping to only the active cycle
  // would make that test meaningless.
  const overview = await getCanvasOverview(prisma, workspace.id);

  return (
    <main className="flex flex-col h-full">
      <div className="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-6 md:p-8 pb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
            Canvas
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Pan and zoom across your full OKR, discovery, and roadmap graph.
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <CanvasFlow overview={overview} />
      </div>
    </main>
  );
}
