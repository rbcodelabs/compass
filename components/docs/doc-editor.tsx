"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { updateDoc, createDocVersion } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { DocProperties, type DocMetadata } from "@/components/docs/doc-properties";
import {
  DocVersionHistoryPanel,
  type DocVersionListItem,
} from "@/components/docs/doc-version-history-panel";

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
  revalidatePathStr: string;
}

type SaveStatus = "idle" | "saving" | "saved";

export function DocEditor({ doc, versions, revalidatePathStr }: DocEditorProps) {
  const [title, setTitle] = useState(doc.title);
  const [icon, setIcon] = useState(doc.icon ?? "");
  const [showIconInput, setShowIconInput] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [currentContent, setCurrentContent] = useState(doc.content);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showSaveVersionInput, setShowSaveVersionInput] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);
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

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ inline: false }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Start writing…" }),
      Markdown.configure({ html: false, transformCopiedText: true }),
    ],
    content: doc.content ?? "",
    onUpdate: ({ editor }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const markdown = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
      setCurrentContent(markdown);
      debouncedSaveContent(markdown);
    },
    editorProps: {
      handleDrop: () => false,
    },
  });

  // Paste image from clipboard
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom as HTMLElement;

    async function handlePaste(e: ClipboardEvent) {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      const imageFile = Array.from(files).find((f) =>
        f.type.startsWith("image/")
      );
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
    // Reset so the same file can be re-selected
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

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Save indicator */}
      <div className="flex justify-end px-8 pt-3 h-7">
        {saveStatus === "saving" && (
          <span className="text-xs text-slate-400">Saving…</span>
        )}
        {saveStatus === "saved" && (
          <span className="text-xs text-slate-400">Saved</span>
        )}
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
            <div className="absolute z-10 mt-1 p-2 bg-white border border-slate-200 rounded-lg shadow-md">
              <input
                type="text"
                autoFocus
                defaultValue={icon}
                placeholder="Paste emoji…"
                className="w-32 text-sm border border-slate-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400"
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
          className="w-full text-3xl font-bold text-slate-900 bg-transparent border-none outline-none placeholder:text-slate-300 mb-3"
        />

        {/* Properties */}
        <DocProperties
          docId={doc.id}
          initialMetadata={(doc.metadata as DocMetadata | null) ?? null}
          revalidatePathStr={revalidatePathStr}
        />
      </div>

      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center gap-0.5 px-8 py-1.5 border-b border-slate-200 bg-white/90 backdrop-blur-sm">
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
        <div className="w-px h-5 bg-slate-200 mx-1" />
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
          isActive={editor.isActive("heading", { level: 1 })}
          title="Heading 1"
        >
          <Heading1 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          isActive={editor.isActive("heading", { level: 2 })}
          title="Heading 2"
        >
          <Heading2 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          isActive={editor.isActive("heading", { level: 3 })}
          title="Heading 3"
        >
          <Heading3 className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-slate-200 mx-1" />
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
        <div className="w-px h-5 bg-slate-200 mx-1" />
        <ToolbarButton onClick={handleImageButtonClick} title="Add image">
          <ImageIcon className="w-4 h-4" />
        </ToolbarButton>
        <div className="w-px h-5 bg-slate-200 mx-1" />
        <ToolbarButton onClick={() => setHistoryOpen(true)} title="Version history">
          <History className="w-4 h-4" />
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton
            onClick={() => setShowSaveVersionInput((v) => !v)}
            title="Save named version"
          >
            <BookmarkPlus className="w-4 h-4" />
          </ToolbarButton>
          {showSaveVersionInput && (
            <div className="absolute z-10 mt-1 p-2 bg-white border border-slate-200 rounded-lg shadow-md flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                placeholder="Label (optional)"
                className="w-40 text-sm border border-slate-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400"
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
        <EditorContent
          editor={editor}
          className="min-h-[400px] prose-custom"
        />
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
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  isActive,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  isActive?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "w-7 h-7 flex items-center justify-center rounded transition-colors",
        isActive
          ? "bg-indigo-100 text-indigo-700"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      )}
    >
      {children}
    </button>
  );
}
