/**
 * The "/" trigger for the spec doc editor (spec docs phase 4).
 *
 * A plugin that only WATCHES the document: it never dispatches a document transaction, so opening, filtering or dismissing the menu cannot
 * by itself change the markdown or cause an autosave. It reports a menu as open when the cursor sits at the end of a top-level paragraph
 * whose whole text is "/" plus letters ("/", "/ass"), and the controller says commands are enabled.
 *
 * Why not @tiptap/suggestion: it is not a dependency of this repo, and the behaviour needed here (one trigger, one line, a menu that
 * lives outside the editor) is a few dozen lines.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";

/**
 * Shared between the editor (which asks it, per key press) and the React menu (which configures it). Mutable by design, and a class so
 * the menu changes it through methods.
 */
export class SlashController {
  private on = false;
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;

  /** False for a doc that is not a spec, a viewer who cannot edit, or a doc with nothing to offer. Keys are then never intercepted. */
  get enabled() {
    return this.on;
  }
  setEnabled(value: boolean) {
    this.on = value;
  }
  /** Called for a key press while the menu is open; return true when handled (the editor then ignores it). */
  setKeyHandler(handler: ((event: KeyboardEvent) => boolean) | null) {
    this.keyHandler = handler;
  }
  handleKey(event: KeyboardEvent): boolean {
    return this.keyHandler?.(event) ?? false;
  }
}

export function createSlashController(): SlashController {
  return new SlashController();
}

export type SlashState = {
  active: boolean;
  /** Start of the "/query" paragraph (the position before it) and its end (after it). */
  from: number;
  to: number;
  query: string;
  /** What was dismissed with Escape, so the menu stays closed until the text changes. */
  dismissed: { from: number; text: string } | null;
};

const INACTIVE: SlashState = { active: false, from: 0, to: 0, query: "", dismissed: null };
const KEY = new PluginKey<SlashState>("specSlash");
const DISMISS = "specSlash/dismiss";
const SLASH_LINE = /^\/([A-Za-z]*)$/;

export function getSlashState(state: EditorState): SlashState {
  return KEY.getState(state) ?? INACTIVE;
}

/** Closes the menu until the paragraph's text changes. A meta-only transaction: it does not touch the document. */
export function dismissSlash(tr: { setMeta(key: string, value: unknown): unknown }) {
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

export const SpecSlashCommand = Extension.create<{ getController: () => SlashController }>({
  name: "specSlash",

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
            if (!controller.enabled || !getSlashState(view.state).active) return false;
            return controller.handleKey(event);
          },
        },
      }),
    ];
  },
});
