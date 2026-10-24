/**
 * The "[[" trigger for linking an existing Compass record from any doc.
 *
 * Like the spec "/" trigger it only WATCHES the document: it reports a picker as open when the text before an empty cursor, in one
 * textblock, ends in "[[" plus a short query. It never dispatches a document transaction, so opening, filtering or dismissing the picker
 * cannot change the markdown or cause an autosave. Choosing a record is the only edit, and it is made by the picker component.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";

export class LinkPickerController {
  private on = false;
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  get enabled() { return this.on; }
  setEnabled(value: boolean) { this.on = value; }
  setKeyHandler(handler: ((event: KeyboardEvent) => boolean) | null) { this.keyHandler = handler; }
  handleKey(event: KeyboardEvent): boolean { return this.keyHandler?.(event) ?? false; }
}

export type LinkPickerState = {
  active: boolean;
  /** Position of the first "[" and of the cursor: the range a chosen link replaces. */
  from: number;
  to: number;
  query: string;
  dismissed: { from: number } | null;
};

const INACTIVE: LinkPickerState = { active: false, from: 0, to: 0, query: "", dismissed: null };
const KEY = new PluginKey<LinkPickerState>("compassLinkPicker");
const DISMISS = "compassLinkPicker/dismiss";
const TRIGGER = /\[\[([^[\]\n]{0,60})$/;

export function getLinkPickerState(state: EditorState): LinkPickerState {
  return KEY.getState(state) ?? INACTIVE;
}

/** Closes the picker until the trigger moves. A meta-only transaction. */
export function dismissLinkPicker(tr: { setMeta(key: string, value: unknown): unknown }) {
  tr.setMeta(DISMISS, true);
}

function compute(state: EditorState, enabled: boolean, previous: LinkPickerState, dismissRequested: boolean): LinkPickerState {
  const { selection } = state;
  const $from = selection.$from;
  if (!enabled || !selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return INACTIVE;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = TRIGGER.exec(before);
  if (!match) return INACTIVE;
  const from = $from.pos - match[0].length;
  let dismissed = previous.dismissed;
  if (dismissRequested) dismissed = { from };
  else if (dismissed && dismissed.from !== from) dismissed = null;
  return { active: dismissed === null, from, to: $from.pos, query: match[1], dismissed };
}

export const CompassLinkPicker = Extension.create<{ getController: () => LinkPickerController }>({
  name: "compassLinkPicker",

  addOptions() {
    // A getter, not the object: tiptap deep-copies plain-object options (see SpecSlashCommand).
    const fallback = new LinkPickerController();
    return { getController: () => fallback };
  },

  addProseMirrorPlugins() {
    const controller = this.options.getController();
    return [
      new Plugin<LinkPickerState>({
        key: KEY,
        state: {
          init: () => INACTIVE,
          apply: (tr, previous, _old, next) => compute(next, controller.enabled, previous, tr.getMeta(DISMISS) === true),
        },
        props: {
          handleKeyDown(view, event) {
            if (!controller.enabled || !getLinkPickerState(view.state).active) return false;
            return controller.handleKey(event);
          },
        },
      }),
    ];
  },
});
