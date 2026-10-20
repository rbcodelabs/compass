"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { type MarkdownStorage } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code2,
  ImageIcon,
  History,
  BookmarkPlus,
  MessageSquarePlus,
  MessageSquare,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  updateDoc,
  createDocVersion,
  addDocCommentWithTask,
  resolveDocComment,
  deleteDocComment,
  getDocLinkedTasks,
  restoreDocVersion,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { createDocumentSaveQueue } from "@/lib/document-save-queue";
import { DocProperties, type DocMetadata } from "@/components/docs/doc-properties";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import type { MemberData } from "@/lib/types";
import {
  DocVersionHistoryPanel,
  type DocVersionListItem,
} from "@/components/docs/doc-version-history-panel";
import {
  DocCommentsSidebar,
  type DocCommentItem,
} from "@/components/docs/doc-comments-sidebar";
import {
  setCommentHighlights,
  projectDocText,
  type CommentAnchorData,
} from "@/components/docs/comment-highlight-extension";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";
import { resolveCommentAnchor } from "@/lib/comment-anchor";
import type { PanelPin } from "@/lib/panel-pin";
import { DocsLibraryButton } from "@/components/docs/docs-library-button";
import { DocCommentComposer, type ComposerPayload, type ComposerResult } from "@/components/docs/doc-comment-composer";
import type { MentionOptions } from "@/components/docs/mention-editor";
import { pinKind, type CommentTaskCardData } from "@/lib/comment-task-card";

interface DocEditorProps {
  initialCommentsPin?: PanelPin;
  initialHistoryPin?: PanelPin;
  doc: {
    id: string;
    title: string;
    content: string | null;
    icon: string | null;
    revision?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: any;
  };
  versions: DocVersionListItem[];
  comments: DocCommentItem[];
  revalidatePathStr: string;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  linkedTasks: {
    deliveryTasks: LinkedTaskData[];
    linkableTasks: Array<{ id: string; title: string }>;
    members: MemberData[];
  };
  decisionAction?: React.ReactNode;
  /** Follow toggle, rendered beside the decision action. */
  followAction?: React.ReactNode;
  /** People and agents the @ picker offers in comments. */
  mentionOptions?: MentionOptions;
  /** Agents that already hold a task from a comment in this doc. */
  confirmedAgentIds?: string[];
  /** Task card per comment id. */
  taskCards?: Record<string, CommentTaskCardData>;
}

const NO_MENTION_OPTIONS: MentionOptions = { people: [], agents: [], outside: [] };

type SaveStatus = "idle" | "saving" | "saved" | "error";
type SaveChange =
  | { kind: "update"; data: { title?: string; content?: string; icon?: string; metadata?: DocMetadata } }
  | { kind: "snapshot"; label?: string }
  | { kind: "restore"; versionId: string; onDone: (result: Awaited<ReturnType<typeof restoreDocVersion>>) => void };

interface PendingAnchor {
  anchorText: string;
  anchorStart: number;
  anchorEnd: number;
  anchorPrefix: string;
  anchorSuffix: string;
}

/** Capture a comment anchor from the editor's CURRENT selection, computed from
 * the plain-text projection (never the markdown). Returns null for an empty or
 * whitespace-only selection. */
function captureAnchor(editor: Editor): PendingAnchor | null {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to) return null;

  const size = state.doc.content.size;
  const anchorText = state.doc.textBetween(from, to, "\n", "\n");
  if (!anchorText.trim()) return null;

  const fullText = state.doc.textBetween(0, size, "\n", "\n");
  const anchorStart = state.doc.textBetween(0, from, "\n", "\n").length;
  const anchorEnd = anchorStart + anchorText.length;

  return {
    anchorText,
    anchorStart,
    anchorEnd,
    anchorPrefix: fullText.slice(Math.max(0, anchorStart - 100), anchorStart),
    anchorSuffix: fullText.slice(anchorEnd, anchorEnd + 100),
  };
}

