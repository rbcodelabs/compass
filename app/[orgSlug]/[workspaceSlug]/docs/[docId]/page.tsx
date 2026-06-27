import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { DocEditor } from "@/components/docs/doc-editor";

type Props = {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    docId: string;
  }>;
};

export async function generateMetadata({ params }: Props) {
  const { docId } = await params;
  const prisma = getPrisma();
  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true },
  });
  return { title: doc?.title ?? "Untitled" };
}

export default async function DocPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug, docId } = await params;
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

  const doc = await prisma.doc.findFirst({
    where: { id: docId, workspaceId: workspace.id },
    select: { id: true, title: true, content: true, icon: true, metadata: true },
  });

  if (!doc) notFound();

  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/docs/${docId}`;

  return (
    <DocEditor
      doc={doc}
      revalidatePathStr={revalidatePathStr}
    />
  );
}
