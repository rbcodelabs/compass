import { auth } from "@/auth";
import { resolveWorkspaceAccess } from "@/lib/workspace-context";
import { listDocCommentsCore } from "@/lib/doc-comments";
import { cookies } from "next/headers";
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin";
import { redirect, notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { DocEditor } from "@/components/docs/doc-editor";
import { CanvasDocEditor } from "@/components/docs/canvas/canvas-doc-editor";
import { DocDecisionAction } from "@/components/docs/doc-decision-action";
import { listDocDecisions } from "@/lib/tracked-decisions";
import { fetchLinkedTasksBundle } from "@/lib/linked-tasks";
import { hydrateDocument } from "@/lib/document-service";

type Props = {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    docId: string;
  }>;
};

export async function generateMetadata({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) return { title: "Document" };
  const { docId, orgSlug, workspaceSlug } = await params;
  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id);
  if (!access) return { title: "Document" };
  const doc = await getPrisma().doc.findFirst({
    where: { id: docId, workspaceId: access.workspaceId },
    select: { title: true },
  });
  return { title: doc?.title ?? "Untitled" };
}

export default async function DocPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug, docId } = await params;
  const prisma = getPrisma();

  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id);
  if (!access) notFound();
  const workspace = { id: access.workspaceId };

  const storedDoc = await prisma.doc.findFirst({
    where: { id: docId, workspaceId: workspace.id },
    select: { id: true, title: true, content: true, icon: true, metadata: true, storageProvider: true, contentRef: true, revision: true, docType: true },
  });

  if (!storedDoc) notFound();
  const doc = await hydrateDocument(workspace.id, storedDoc);

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
  const comments = await listDocCommentsCore(docId);

  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/docs/${docId}`;

  const linkedTasks = await fetchLinkedTasksBundle(workspace.id, "DOC", doc.id);
  const cookieStore = await cookies();

  if (doc.docType === "CANVAS") {
    return (
      <CanvasDocEditor
        key={doc.id}
        doc={{ id: doc.id, title: doc.title, content: doc.content, icon: doc.icon, revision: doc.revision }}
        versions={versions}
        revalidatePathStr={revalidatePathStr}
        initialHistoryPin={parsePanelPin(cookieStore.get(panelPinCookieName("docsHistory"))?.value)}
        decisionAction={<DocDecisionAction orgSlug={orgSlug} workspaceSlug={workspaceSlug} docId={doc.id} docTitle={doc.title} decisions={decisions} />}
      />
    );
  }

  return (
    <DocEditor
      key={doc.id}
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
