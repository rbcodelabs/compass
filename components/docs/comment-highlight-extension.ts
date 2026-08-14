/**
 * comment-highlight-extension — the first custom TipTap `Extension.create` in
 * this codebase.
 *
 * It renders each OPEN inline comment's anchor as a ProseMirror `Decoration`
 * (a view-layer overlay only — it NEVER mutates the document or its markdown
 * serialization). Anchors are located in the editor's *current* plain-text
 * projection by the pure resolver in lib/comment-anchor.ts (match_main seeded
 * near the recorded offset), so highlights survive edits elsewhere in the doc.
 *
 * Decorations are recomputed:
 *   - immediately when the comment set changes (a meta transaction), and
 *   - after the doc changes, debounced ~350ms (a plugin `view` schedules a
 *     rebuild). Between rebuilds the existing decorations are cheaply re-mapped
 *     through each transaction so they don't visibly lag a keystroke.
 *
 * A comment whose anchor can't be confidently re-located is simply not
 * decorated (the sidebar surfaces it as "orphaned" instead).
 */

import { Extension } from "@tiptap/react"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { resolveCommentAnchor, type CommentAnchor } from "@/lib/comment-anchor"

/** The minimal per-comment data the highlighter needs. */
export interface CommentAnchorData extends CommentAnchor {
  id: string
}

export interface CommentHighlightOptions {
  comments: CommentAnchorData[]
  activeId: string | null
}

export const commentHighlightPluginKey = new PluginKey<CommentHighlightState>("docCommentHighlight")

interface CommentHighlightState {
  comments: CommentAnchorData[]
  activeId: string | null
  decorations: DecorationSet
}

const REBUILD_DEBOUNCE_MS = 350

/**
 * Project a ProseMirror doc to the same plain-text string used to capture and
 * resolve anchors — mirroring `doc.textBetween(0, size, "\n", "\n")` — while
 * recording, for each character, the document position immediately before it
 * (`posAt[i]`). That lets a resolved plain-text range be mapped back to
 * ProseMirror positions for the decoration.
 */
export function projectDocText(doc: PMNode): { text: string; posAt: number[] } {
  let text = ""
  const posAt: number[] = []
  let separated = true

  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isText && typeof node.text === "string") {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i]
        posAt.push(pos + i)
      }
      separated = false
    } else if (node.isLeaf) {
      separated = false
    } else if (!separated && node.isBlock) {
      text += "\n"
      posAt.push(pos)
      separated = true
    }
    return true
  })

  return { text, posAt }
}

function buildDecorations(
  doc: PMNode,
  comments: CommentAnchorData[],
  activeId: string | null
): DecorationSet {
  if (comments.length === 0) return DecorationSet.empty

  const { text, posAt } = projectDocText(doc)
  const decorations: Decoration[] = []

  for (const comment of comments) {
    const range = resolveCommentAnchor(text, comment)
    if (!range) continue // orphaned → no highlight

    const from = posAt[range.from]
    const lastIndex = range.to - 1
    const to =
      lastIndex >= 0 && lastIndex < posAt.length
        ? posAt[lastIndex] + 1
        : (posAt[posAt.length - 1] ?? 0) + 1

    if (from == null || to == null || from >= to) continue

    decorations.push(
      Decoration.inline(from, to, {
        class:
          comment.id === activeId
            ? "doc-comment-highlight doc-comment-highlight-active"
            : "doc-comment-highlight",
        "data-comment-id": comment.id,
      })
    )
  }

  return DecorationSet.create(doc, decorations)
}

export const CommentHighlight = Extension.create<CommentHighlightOptions>({
  name: "docCommentHighlight",

  addOptions() {
    return { comments: [], activeId: null }
  },

  addProseMirrorPlugins() {
    const options = this.options

    return [
      new Plugin<CommentHighlightState>({
        key: commentHighlightPluginKey,

        state: {
          init(_config, instanceState) {
            return {
              comments: options.comments,
              activeId: options.activeId,
              decorations: buildDecorations(instanceState.doc, options.comments, options.activeId),
            }
          },
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(commentHighlightPluginKey) as
              | { comments: CommentAnchorData[]; activeId: string | null }
              | undefined

            if (meta) {
              // Comment set (or active thread) changed — full rebuild.
              return {
                comments: meta.comments,
                activeId: meta.activeId,
                decorations: buildDecorations(newState.doc, meta.comments, meta.activeId),
              }
            }

            if (tr.docChanged) {
              // Cheaply keep existing highlights positioned between debounced
              // rebuilds by mapping them through the change.
              return {
                ...value,
                decorations: value.decorations.map(tr.mapping, tr.doc),
              }
            }

            return value
          },
        },

        props: {
          decorations(state) {
            return commentHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty
          },
        },

        view() {
          let timer: ReturnType<typeof setTimeout> | null = null
          return {
            update(view, prevState) {
              if (view.state.doc.eq(prevState.doc)) return
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => {
                const current = commentHighlightPluginKey.getState(view.state)
                if (!current) return
                view.dispatch(
                  view.state.tr.setMeta(commentHighlightPluginKey, {
                    comments: current.comments,
                    activeId: current.activeId,
                  })
                )
              }, REBUILD_DEBOUNCE_MS)
            },
            destroy() {
              if (timer) clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})

/**
 * Imperatively refresh the highlight plugin's comment set / active thread. The
 * React editor calls this whenever its comments prop or the focused comment
 * changes, without re-instantiating the extension.
 */
export function setCommentHighlights(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any,
  comments: CommentAnchorData[],
  activeId: string | null
): void {
  if (!editor?.view) return
  editor.view.dispatch(
    editor.view.state.tr.setMeta(commentHighlightPluginKey, { comments, activeId })
  )
}
