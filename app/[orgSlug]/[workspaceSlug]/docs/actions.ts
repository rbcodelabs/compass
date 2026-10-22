"use server";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import getPrisma from "@/lib/db";
import { createPositioningBriefCore } from "@/lib/positioning-brief";
import { createSpecCore, scopeNotFoundMessage } from "@/lib/spec-docs/create";
import { isSpecScopeType, type SpecScopeType } from "@/lib/spec-docs/scopes";
import type { SpecTemplateVariant } from "@/lib/spec-docs/template";
import { LAUNCH_WORKFLOW_DISABLED_MESSAGE } from "@/lib/launch-checklist";
import { Prisma } from "@prisma/client";
import { followAfterCreate } from "@/lib/following-hooks";
import { createDocument, updateDocument, snapshotDocument, restoreDocument, deleteDocument, hydrateDocument } from "@/lib/document-service";
import {
  createDocCommentCore,
  listDocCommentsCore,
  setDocCommentStatusCore,
  deleteDocCommentCore,
} from "@/lib/doc-comments";
import { postDocCommentWithOptionalTask, type CommentTaskRequest, type PostCommentResult } from "@/lib/doc-comment-tasks";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { parseArtifactKind } from "@/lib/artifact-kind";
import { resolveCanvasCards, searchCanvasCardTargets } from "@/lib/canvas-card-data";
import { getCanvasOverview } from "@/lib/canvas/data";
import { buildTreeFragment, TREE_SCOPE_KINDS, type TreeFragment, type TreeScope } from "@/lib/canvas-tree";
import { isUuid } from "@/lib/canvas-cards";
import { resolveThinkingModel } from "@/lib/thinking-model/resolve";
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
import { createV0Artifact, refreshV0Artifact, V0ArtifactError } from "@/lib/v0-artifacts";
import { McpConnectorError } from "@/lib/mcp-connectors/config";

import { ArtifactThumbnailError, captureAndStoreArtifactThumbnail, scheduleArtifactThumbnailCapture } from "@/lib/artifact-thumbnail";

/**
 * v0 failures the person can act on (bad URL, v0 not connected, chat unreadable)
 * are returned as values: production replaces the message of a thrown server-action
 * error with an opaque digest. Anything else is logged and reported generically.
 */
function v0Failure(error: unknown, fallback: string): { error: string } {
  if (error instanceof V0ArtifactError || error instanceof McpConnectorError) return { error: error.message };
  console.error("[v0-artifact] unexpected failure", error);
  return { error: fallback };
}

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

type Mutation = { expectedRevision?: string; operationId?: string };
function mutationToken(value: Mutation): Mutation {
  return { expectedRevision: typeof value.expectedRevision === "string" ? value.expectedRevision : undefined, operationId: typeof value.operationId === "string" ? value.operationId : undefined };
}

async function requireDocumentMember(docId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const doc = await getPrisma().doc.findUnique({ where: { id: docId }, select: { workspaceId: true } });
  if (!doc) throw new Error("Document not found");
  const user = await requireWorkspaceMember(doc.workspaceId);
  return { user, workspaceId: doc.workspaceId };
}

async function requireCommentMember(commentId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const comment = await getPrisma().docComment.findUnique({ where: { id: commentId }, select: { docId: true } });
  if (!comment) throw new Error("Comment not found");
  return requireDocumentMember(comment.docId);
}

