import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import type { Editor } from "@tiptap/react";
import { MarkdownAlignedTable } from "@/components/docs/markdown-table-serialization";

/** Shared parser/serializer contract for Markdown persisted by Docs and descriptions. */
export function createMarkdownEditorExtensions(placeholder = "Start writing…") {
  return [
    StarterKit.configure({ link: false, underline: false }),
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder }),
    TableKit.configure({ table: false }),
    MarkdownAlignedTable,
    Markdown.configure({ html: false, transformCopiedText: true }),
  ];
}

export function editorMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}