export function DocEditor({ doc, versions, comments: initialComments, revalidatePathStr, orgSlug, workspaceSlug, workspaceId, linkedTasks, decisionAction, followAction, initialCommentsPin, initialHistoryPin, mentionOptions = NO_MENTION_OPTIONS, confirmedAgentIds: initialConfirmedAgentIds = [], taskCards: initialTaskCards = {} }: DocEditorProps) {
  const [title, setTitle] = useState(doc.title);
  const [icon, setIcon] = useState(doc.icon ?? "");
  const [showIconInput, setShowIconInput] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoredMetadata, setRestoredMetadata] = useState<DocMetadata | null | undefined>(undefined);
  const [propertiesVersion, setPropertiesVersion] = useState(0);
  const [currentContent, setCurrentContent] = useState(doc.content);
  const [activeDocPanel, setActiveDocPanel] = useState<"comments" | "history" | null>(null);
  const [showSaveVersionInput, setShowSaveVersionInput] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);

  // ── Linked tasks state ──────────────────────────────────────────────────────
  // Doc's page is a server component, not SWR-backed like the panels, so we
  // keep our own copy of the bundle and refetch it explicitly after a
  // mutation — the same pattern already used below for comments/versions.
  const [linkedTasksBundle, setLinkedTasksBundle] = useState(linkedTasks);
  const [tasksOpen, setTasksOpen] = useState(false);

  async function refreshLinkedTasks() {
    const bundle = await getDocLinkedTasks(workspaceId, doc.id);
    setLinkedTasksBundle(bundle);
  }

  // ── Inline comments state ──────────────────────────────────────────────────
  const [comments, setComments] = useState<DocCommentItem[]>(initialComments);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const commentAnchorRef = useRef<HTMLDivElement>(null);

  // The new-comment popover is a body-level, viewport-fixed panel (so no ancestor can be its containing block or
  // clip it) laid out as a flex column: the editor, picker and task fields scroll in the middle while the action
  // row stays pinned. Its box is kept inside the VISUAL viewport (which shrinks under an on-screen keyboard) at
  // every width, and recomputed whenever the viewport changes. It sits above the bottom nav (z 45 vs 40).
  useLayoutEffect(() => {
    const el = popoverRef.current;
    const anchor = commentAnchorRef.current;
    if (!pendingAnchor || !el || !anchor) return;
    const place = () => {
      const vv = window.visualViewport;
      const vw = vv?.width ?? window.innerWidth;
      const vh = vv?.height ?? window.innerHeight;
      const ox = vv?.offsetLeft ?? 0;
      const oy = vv?.offsetTop ?? 0;
      const margin = 8;
      const width = Math.min(352, vw - margin * 2);
      const rect = anchor.getBoundingClientRect();
      // Prefer opening under the toolbar button, but never so low that fewer than ~240px remain.
      const top = Math.max(oy + margin, Math.min(rect.bottom + 4, oy + vh - 240 - margin));
      const left = Math.min(Math.max(rect.left, ox + margin), ox + vw - width - margin);
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
      el.style.width = `${width}px`;
      el.style.maxHeight = `${Math.max(120, oy + vh - top - margin)}px`;
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener("resize", place);
    window.addEventListener("orientationchange", place);
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
    };
  }, [pendingAnchor]);
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [taskCards, setTaskCards] = useState<Record<string, CommentTaskCardData>>(initialTaskCards);
  const [confirmedAgentIds, setConfirmedAgentIds] = useState<string[]>(initialConfirmedAgentIds);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContent = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const saveQueue = useMemo(() => createDocumentSaveQueue<SaveChange>({
    revision: doc.revision,
    execute: async (change, token) => {
      if (change.kind === "snapshot") {
        await createDocVersion(doc.id, change.label, revalidatePathStr, token);
        return {};
      }
      if (change.kind === "restore") {
        setIsRestoring(true);
        try {
          const restored = await restoreDocVersion(change.versionId, revalidatePathStr, token);
          change.onDone(restored);
          return restored;
        } finally { setIsRestoring(false); }
      }
      return updateDoc(doc.id, change.data, revalidatePathStr, token);
    },
    onState: (state) => {
      setSaveStatus(state === "saved" && pendingContent.current !== null ? "saving" : state);
      setSaveError(state === "error" ? "Changes could not be saved. Your draft is still here. Retry; if another editor changed this page, copy your draft before reloading." : null);
    },
  // A server revalidation must not replace the queue's revision or unsaved draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc.id, revalidatePathStr]);

  const flushContent = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    if (pendingContent.current === null) return;
    const content = pendingContent.current;
    pendingContent.current = null;
    void saveQueue.enqueue({ kind: "update", data: { content } }).catch(() => {});
  }, [saveQueue]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingContent.current !== null || saveQueue.pending()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); flushContent(); };
  }, [saveQueue, flushContent]);

  const debouncedSaveContent = useCallback(
    (content: string) => {
      pendingContent.current = content;
      setSaveStatus("saving");
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(flushContent, 1200);
    },
    [flushContent]
  );

  // The extension is created once; its initial comment set is the open,
  // anchored comments from the server. Later changes are pushed imperatively
  // via setCommentHighlights (a meta transaction), never by re-instantiating.
  const initialAnchorData: CommentAnchorData[] = useMemo(
    () => toAnchorData(initialComments, initialTaskCards),
    // Only the initial value matters — subsequent updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const editor = useEditor({
    extensions: createDocEditorExtensions(initialAnchorData),
    content: doc.content ?? "",
    onUpdate: ({ editor }) => {
      const markdown = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
      setCurrentContent(markdown);
      setSelectionEmpty(editor.state.selection.empty);
      debouncedSaveContent(markdown);
    },
    onSelectionUpdate: ({ editor }) => {
      setSelectionEmpty(editor.state.selection.empty);
    },
    editorProps: {
      handleDrop: () => false,
    },
  });

  useEffect(() => { editor?.setEditable(!isRestoring, false); }, [editor, isRestoring]);

  // Keep the highlight decorations in sync with the live comment set + focus.
  const openAnchorData = useMemo(() => toAnchorData(comments, taskCards), [comments, taskCards]);
  useEffect(() => {
    if (!editor) return;
    setCommentHighlights(editor, openAnchorData, activeCommentId);
  }, [editor, openAnchorData, activeCommentId]);

  // Which root comments can no longer be located in the current text → orphaned.
  const orphanedIds = useMemo(() => {
    const set = new Set<string>();
    if (!editor) return set;
    const { text } = projectDocText(editor.state.doc);
    for (const c of comments) {
      if (c.parentId === null && c.status === "OPEN" && c.anchorText) {
        if (!resolveCommentAnchor(text, c)) set.add(c.id);
      }
    }
    return set;
    // currentContent is included so this recomputes as the doc is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, comments, currentContent]);

  const openCommentCount = useMemo(
    () => comments.filter((c) => c.parentId === null && c.status === "OPEN").length,
    [comments]
  );

  // Paste image from clipboard
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom as HTMLElement;

    async function handlePaste(e: ClipboardEvent) {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      const imageFile = Array.from(files).find((f) => f.type.startsWith("image/"));
      if (!imageFile) return;
      e.preventDefault();
      await uploadAndInsertImage(imageFile);
    }

    editorEl.addEventListener("paste", handlePaste);
    return () => editorEl.removeEventListener("paste", handlePaste);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadAndInsertImage(file: File) {
    const form = new FormData();
    form.append("workspaceId", workspaceId);
    form.append("file", file);
    const res = await fetch("/api/docs/upload", { method: "POST", body: form });
    if (!res.ok) return;
    const { url } = await res.json();
    editor?.chain().focus().setImage({ src: url }).run();
  }

  async function handleSaveTitle() {
    if (title === doc.title) return;
    await saveQueue.enqueue({ kind: "update", data: { title } }).catch(() => {});
  }

  async function handleSaveIcon(value: string) {
    setIcon(value);
    setShowIconInput(false);
    await saveQueue.enqueue({ kind: "update", data: { icon: value } }).catch(() => {});
  }

  function handleImageButtonClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadAndInsertImage(file);
    e.target.value = "";
  }

  async function handleSaveVersion(label: string) {
    setIsSavingVersion(true);
    try {
      flushContent();
      await saveQueue.enqueue({ kind: "snapshot", label: label || undefined });
      setShowSaveVersionInput(false);
    } catch {
      // The queue retains the exact failed operation for the Retry button.
    } finally {
      setIsSavingVersion(false);
    }
  }

  function handleRestored(content: string | null, restoredTitle: string) {
    editor?.commands.setContent(content ?? "", { emitUpdate: false });
    setCurrentContent(content);
    setTitle(restoredTitle);
  }

  // ── Comment handlers ────────────────────────────────────────────────────────

  function handleStartComment() {
    if (!editor) return;
    const anchor = captureAnchor(editor);
    if (!anchor) return;
    setPendingAnchor(anchor);
  }

  /** Apply a successful post: the comment, its task card, and the agent now counted as confirmed in this doc. */
  function applyPosted(result: Extract<Awaited<ReturnType<typeof addDocCommentWithTask>>, { ok: true }>) {
    setComments((prev) => [...prev, toItem(result.comment)]);
    const card = result.card;
    if (card) {
      setTaskCards((prev) => ({ ...prev, [result.comment.id]: card }));
      if (card.assignee?.type === "AGENT") {
        const agentId = card.assignee.id;
        setConfirmedAgentIds((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]));
      }
    }
  }

  async function postComment(payload: ComposerPayload, extra: { parentId?: string; anchor?: PendingAnchor }): Promise<ComposerResult> {
    const result = await addDocCommentWithTask(
      {
        docId: doc.id,
        body: payload.body,
        parentId: extra.parentId ?? null,
        ...(extra.anchor
          ? {
              anchorText: extra.anchor.anchorText,
              anchorStart: extra.anchor.anchorStart,
              anchorEnd: extra.anchor.anchorEnd,
              anchorPrefix: extra.anchor.anchorPrefix,
              anchorSuffix: extra.anchor.anchorSuffix,
            }
          : {}),
        task: payload.task,
        assignee: payload.assignee,
        agentScopeConfirmed: payload.agentScopeConfirmed,
      },
      revalidatePathStr
    );
    if (!result.ok) return { ok: false, error: result.error, message: result.message ?? "Could not post the comment." };
    applyPosted(result);
    return { ok: true };
  }

  async function handleSubmitComment(payload: ComposerPayload): Promise<ComposerResult> {
    if (!pendingAnchor) return { ok: false, error: "NO_ANCHOR", message: "Select text to comment on." };
    const result = await postComment(payload, { anchor: pendingAnchor });
    if (result.ok) {
      setPendingAnchor(null);
      setActiveDocPanel("comments");
    }
    return result;
  }

  function handleAddReply(parentId: string, payload: ComposerPayload): Promise<ComposerResult> {
    return postComment(payload, { parentId });
  }

  async function handleResolve(commentId: string, resolved: boolean) {
    const updated = await resolveDocComment(commentId, resolved, revalidatePathStr);
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, status: updated.status } : c))
    );
    if (resolved && activeCommentId === commentId) setActiveCommentId(null);
  }

  async function handleDeleteComment(commentId: string) {
    await deleteDocComment(commentId, revalidatePathStr);
    setComments((prev) => prev.filter((c) => c.id !== commentId && c.parentId !== commentId));
    setTaskCards((prev) => {
      const removed = new Set([commentId, ...comments.filter((c) => c.parentId === commentId).map((c) => c.id)]);
      return Object.fromEntries(Object.entries(prev).filter(([id]) => !removed.has(id)));
    });
    if (activeCommentId === commentId) setActiveCommentId(null);
  }

  function handleFocusComment(commentId: string) {
    if (!editor) return;
    const comment = comments.find((c) => c.id === commentId);
    if (!comment?.anchorText) return;
    const { text, posAt } = projectDocText(editor.state.doc);
    const range = resolveCommentAnchor(text, comment);
    if (!range) return;
    const from = posAt[range.from];
    const lastIndex = range.to - 1;
    const to =
      lastIndex >= 0 && lastIndex < posAt.length
        ? posAt[lastIndex] + 1
        : (posAt[posAt.length - 1] ?? 0) + 1;
    if (from == null || to == null) return;
    editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
    setActiveCommentId(commentId);
  }

  if (!editor) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div data-slot="doc-editor-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Save indicator */}
      <div className="flex justify-end px-8 pt-3 min-h-7">
        {saveStatus === "saving" && <span className="text-xs text-text-subtle">Saving…</span>}
        {saveStatus === "saved" && <span className="text-xs text-text-subtle">Saved</span>}
        {saveError && <span role="alert" className="text-xs text-status-danger">{saveError} <button type="button" className="underline" onClick={() => { void saveQueue.retry(); }}>Retry save</button></span>}
      </div>

      {/* Icon + title on a single row */}
      <div className="flex items-center gap-2 px-8 pb-2">
        <DocsLibraryButton />
        {/* Icon picker */}
        <div className="relative shrink-0">
          <button
            disabled={isRestoring}
            onClick={() => setShowIconInput((v) => !v)}
            className="text-2xl leading-none hover:opacity-70 transition-opacity"
            title="Set icon"
          >
            {icon || "📄"}
          </button>
          {showIconInput && (
            <div className="absolute z-10 mt-1 p-2 bg-surface-panel border border-border-default rounded-lg shadow-md">
              <input
                type="text"
                autoFocus
                defaultValue={icon}
                placeholder="Paste emoji…"
                className="w-32 text-sm border border-border-default rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveIcon(e.currentTarget.value);
                  if (e.key === "Escape") setShowIconInput(false);
                }}
                onBlur={(e) => handleSaveIcon(e.currentTarget.value)}
              />
            </div>
          )}
        </div>

        {/* Title */}
        <input
          disabled={isRestoring}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleSaveTitle}
          placeholder="Untitled"
          className="flex-1 min-w-0 text-2xl font-bold text-text-primary bg-transparent border-none outline-none placeholder:text-text-disabled"
        />
      </div>

      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center gap-1 px-4 sm:px-8 py-1.5 border-b border-border-default bg-surface-panel/90 backdrop-blur-sm">
        {/* Buttons scroll horizontally on narrow screens instead of wrapping to a
            second row (which used to eat viewport height) or shrinking to the
            point of being unreadable/untappable. */}
        <div className="flex flex-1 min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="Bold"
        >
          <Bold className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="Italic"
        >
          <Italic className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1 shrink-0" />
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive("heading", { level: 1 })}
          title="Heading 1"
        >
          <Heading1 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive("heading", { level: 2 })}
          title="Heading 2"
        >
          <Heading2 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive("heading", { level: 3 })}
          title="Heading 3"
        >
          <Heading3 className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1 shrink-0" />
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="Bullet list"
        >
          <List className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="Ordered list"
        >
          <ListOrdered className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive("codeBlock")}
          title="Code block"
        >
          <Code2 className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1 shrink-0" />
        <ToolbarButton onClick={handleImageButtonClick} title="Add image">
          <ImageIcon className="w-4 h-4" />
        </ToolbarButton>
        </div>
        {/* Comment/history/version controls stay outside the scroll strip above —
            their popovers are absolutely positioned and would get clipped by an
            overflow-x-auto ancestor, so they're pinned here instead of scrolling. */}
        <div className="w-px h-5 bg-border-default mx-1 shrink-0" />
        {/* Comment on the current selection */}
        <div className="relative shrink-0" ref={commentAnchorRef}>
          <ToolbarButton
            onClick={handleStartComment}
            disabled={selectionEmpty}
            title={selectionEmpty ? "Select text to comment" : "Comment on selection"}
          >
            <MessageSquarePlus className="w-4 h-4" />
          </ToolbarButton>
          {pendingAnchor && (
            <PortalToBody>
            <div
              ref={popoverRef}
              className="fixed z-[45] flex flex-col p-3 bg-surface-card border border-border-default rounded-lg shadow-md"
              data-testid="new-comment-popover"
              onKeyDown={(e) => {
                if (e.key === "Escape") setPendingAnchor(null);
              }}
            >
              <DocCommentComposer
                options={mentionOptions}
                confirmedAgentIds={confirmedAgentIds}
                docTitle={title}
                anchorText={pendingAnchor.anchorText}
                placeholder="Add a comment…"
                ariaLabel="Comment"
                idleLabel="Comment"
                autoFocus
                onSubmit={handleSubmitComment}
                onCancel={() => setPendingAnchor(null)}
              />
            </div>
            </PortalToBody>
          )}
        </div>
        {/* Open comments sidebar */}
        <ToolbarButton onClick={() => setActiveDocPanel("comments")} title="Comments">
          <span className="relative flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
            {openCommentCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-0.5 flex items-center justify-center rounded-full text-[9px] font-semibold bg-status-info-surface text-status-info">
                {openCommentCount}
              </span>
            )}
          </span>
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1 shrink-0" />
        <ToolbarButton onClick={() => setActiveDocPanel("history")} title="Version history">
          <History className="w-4 h-4" />
        </ToolbarButton>
        <div className="relative shrink-0">
          <ToolbarButton onClick={() => setShowSaveVersionInput((v) => !v)} title="Save named version">
            <BookmarkPlus className="w-4 h-4" />
          </ToolbarButton>
          {showSaveVersionInput && (
            <div className="absolute z-10 mt-1 p-2 bg-surface-card border border-border-default rounded-lg shadow-md flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                placeholder="Label (optional)"
                className="w-40 text-sm border border-border-default rounded px-2 py-1 outline-none focus:ring-1 focus:ring-border-focus"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveVersion(e.currentTarget.value);
                  if (e.key === "Escape") setShowSaveVersionInput(false);
                }}
                disabled={isSavingVersion}
              />
            </div>
          )}
        </div>
        {(followAction || decisionAction) && <div className="flex shrink-0 items-center gap-1.5 pl-1">{followAction}{decisionAction}</div>}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Editor */}
      <div className="flex-1 px-8 py-4 overflow-y-auto">
        {/* Properties — scrolls with the content instead of pinning the viewport */}
        <DocProperties
          key={propertiesVersion}
          disabled={isRestoring}
          onSave={(metadata) => saveQueue.enqueue({ kind: "update", data: { metadata } })}
          docId={doc.id}
          initialMetadata={restoredMetadata === undefined ? (doc.metadata as DocMetadata | null) ?? null : restoredMetadata}
          revalidatePathStr={revalidatePathStr}
        />

        {/* Linked tasks — same collapsible affordance as Properties above:
            reference/action material you open on demand rather than
            consuming editor space until asked for. */}
        <div className="mb-4">
          <button
            onClick={() => setTasksOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-text-subtle hover:text-text-secondary transition-colors"
          >
            {tasksOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            Linked tasks
            {linkedTasksBundle.deliveryTasks.length > 0 && !tasksOpen && (
              <span className="font-normal">
                ({linkedTasksBundle.deliveryTasks.length})
              </span>
            )}
          </button>

          {tasksOpen && (
            <div className="mt-2 ml-0.5">
              <LinkedTasksSection
                linkedType="DOC"
                linkedId={doc.id}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                revalidatePathStr={revalidatePathStr}
                tasks={linkedTasksBundle.deliveryTasks}
                linkableTasks={linkedTasksBundle.linkableTasks}
                members={linkedTasksBundle.members}
                onChanged={refreshLinkedTasks}
              />
            </div>
          )}
        </div>

        <EditorContent editor={editor} className="min-h-[400px] prose-custom" />
      </div>

      </div>
      <DocVersionHistoryPanel
        restore={async (versionId, content) => {
          if (pendingContent.current !== null || saveQueue.pending()) throw new Error("Save your current changes before restoring.");
          let restoredTitle = title;
          await saveQueue.enqueue({ kind: "restore", versionId, onDone: (result) => {
            restoredTitle = result.title;
            handleRestored(content, result.title);
            setIcon(result.icon ?? "");
            setRestoredMetadata(result.metadata as DocMetadata | null);
            setPropertiesVersion(value => value + 1);
          } });
          return { title: restoredTitle };
        }}
        open={activeDocPanel === "history"}
        onOpenChange={(open) => setActiveDocPanel((current) => open ? "history" : current === "history" ? null : current)}
        initialPin={initialHistoryPin}
        currentTitle={title}
        currentContent={currentContent}
        versions={versions}
        revalidatePathStr={revalidatePathStr}
        onRestored={handleRestored}
      />

      <DocCommentsSidebar
        open={activeDocPanel === "comments"}
        onOpenChange={(open) => setActiveDocPanel((current) => open ? "comments" : current === "comments" ? null : current)}
        initialPin={initialCommentsPin}
        comments={comments}
        orphanedIds={orphanedIds}
        onAddReply={handleAddReply}
        mentionOptions={mentionOptions}
        confirmedAgentIds={confirmedAgentIds}
        docTitle={title}
        taskCards={taskCards}
        taskHrefBase={`/${orgSlug}/${workspaceSlug}/tasks`}
        onResolve={handleResolve}
        onDelete={handleDeleteComment}
        onFocusComment={handleFocusComment}
      />
    </div>
  );
}