export async function createArtifact(workspaceId: string, formData: FormData, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const sourceType = String(formData.get("sourceType") ?? "");
  // A v0 chat supplies its own title when none is typed.
  if (!title && sourceType !== "V0_CHAT") throw new Error("Title is required");
  const common = { workspaceId, title, description, createdById: user.id, source: "UI" as const };
  let v0Created: Awaited<ReturnType<typeof createV0Artifact>> | null = null;
  if (sourceType === "V0_CHAT") {
    try {
      v0Created = await createV0Artifact({ workspaceId, title: title || null, description, url: String(formData.get("url") ?? ""), userId: user.id, source: "UI" });
    } catch (error) {
      return v0Failure(error, "Could not create the v0 chat artifact.");
    }
  }
  const artifact = v0Created
    ? v0Created
    : sourceType === "EXTERNAL_LINK"
    ? await createExternalArtifact({ ...common, url: String(formData.get("url") ?? "") })
    : await (async () => {
        const file = formData.get("file");
        if (!(file instanceof File)) throw new Error("HTML file is required");
        if (file.size > MAX_ARTIFACT_HTML_BYTES) throw new Error("HTML file exceeds the 2 MB size limit");
        return createHtmlArtifact({
          ...common, filename: file.name, mimeType: file.type,
          kind: parseArtifactKind(formData.get("kind")) ?? "DOCUMENT",
          bytes: new Uint8Array(await file.arrayBuffer()),
        }, getArtifactStorage());
      })();
  if (sourceType === "EXTERNAL_LINK") {
    scheduleArtifactThumbnailCapture({ artifactId: artifact.id, workspaceId, revisionId: artifact.currentRevisionId });
  }
  revalidatePath(revalidatePathStr);
  return { id: artifact.id, error: undefined };
}

export async function updateArtifact(
  workspaceId: string,
  artifactId: string,
  data: { title?: string; description?: string | null; kind?: "DOCUMENT" | "SLIDE_DECK" },
  revalidatePathStr: string
) {
  const user = await requireWorkspaceMember(workspaceId);
  await updateArtifactMetadata({ workspaceId, artifactId, ...data, updatedById: user.id });
  revalidatePath(revalidatePathStr);
}

export async function replaceArtifactRevision(workspaceId: string, artifactId: string, sourceType: string, formData: FormData, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  if (sourceType === "V0_CHAT") throw new Error("Revisions of a v0 chat come from v0. Use Refresh from v0.");
  if (sourceType === "EXTERNAL_LINK") {
    const revision = await replaceExternalArtifactRevision({ artifactId, workspaceId, url: String(formData.get("url") ?? ""), createdById: user.id, source: "UI" });
    scheduleArtifactThumbnailCapture({ artifactId, workspaceId, revisionId: revision.id });
  } else {
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("HTML file is required");
    if (file.size > MAX_ARTIFACT_HTML_BYTES) throw new Error("HTML file exceeds the 2 MB size limit");
    await replaceHtmlArtifactRevision({ artifactId, workspaceId, filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), createdById: user.id, source: "UI" }, getArtifactStorage());
  }
  revalidatePath(revalidatePathStr);
}

export async function refreshArtifactFromV0(workspaceId: string, artifactId: string, revalidatePathStr: string) {
  const user = await requireWorkspaceMember(workspaceId);
  try {
    const result = await refreshV0Artifact({ workspaceId, artifactId, userId: user.id, source: "UI" });
    revalidatePath(revalidatePathStr);
    return { changed: result.changed, revisionNumber: result.revisionNumber, error: undefined };
  } catch (error) {
    return v0Failure(error, "Could not refresh from v0.");
  }
}

/**
 * Capture (or re-capture) the current revision's screenshot on request — the retry
 * for a failed background capture, and the way to pick up a page that changed
 * since it was saved. Runs inline: the person clicked the button and is waiting.
 *
 * Known failures come back as `{ ok: false, error }` rather than a throw, so the
 * page can show why (e.g. "Page returned HTTP 404") — a thrown error's message is
 * replaced with a generic digest in production.
 */
