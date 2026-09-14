/**
 * doc-editor-extensions — the single source of truth for the TipTap extension
 * set the Docs editor runs on.
 *
 * It lives apart from doc-editor.tsx (a client component that pulls in server
 * actions) so the markdown round-trip can be exercised directly in a unit test.
 * Docs are persisted as markdown strings, so any extension added here is also a
 * change to the storage format: a node that parses IN but has no serializer
 * OUT would silently destroy content on the next save. See
 * __tests__/doc-editor-markdown-tables.test.ts.
 */

import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import {
  CommentHighlight,
  type CommentAnchorData,
} from "@/components/docs/comment-highlight-extension";
import { MarkdownAlignedTable } from "@/components/docs/markdown-table-serialization";

/**
 * Build the editor's extension list.
 *
 * `commentAnchors` seeds the highlight decorations; later changes are pushed
 * imperatively via setCommentHighlights rather than by rebuilding this list.
 */
export function createDocEditorExtensions(commentAnchors: CommentAnchorData[]) {
  return [
    StarterKit,
    Image.configure({ inline: false }),
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: "Start writing…" }),
    // GitHub-flavored pipe tables. Without a table node in the schema,
    // tiptap-markdown parses the pipe syntax but has nowhere to put it and
    // flattens the whole table into one paragraph. `resizable` stays off (the
    // default): column-drag handles are an authoring affordance we don't need,
    // and leaving it off keeps the plain TableView node view, whose
    // `.tableWrapper` div is what gives wide tables their horizontal scroll.
    //
    // The kit's own table node is swapped for MarkdownAlignedTable so pipes in
    // cells are escaped and column alignment survives serialization; the
    // cell/row/header nodes are unchanged.
    TableKit.configure({ table: false }),
    MarkdownAlignedTable,
    Markdown.configure({ html: false, transformCopiedText: true }),
    CommentHighlight.configure({ comments: commentAnchors, activeId: null }),
  ];
}
