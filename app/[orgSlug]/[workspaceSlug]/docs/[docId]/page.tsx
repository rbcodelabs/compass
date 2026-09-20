import { auth } from "@/auth";
import { cookies } from "next/headers";
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin";
import { redirect, notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { DocEditor } from "@/components/docs/doc-editor";
import { DocDecisionAction } from "@/components/docs/doc-decision-action";
import { listDocDecisions } from "@/lib/tracked-decisions";
import { fetchLinkedTasksBundle } from "@/lib/linked-tasks";

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

  // An unavailable lookup is distinct from a document with no decisions.
  const decisions = await listDocDecisions(workspace.id, doc.id).catch(() => null);

  // Lightweight fields only (no content) -- the full snapshot is fetched on
  // demand when a version is opened in the history panel, so opening a doc
  // doesn't pull every historical content blob along with it.
  const versions = await prisma.docVersion.findMany({
    where: { docId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, createdByName: true, createdAt: true },
  });

  // All inline comments (open + resolved) for the doc — the editor highlights
  // the open/anchored ones and the sidebar filters resolved behind a toggle.
  const comments = await prisma.docComment.findMany({
    where: { docId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      parentId: true,
      body: true,
      status: true,
      anchorText: true,
      anchorStart: true,
      anchorEnd: true,
      anchorPrefix: true,
      anchorSuffix: true,
      authorName: true,
      authorType: true,
      createdAt: true,
    },
  });

  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/docs/${docId}`;

  const linkedTasks = await fetchLinkedTasksBundle(workspace.id, "DOC", doc.id);
  const cookieStore = await cookies();

  return (
    <DocEditor
      doc={doc}
      initialCommentsPin={parsePanelPin(cookieStore.get(panelPinCookieName("docsComments"))?.value)}
      initialHistoryPin={parsePanelPin(cookieStore.get(panelPinCookieName("docsHistory"))?.value)}
      versions={versions}
      comments={comments}
      revalidatePathStr={revalidatePathStr}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={workspace.id}
      linkedTasks={linkedTasks}
      decisionAction={<DocDecisionAction orgSlug={orgSlug} workspaceSlug={workspaceSlug} docId={doc.id} docTitle={doc.title} decisions={decisions} />}
    />
  );
}