export async function captureArtifactThumbnail(workspaceId: string, artifactId: string, revalidatePathStr: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireWorkspaceMember(workspaceId);
  try {
    await captureAndStoreArtifactThumbnail({ artifactId, workspaceId });
  } catch (error) {
    const known = error instanceof ArtifactThumbnailError || (error instanceof Error && error.name === "ScreenshotCaptureError");
    if (!known) console.error("[artifact-thumbnail] manual capture failed", error);
    return { ok: false, error: known ? (error as Error).message : "Could not capture a screenshot of this artifact." };
  }
  revalidatePath(revalidatePathStr);
  return { ok: true };
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
  revalidatePathStr: string,
  mutation: Mutation = {}
) {
  const user = await requireWorkspaceMember(workspaceId);
  const doc = await createDocument({ workspaceId, parentId, title: "Untitled" }, { ...mutationToken(mutation), authorId: user.id, authorName: user.name ?? user.email ?? "Unknown" });
  await followAfterCreate({ model: "doc", workspaceId, row: { id: doc.id }, actor: user.id ? { type: "USER", id: user.id } : { type: "SYSTEM", id: null } });
  revalidatePath(revalidatePathStr);
  return { id: doc.id, title: doc.title, revision: doc.revision };
}

/**
 * Create a JSON Canvas doc: blank, or from an imported .canvas file's text.
 * Content is validated by the document service (invalid canvases are rejected
 * before anything is stored).
 */
export async function createCanvasDoc(
  workspaceId: string,
  parentId: string | null,
  revalidatePathStr: string,
  input: { title?: string; content?: string } = {},
  mutation: Mutation = {}
) {
  const user = await requireWorkspaceMember(workspaceId);
  if ((input.title !== undefined && typeof input.title !== "string") || (input.content !== undefined && typeof input.content !== "string")) throw new Error("Invalid canvas");
  const doc = await createDocument(
    { workspaceId, parentId, title: input.title?.trim() || "Untitled canvas", docType: "CANVAS", content: input.content ?? "" },
    { ...mutationToken(mutation), authorId: user.id, authorName: user.name ?? user.email ?? "Unknown" }
  );
  revalidatePath(revalidatePathStr);
  return { id: doc.id, title: doc.title, revision: doc.revision };
}

// ─── Canvas Compass-object cards ──────────────────────────────────────────────
// The workspace is ALWAYS derived from the canvas doc on the server -- never
// from the client or from the references inside canvas content.

/** Anyone who can open the doc page (member, or org member with read-only access). */
async function requireCanvasReader(docId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { workspaceId: true } });
  if (!doc) throw new Error("Document not found");
  const userId = session.user.id;
  const workspace = await prisma.workspace.findFirst({
    where: {
      id: doc.workspaceId,
      OR: [
        { members: { some: { userId } } },
        { organization: { memberWorkspaceReadOnlyAccess: true, members: { some: { userId } } } },
      ],
    },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  });
  if (!workspace?.organization) throw new Error("Workspace not found or access denied");
  return { userId, workspaceId: workspace.id, workspaceSlug: workspace.slug, orgSlug: workspace.organization.slug };
}

/** Live data for the Compass cards on a canvas; unknown/foreign ids come back `unavailable`. */
export async function resolveCanvasCardRefs(docId: string, refs: unknown) {
  const access = await requireCanvasReader(docId);
  if (!Array.isArray(refs)) return {};
  return resolveCanvasCards({ ...access, refs });
}

/** Picker search. Requires workspace membership (it is an editing action). */
export async function searchCanvasCardItems(docId: string, query: string) {
  const { workspaceId } = await requireDocumentMember(docId);
  if (typeof query !== "string") return [];
  return searchCanvasCardTargets({ workspaceId, query });
}

/**
 * Build the OST tree (optionally only the subtree under one item) as canvas cards for the editor to lay out and merge.
 * Editing action: requires workspace membership. The workspace comes from the doc, never from the client, and the
 * scope id is only ever looked up inside that workspace's overview, so a foreign id simply yields an empty tree.
 */
export async function buildCanvasTree(docId: string, scope: unknown): Promise<TreeFragment> {
  const { workspaceId } = await requireDocumentMember(docId);
  const parsed = parseTreeScope(scope);
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { thinkingModel: true, thinkingModelLabels: true } });
  if (!workspace) throw new Error("Workspace not found or access denied");
  const { links } = resolveThinkingModel(workspace);
  const overview = await getCanvasOverview(prisma, workspaceId, { linkOrigins: links.oppToObjective === "hidden" ? "DIRECT" : "ALL" });
  return buildTreeFragment(overview, { scope: parsed, edgeOptions: { links } });
}

