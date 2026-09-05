"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  updateDoc,
  createDocVersion,
  addDocComment,
  resolveDocComment,
  deleteDocComment,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { DocProperties, type DocMetadata } from "@/components/docs/doc-properties";
import {
  DocVersionHistoryPanel,
  type DocVersionListItem,
} from "@/components/docs/doc-version-history-panel";
import {
  DocCommentsSidebar,
  type DocCommentItem,
} from "@/components/docs/doc-comments-sidebar";
import {
  CommentHighlight,
  setCommentHighlights,
  projectDocText,
  type CommentAnchorData,
} from "@/components/docs/comment-highlight-extension";
import { resolveCommentAnchor } from "@/lib/comment-anchor";

interface DocEditorProps {
  doc: {
    id: string;
    title: string;
    content: string | null;
    icon: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: any;
  };
  versions: DocVersionListItem[];
  comments: DocCommentItem[];
  revalidatePathStr: string;
}

type SaveStatus = "idle" | "saving" | "saved";

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

export function DocEditor({ doc, versions, comments: initialComments, revalidatePathStr }: DocEditorProps) {
  const [title, setTitle] = useState(doc.title);
  const [icon, setIcon] = useState(doc.icon ?? "");
  const [showIconInput, setShowIconInput] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [currentContent, setCurrentContent] = useState(doc.content);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showSaveVersionInput, setShowSaveVersionInput] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);

  // ── Inline comments state ──────────────────────────────────────────────────
  const [comments, setComments] = useState<DocCommentItem[]>(initialComments);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [selectionEmpty, setSelectionEmpty] = useState(true);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const debouncedSaveContent = useCallback(
    (content: string) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await updateDoc(doc.id, { content }, revalidatePathStr);
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2000);
        } catch {
          setSaveStatus("idle");
        }
      }, 1200);
    },
    [doc.id, revalidatePathStr]
  );

  // The extension is created once; its initial comment set is the open,
  // anchored comments from the server. Later changes are pushed imperatively
  // via setCommentHighlights (a meta transaction), never by re-instantiating.
  const initialAnchorData: CommentAnchorData[] = useMemo(
    () => toAnchorData(initialComments),
    // Only the initial value matters — subsequent updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ inline: false }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Start writing…" }),
      Markdown.configure({ html: false, transformCopiedText: true }),
      CommentHighlight.configure({ comments: initialAnchorData, activeId: null }),
    ],
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

  // Keep the highlight decorations in sync with the live comment set + focus.
  const openAnchorData = useMemo(() => toAnchorData(comments), [comments]);
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
    form.append("file", file);
    const res = await fetch("/api/docs/upload", { method: "POST", body: form });
    if (!res.ok) return;
    const { url } = await res.json();
    editor?.chain().focus().setImage({ src: url }).run();
  }

  async function handleSaveTitle() {
    if (title === doc.title) return;
    setSaveStatus("saving");
    try {
      await updateDoc(doc.id, { title }, revalidatePathStr);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("idle");
    }
  }

  async function handleSaveIcon(value: string) {
    setIcon(value);
    setShowIconInput(false);
    await updateDoc(doc.id, { icon: value }, revalidatePathStr);
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
      await createDocVersion(doc.id, label || undefined, revalidatePathStr);
      setShowSaveVersionInput(false);
    } finally {
      setIsSavingVersion(false);
    }
  }

  function handleRestored(content: string | null, restoredTitle: string) {
    editor?.commands.setContent(content ?? "");
    setCurrentContent(content);
    setTitle(restoredTitle);
  }

  // ── Comment handlers ────────────────────────────────────────────────────────

  function handleStartComment() {
    if (!editor) return;
    const anchor = captureAnchor(editor);
    if (!anchor) return;
    setPendingAnchor(anchor);
    setCommentDraft("");
  }

  async function handleSubmitComment() {
    const body = commentDraft.trim();
    if (!pendingAnchor || !body) return;
    const created = await addDocComment(
      {
        docId: doc.id,
        body,
        anchorText: pendingAnchor.anchorText,
        anchorStart: pendingAnchor.anchorStart,
        anchorEnd: pendingAnchor.anchorEnd,
        anchorPrefix: pendingAnchor.anchorPrefix,
        anchorSuffix: pendingAnchor.anchorSuffix,
      },
      revalidatePathStr
    );
    setComments((prev) => [...prev, toItem(created)]);
    setPendingAnchor(null);
    setCommentDraft("");
    setCommentsOpen(true);
  }

  async function handleAddReply(parentId: string, body: string) {
    const created = await addDocComment({ docId: doc.id, body, parentId }, revalidatePathStr);
    setComments((prev) => [...prev, toItem(created)]);
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
    <div className="flex flex-col h-full">
      {/* Save indicator */}
      <div className="flex justify-end px-8 pt-3 h-7">
        {saveStatus === "saving" && <span className="text-xs text-text-subtle">Saving…</span>}
        {saveStatus === "saved" && <span className="text-xs text-text-subtle">Saved</span>}
      </div>

      <div className="px-8 pb-2">
        {/* Icon picker */}
        <div className="relative mb-2">
          <button
            onClick={() => setShowIconInput((v) => !v)}
            className="text-3xl leading-none hover:opacity-70 transition-opacity"
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
                className="w-32 text-sm border border-border-default rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400"
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
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleSaveTitle}
          placeholder="Untitled"
          className="w-full text-3xl font-bold text-text-primary bg-transparent border-none outline-none placeholder:text-slate-300 mb-3"
        />

        {/* Properties */}
        <DocProperties
          docId={doc.id}
          initialMetadata={(doc.metadata as DocMetadata | null) ?? null}
          revalidatePathStr={revalidatePathStr}
        />
      </div>

      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center gap-0.5 px-8 py-1.5 border-b border-border-default bg-surface-panel/90 backdrop-blur-sm">
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
        <div className="w-px h-5 bg-border-default mx-1" />
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
        <div className="w-px h-5 bg-border-default mx-1" />
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
        <div className="w-px h-5 bg-border-default mx-1" />
        <ToolbarButton onClick={handleImageButtonClick} title="Add image">
          <ImageIcon className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1" />
        {/* Comment on the current selection */}
        <div className="relative">
          <ToolbarButton
            onClick={handleStartComment}
            disabled={selectionEmpty}
            title={selectionEmpty ? "Select text to comment" : "Comment on selection"}
          >
            <MessageSquarePlus className="w-4 h-4" />
          </ToolbarButton>
          {pendingAnchor && (
            <div className="absolute z-20 mt-1 w-72 p-2 bg-surface-card border border-border-default rounded-lg shadow-md">
              <p className="text-[11px] text-text-subtle mb-1 truncate" title={pendingAnchor.anchorText}>
                Commenting on: “{pendingAnchor.anchorText}”
              </p>
              <textarea
                autoFocus
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment…"
                rows={3}
                className="w-full text-sm border border-border-default rounded px-2 py-1 outline-none focus:ring-1 focus:ring-border-focus bg-surface-panel text-text-primary resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSubmitComment();
                  }
                  if (e.key === "Escape") {
                    setPendingAnchor(null);
                    setCommentDraft("");
                  }
                }}
              />
              <div className="flex justify-end gap-1.5 mt-1">
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded text-text-subtle hover:text-text-primary"
                  onClick={() => {
                    setPendingAnchor(null);
                    setCommentDraft("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded bg-status-info-surface text-status-info disabled:opacity-50"
                  disabled={commentDraft.trim().length === 0}
                  onClick={() => void handleSubmitComment()}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Open comments sidebar */}
        <ToolbarButton onClick={() => setCommentsOpen(true)} title="Comments">
          <span className="relative flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
            {openCommentCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-0.5 flex items-center justify-center rounded-full text-[9px] font-semibold bg-status-info-surface text-status-info">
                {openCommentCount}
              </span>
            )}
          </span>
        </ToolbarButton>
        <div className="w-px h-5 bg-border-default mx-1" />
        <ToolbarButton onClick={() => setHistoryOpen(true)} title="Version history">
          <History className="w-4 h-4" />
        </ToolbarButton>
        <div className="relative">
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
        <EditorContent editor={editor} className="min-h-[400px] prose-custom" />
      </div>

      <DocVersionHistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        currentTitle={title}
        currentContent={currentContent}
        versions={versions}
        revalidatePathStr={revalidatePathStr}
        onRestored={handleRestored}
      />

      <DocCommentsSidebar
        open={commentsOpen}
        onOpenChange={setCommentsOpen}
        comments={comments}
        orphanedIds={orphanedIds}
        onAddReply={handleAddReply}
        onResolve={handleResolve}
        onDelete={handleDeleteComment}
        onFocusComment={handleFocusComment}
      />
    </div>
  );
}

/** Map open, anchored root comments to the minimal data the highlighter needs. */
function toAnchorData(comments: DocCommentItem[]): CommentAnchorData[] {
  return comments
    .filter((c) => c.parentId === null && c.status === "OPEN" && c.anchorText)
    .map((c) => ({
      id: c.id,
      anchorText: c.anchorText,
      anchorStart: c.anchorStart,
      anchorEnd: c.anchorEnd,
      anchorPrefix: c.anchorPrefix,
      anchorSuffix: c.anchorSuffix,
    }));
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
        "w-7 h-7 flex items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        isActive
          ? "bg-indigo-100 text-indigo-700"
          : "text-text-secondary hover:bg-surface-inset hover:text-text-primary"
      )}
    >
      {children}
    </button>
  );
}
