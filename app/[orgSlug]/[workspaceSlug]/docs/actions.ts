"use server";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import { createPositioningBriefCore } from "@/lib/positioning-brief";
import { LAUNCH_WORKFLOW_DISABLED_MESSAGE } from "@/lib/launch-checklist";
import { maybeSnapshotDocVersion, restoreDocVersionCore } from "@/lib/doc-versions";
import {
  createDocCommentCore,
  listDocCommentsCore,
  setDocCommentStatusCore,
  deleteDocCommentCore,
} from "@/lib/doc-comments";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { fetchLinkedTasksBundle } from "@/lib/linked-tasks";
import { validateTaskLink } from "@/lib/task-assignment";
import {
  archiveArtifact as archiveArtifactCore,
  createExternalArtifact,
  createHtmlArtifact,
  linkArtifactToSolution,
  linkArtifactToDecision,
  unlinkArtifactFromDecision,
  replaceExternalArtifactRevision,
  replaceHtmlArtifactRevision,
  unlinkArtifactFromSolution,
  updateArtifactMetadata,
  MAX_ARTIFACT_HTML_BYTES,
} from "@/lib/artifacts";

async function requireWorkspaceMember(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getPrisma().workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId: session.user.id } } },
    select: { id: true },
  });
  if (!workspace) throw new Error("Workspace not found or access denied");
  return session.user;
}

export async function createArtifact(workspaceId: string, formData: FormData, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const sourceType = String(formData.get("sourceType") ?? "");
  if (!title) throw new Error("Title is required");
  const common = { workspaceId, title, description, createdById: user.id, source: "UI" as const };
  const artifact = sourceType === "EXTERNAL_LINK"
    ? await createExternalArtifact({ ...common, url: String(formData.get("url") ?? "") })
    : await (async () => {
        const file = formData.get("file");
        if (!(file instanceof File)) throw new Error("HTML file is required");
        if (file.size > MAX_ARTIFACT_HTML_BYTES) throw new Error("HTML file exceeds the 2 MB size limit");
        return createHtmlArtifact({
          ...common, filename: file.name, mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }, getArtifactStorage());
      })();
  revalidatePath(revalidatePathStr);
  return { id: artifact.id };
}

export async function updateArtifact(
  workspaceId: string,
  artifactId: string,
  data: { title?: string; description?: string | null },
  revalidatePathStr: string
) {
  const user = await requireWorkspaceMember(workspaceId);
  await updateArtifactMetadata({ workspaceId, artifactId, ...data, updatedById: user.id });
  revalidatePath(revalidatePathStr);
}

export async function replaceArtifactRevision(workspaceId: string, artifactId: string, sourceType: string, formData: FormData, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  if (sourceType === "EXTERNAL_LINK") {
    await replaceExternalArtifactRevision({ artifactId, workspaceId, url: String(formData.get("url") ?? ""), createdById: user.id, source: "UI" });
  } else {
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("HTML file is required");
    if (file.size > MAX_ARTIFACT_HTML_BYTES) throw new Error("HTML file exceeds the 2 MB size limit");
    await replaceHtmlArtifactRevision({ artifactId, workspaceId, filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), createdById: user.id, source: "UI" }, getArtifactStorage());
  }
  revalidatePath(revalidatePathStr);
}

export async function archiveArtifact(workspaceId: string, artifactId: string, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  await archiveArtifactCore({ workspaceId, artifactId, updatedById: user.id });
  revalidatePath(revalidatePathStr);
}

export async function linkArtifact(workspaceId: string, artifactId: string, solutionId: string, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  const result = await linkArtifactToSolution({ workspaceId, artifactId, solutionId, createdById: user.id, source: "UI" });
  revalidatePath(revalidatePathStr);
  return result;
}

export async function unlinkArtifact(workspaceId: string, artifactId: string, solutionId: string, revalidatePathStr: string) {
  await requireWorkspaceMember(workspaceId);
  const result = await unlinkArtifactFromSolution({ workspaceId, artifactId, solutionId });
  revalidatePath(revalidatePathStr);
  return result;
}

function revalidateDecisionArtifact(basePath: string, artifactId: string, requestId: string) {
  revalidatePath(`${basePath}/artifacts/${artifactId}`);
  revalidatePath(`${basePath.replace(/\/docs$/, "")}/reviews/${requestId}`);
}

export async function linkArtifactDecision(workspaceId: string, artifactId: string, requestId: string, basePath: string) {
  const user = await requireWorkspaceMember(workspaceId);
  const result = await linkArtifactToDecision({ workspaceId, artifactId, requestId, createdById: user.id, source: "UI" });
  revalidateDecisionArtifact(basePath, artifactId, requestId);
  return result;
}

export async function unlinkArtifactDecision(workspaceId: string, artifactId: string, requestId: string, basePath: string) {
  await requireWorkspaceMember(workspaceId);
  const result = await unlinkArtifactFromDecision({ workspaceId, artifactId, requestId });
  revalidateDecisionArtifact(basePath, artifactId, requestId);
  return result;
}

export async function createDoc(
  workspaceId: string,
  parentId: string | null,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const doc = await prisma.doc.create({
    data: { workspaceId, parentId, title: "Untitled" },
  });
  revalidatePath(revalidatePathStr);
  return doc;
}