function parseTreeScope(scope: unknown): TreeScope {
  const value = scope as { kind?: unknown; id?: unknown } | null;
  if (!value || typeof value !== "object" || value.kind === "workspace") return { kind: "workspace" };
  if ((TREE_SCOPE_KINDS as readonly unknown[]).includes(value.kind) && isUuid(value.id)) {
    return { kind: value.kind as (typeof TREE_SCOPE_KINDS)[number], id: value.id.toLowerCase() };
  }
  throw new Error("Invalid tree scope");
}

/**
 * Empty-state "Create your first page". Pilot (Geode) workspaces require an
 * operation ID for every create; a fresh one per submission is correct here
 * because each click is a new create, not a transport retry.
 */
export async function createFirstDoc(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Workspace access denied");
  const workspace = await getPrisma().workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } },
    select: { id: true },
  });
  if (!workspace) throw new Error("Workspace access denied");
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`;
  const doc = await createDoc(workspace.id, null, basePath, { operationId: randomUUID() });
  redirect(`${basePath}/${doc.id}`);
}

export async function updateDoc(
  docId: string,
  data: { title?: string; content?: string; icon?: string; metadata?: Record<string, unknown> },
  revalidatePathStr: string,
  mutation: Mutation = {}
) {
  const { user } = await requireDocumentMember(docId);
  const { metadata, title, content, icon } = data;
  if ([title, content, icon].some(value => value !== undefined && typeof value !== "string") || (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)))) throw new Error("Invalid document change");
  const change = { ...(title === undefined ? {} : { title }), ...(content === undefined ? {} : { content }), ...(icon === undefined ? {} : { icon }), ...(metadata === undefined ? {} : { metadata: metadata as Prisma.InputJsonValue }) };
  const doc = await updateDocument(docId, change, { ...mutationToken(mutation), authorId: user.id, authorName: user.name ?? user.email ?? "Unknown" });
  revalidatePath(revalidatePathStr);
  return { id: doc.id, revision: doc.revision };
}

/**
 * Save a manual, named snapshot of a doc's current content — bypasses the
 * coalescing window in maybeSnapshotDocVersion since a label is always set.
 */
export async function createDocVersion(
  docId: string,
  label: string | undefined,
  revalidatePathStr: string,
  mutation: Mutation = {}
) {
  const { user } = await requireDocumentMember(docId);
  await snapshotDocument(docId, {
    ...mutationToken(mutation),
    authorId: user.id,
    authorName: user.name ?? user.email ?? "Unknown",
    label: label?.trim() || "Snapshot",
  });
  revalidatePath(revalidatePathStr);
}

export async function updateDocMetadata(
  docId: string,
  metadata: Record<string, unknown>,
  revalidatePathStr: string,
  mutation: Mutation = {}
) {
  return updateDoc(docId, { metadata }, revalidatePathStr, mutation);
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
  await requireWorkspaceMember(workspaceId);

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
 * Create a NEW Spec (Solution scope) or Discovery Plan (Opportunity scope) doc. Always a new doc, never an existing one: a solution may have
 * many specs. An explicit action, never run from a page load. Failures are returned as values (production masks a thrown server-action
 * message); the scope check is in the caller's workspace, so a foreign scope and a missing one read identically.
 */
export async function createSpec(
  workspaceId: string,
  scopeType: SpecScopeType,
  scopeId: string,
  revalidatePathStr: string,
  options: { template?: SpecTemplateVariant; label?: string } = {}
): Promise<{ docId: string } | { error: string }> {
  const user = await requireWorkspaceMember(workspaceId);
  if (!isSpecScopeType(scopeType)) return { error: "Choose a valid scope for the spec." };
  const result = await createSpecCore(
    { workspaceId, scopeType, scopeId, template: options.template, label: options.label },
    { userId: user.id ?? null, authorName: user.name ?? user.email ?? "Unknown", source: "UI" }
  );
  if (!result.ok) {
    return { error: result.error === "scope_not_found" ? scopeNotFoundMessage(scopeType) : "Could not create the spec. Try again." };
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
  });
  if (!version) throw new Error("Version not found");
  const { workspaceId } = await requireDocumentMember(version.docId);
  return hydrateDocument(workspaceId, version);
}

/**
 * Restore a doc's live content to a previously saved version. The doc's
 * current state is snapshotted first (label "Before restore") so nothing is
 * ever lost by restoring.
 */
export async function restoreDocVersion(versionId: string, revalidatePathStr: string, mutation: Mutation = {}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const version = await getPrisma().docVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new Error("Version not found");
  const { user } = await requireDocumentMember(version.docId);
  const restored = await restoreDocument(versionId, {
    ...mutationToken(mutation),
    authorId: user.id,
    authorName: user.name ?? user.email ?? "Unknown",
  });
  if (!restored) throw new Error("Version not found");

  revalidatePath(revalidatePathStr);
  return { ...restored, icon: version.icon, metadata: version.metadata };
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

export async function deleteDoc(docId: string, revalidatePathStr: string, mutation: Mutation & { workspaceId?: string } = {}) {
  const authorized = mutation.workspaceId ? { user: await requireWorkspaceMember(mutation.workspaceId), workspaceId: mutation.workspaceId } : await requireDocumentMember(docId);
  if (mutation.workspaceId) {
    const doc = await getPrisma().doc.findUnique({ where: { id: docId }, select: { workspaceId: true } });
    if (doc && doc.workspaceId !== authorized.workspaceId) throw new Error("Document not found");
  }
  await deleteDocument(docId, { ...mutationToken(mutation), workspaceId: authorized.workspaceId, authorId: authorized.user.id, authorName: authorized.user.name ?? authorized.user.email ?? "Unknown" });
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
  const { user } = await requireDocumentMember(input.docId);
  const result = await createDocCommentCore({
    ...input,
    authorId: user.id,
    authorName: user.name ?? user.email ?? "Unknown",
    authorType: "HUMAN",
    source: "UI",
  });
  if (!result.ok) throw new Error(`Could not add comment (${result.error})`);

  revalidatePath(revalidatePathStr);
  return result.comment;
}

/**
 * Post a comment that may carry @mentions and, optionally, a task for the first
 * mention. Expected failures come back as values (production masks the message
 * of a thrown server-action error). The membership gate lives in the service.
 */
export async function addDocCommentWithTask(
  input: {
    docId: string;
    body: string;
    parentId?: string | null;
    anchorText?: string | null;
    anchorPrefix?: string | null;
    anchorSuffix?: string | null;
    anchorStart?: number | null;
    anchorEnd?: number | null;
    task?: CommentTaskRequest | null;
    assignee?: { kind: "user" | "agent"; id: string } | null;
    agentScopeConfirmed?: boolean;
  },
  revalidatePathStr: string
): Promise<PostCommentResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const result = await postDocCommentWithOptionalTask({
    ...input,
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "Unknown",
  });
  if (result.ok) revalidatePath(revalidatePathStr);
  return result;
}

export async function listDocComments(docId: string) {
  await requireDocumentMember(docId);
  return listDocCommentsCore(docId);
}

export async function resolveDocComment(
  commentId: string,
  resolved: boolean,
  revalidatePathStr: string
) {
  await requireCommentMember(commentId);
  const updated = await setDocCommentStatusCore(commentId, resolved ? "RESOLVED" : "OPEN");
  if (!updated) throw new Error("Comment not found");

  revalidatePath(revalidatePathStr);
  return updated;
}

export async function deleteDocComment(commentId: string, revalidatePathStr: string) {
  await requireCommentMember(commentId);
  const result = await deleteDocCommentCore(commentId);
  if (!result) throw new Error("Comment not found");

  revalidatePath(revalidatePathStr);
  return result;
}
