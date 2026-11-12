/**
 * The "/" block menu trigger: type "/" on an empty line (or "/hea", "/quo"...) to insert a heading, list, quote, code block, table,
 * image or divider.
 *
 * Same contract as the spec doc "/" trigger in spec-slash-extension.ts, and deliberately a sibling of it rather than an extension of it:
 * a plugin that only WATCHES the document. It never dispatches a document transaction, so opening, filtering or dismissing the menu
 * cannot by itself change the markdown or trigger an autosave. A menu is reported open when the cursor sits at the end of a top-level
 * paragraph whose whole text is "/" plus letters and the controller says commands are enabled.
 *
 * It has its own plugin key, so it can coexist with the spec-record menu; the editor enables only one of them per document (a spec doc
 * with scopes keeps its record menu).
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { createSlashController, type SlashController, type SlashState } from "@/components/docs/spec-slash-extension";

const INACTIVE: SlashState = { active: false, from: 0, to: 0, query: "", dismissed: null };
const KEY = new PluginKey<SlashState>("blockSlash");
const DISMISS = "blockSlash/dismiss";
const SLASH_LINE = /^\/([A-Za-z0-9 ]*)$/;

export function getBlockSlashState(state: EditorState): SlashState {
  return KEY.getState(state) ?? INACTIVE;
}

/** Closes the menu until the paragraph's text changes. A meta-only transaction: it does not touch the document. */
export function dismissBlockSlash(tr: { setMeta(key: string, value: unknown): unknown }) {
  tr.setMeta(DISMISS, true);
}

function compute(state: EditorState, enabled: boolean, previous: SlashState, dismissRequested: boolean): SlashState {
  const { selection } = state;
  const $from = selection.$from;
  const paragraph = $from.parent;
  const eligible =
    enabled &&
    selection.empty &&
    $from.depth === 1 &&
    paragraph.type.name === "paragraph" &&
    $from.parentOffset === paragraph.content.size;
  const match = eligible ? SLASH_LINE.exec(paragraph.textContent) : null;
  if (!match) return { ...INACTIVE, dismissed: null };
  const from = $from.before();
  const text = paragraph.textContent;
  let dismissed = previous.dismissed;
  if (dismissRequested) dismissed = { from, text };
  else if (dismissed && (dismissed.from !== from || dismissed.text !== text)) dismissed = null;
  return { active: dismissed === null, from, to: $from.after(), query: match[1], dismissed };
}

export const BlockSlashCommand = Extension.create<{ getController: () => SlashController }>({
  name: "blockSlash",

  addOptions() {
    // A getter, not the object: tiptap deep-copies plain-object options when configuring, which would detach the plugin from the
    // controller the menu mutates.
    const fallback = createSlashController();
    return { getController: () => fallback };
  },

  addProseMirrorPlugins() {
    const controller = this.options.getController();
    return [
      new Plugin<SlashState>({
        key: KEY,
        state: {
          init: () => INACTIVE,
          apply: (tr, previous, _old, next) => compute(next, controller.enabled, previous, tr.getMeta(DISMISS) === true),
        },
        props: {
          handleKeyDown(view, event) {
            if (!controller.enabled || !getBlockSlashState(view.state).active) return false;
            return controller.handleKey(event);
          },
        },
      }),
    ];
  },
});
