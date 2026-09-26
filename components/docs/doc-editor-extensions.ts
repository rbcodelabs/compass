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

import Image from "@tiptap/extension-image";
import {
  CommentHighlight,
  type CommentAnchorData,
} from "@/components/docs/comment-highlight-extension";
import { createMarkdownEditorExtensions } from "@/components/markdown-editor-extensions";

/**
 * Build the editor's extension list.
 *
 * `commentAnchors` seeds the highlight decorations; later changes are pushed
 * imperatively via setCommentHighlights rather than by rebuilding this list.
 */
export function createDocEditorExtensions(commentAnchors: CommentAnchorData[]) {
  return [
    ...createMarkdownEditorExtensions(),
    Image.configure({ inline: false }),
    CommentHighlight.configure({ comments: commentAnchors, activeId: null }),
  ];
}