export async function updateDoc(
  docId: string,
  data: { title?: string; content?: string; icon?: string },
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();

  // Snapshot the doc's pre-change state before applying the new values —
  // but only when this call actually changes something (title/content/icon
  // present), so a no-op call never creates a version.
  if (data.title !== undefined || data.content !== undefined || data.icon !== undefined) {
    await maybeSnapshotDocVersion(docId, {
      authorId: session.user.id,
      authorName: session.user.name ?? session.user.email ?? "Unknown",
    });
  }

  await prisma.doc.update({
    where: { id: docId },
    data: { ...data, updatedAt: new Date() },
  });
  revalidatePath(revalidatePathStr);
}

/**
 * Save a manual, named snapshot of a doc's current content — bypasses the
 * coalescing window in maybeSnapshotDocVersion since a label is always set.
 */
export async function createDocVersion(
  docId: string,
  label: string | undefined,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  await maybeSnapshotDocVersion(docId, {
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Unknown",
    label: label?.trim() || "Snapshot",
  });
  revalidatePath(revalidatePathStr);
}

export async function updateDocMetadata(
  docId: string,
  metadata: Record<string, unknown>,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  await prisma.doc.update({
    where: { id: docId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: metadata as any, updatedAt: new Date() },
  });
  revalidatePath(revalidatePathStr);
}

/**
 * Create (or return the existing) Positioning & Messaging Brief for a roadmap
 * item, from the roadmap-item panel's Launch section. Returns the brief's doc
 * id so the caller can navigate straight to the editor.
 */
export async function createPositioningBrief(
  roadmapItemId: string,
  workspaceId: string,
  revalidatePathStr: string
): Promise<{ docId: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const result = await createPositioningBriefCore(roadmapItemId, workspaceId);
  if (!result.ok) {
    throw new Error(
      result.error === "launch_workflow_disabled"
        ? LAUNCH_WORKFLOW_DISABLED_MESSAGE
        : "Roadmap item not found"
    );
  }

  revalidatePath(revalidatePathStr);
  return { docId: result.docId };
}

/**
 * Fetch a single saved version's full content, on demand from the version
 * history panel — kept out of the doc page's initial payload (which only
 * carries id/label/author/createdAt for each version) so opening a doc
 * doesn't pull every historical content blob along with it.
 */
export async function getDocVersionContent(versionId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const version = await prisma.docVersion.findUnique({
    where: { id: versionId },
    select: { id: true, title: true, content: true, createdAt: true, label: true, createdByName: true },
  });
  if (!version) throw new Error("Version not found");
  return version;
}

/**
 * Restore a doc's live content to a previously saved version. The doc's
 * current state is snapshotted first (label "Before restore") so nothing is
 * ever lost by restoring.
 */
export async function restoreDocVersion(versionId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const restored = await restoreDocVersionCore(versionId, {
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Unknown",
  });
  if (!restored) throw new Error("Version not found");

  revalidatePath(revalidatePathStr);
  return restored;
}

/**
 * Re-fetch a doc's linked-tasks bundle after the LinkedTasksSection (see
 * components/tasks/linked-tasks-section.tsx) adds or links a delivery task.
 * The doc page is a server component (not SWR-backed like the panels), so
 * DocEditor keeps its own local copy of this bundle and calls back here to
 * refresh it, the same way it already manages comments/versions locally.
 */
export async function getDocLinkedTasks(workspaceId: string, docId: string) {
  await requireWorkspaceMember(workspaceId);
  // Confirm the doc actually belongs to this workspace before reading its
  // bundle — same existence/scope check the write path (requireLinkedEntityWorkspace
  // in tasks/actions.ts, via validateTaskLink) already enforces. Not currently
  // exploitable (requireWorkspaceMember still gates by caller-supplied
  // workspaceId), but this keeps the read path's validation discipline
  // consistent with the write path's.
  await validateTaskLink(workspaceId, "DOC", docId);
  return fetchLinkedTasksBundle(workspaceId, "DOC", docId);
}

export async function deleteDoc(docId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  // DSQL has no FK cascade (relationMode = "prisma" emulates referential
  // integrity client-side under NoAction) — delete dependent rows first or
  // the doc.delete below throws on orphaned children.
  await prisma.docVersion.deleteMany({ where: { docId } });
  await prisma.docComment.deleteMany({ where: { docId } });
  await prisma.doc.delete({ where: { id: docId } });
  revalidatePath(revalidatePathStr);
}

// ─── Inline comments ──────────────────────────────────────────────────────────
// Thin session-authenticated wrappers over the shared core in lib/doc-comments.ts
// (the same core the MCP tools call), attributing writes to the signed-in user.

export async function addDocComment(
  input: {
    docId: string;
    body: string;
    parentId?: string | null;
    anchorText?: string | null;
    anchorPrefix?: string | null;
    anchorSuffix?: string | null;
    anchorStart?: number | null;
    anchorEnd?: number | null;
  },
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const result = await createDocCommentCore({
    ...input,
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Unknown",
    authorType: "HUMAN",
    source: "UI",
  });
  if (!result.ok) throw new Error(`Could not add comment (${result.error})`);

  revalidatePath(revalidatePathStr);
  return result.comment;
}

export async function listDocComments(docId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return listDocCommentsCore(docId);
}

export async function resolveDocComment(
  commentId: string,
  resolved: boolean,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const updated = await setDocCommentStatusCore(commentId, resolved ? "RESOLVED" : "OPEN");
  if (!updated) throw new Error("Comment not found");

  revalidatePath(revalidatePathStr);
  return updated;
}

export async function deleteDocComment(commentId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const result = await deleteDocCommentCore(commentId);
  if (!result) throw new Error("Comment not found");

  revalidatePath(revalidatePathStr);
  return result;
}