/** Render children into document.body so fixed positioning is always relative to the viewport. */
function PortalToBody({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

/** Map open, anchored root comments to the minimal data the highlighter needs. */
function toAnchorData(comments: DocCommentItem[], taskCards: Record<string, CommentTaskCardData>): CommentAnchorData[] {
  return comments
    .filter((c) => c.parentId === null && c.status === "OPEN" && c.anchorText)
    .map((c) => {
      // A pin covers the root's own task and any task made from a reply in its thread.
      const threadCards = comments
        .filter((t) => t.id === c.id || t.parentId === c.id)
        .flatMap((t) => (taskCards[t.id] ? [taskCards[t.id]] : []));
      return {
        id: c.id,
        anchorText: c.anchorText,
        anchorStart: c.anchorStart,
        anchorEnd: c.anchorEnd,
        anchorPrefix: c.anchorPrefix,
        anchorSuffix: c.anchorSuffix,
        taskPin: pinKind(threadCards),
      };
    });
}

/** Normalise a server-action DocComment result into the client item shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toItem(c: any): DocCommentItem {
  return {
    id: c.id,
    parentId: c.parentId ?? null,
    body: c.body,
    status: c.status,
    anchorText: c.anchorText ?? null,
    anchorStart: c.anchorStart ?? null,
    anchorEnd: c.anchorEnd ?? null,
    anchorPrefix: c.anchorPrefix ?? null,
    anchorSuffix: c.anchorSuffix ?? null,
    authorName: c.authorName,
    authorType: c.authorType,
    createdAt: c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt),
  };
}

function ToolbarButton({
  children,
  onClick,
  isActive,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  isActive?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "w-7 h-7 shrink-0 flex items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-text-secondary hover:bg-surface-inset hover:text-text-primary"
      )}
    >
      {children}
    </button>
  );
}
