// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { MarkdownStorage } from "tiptap-markdown";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";
import { LinkPickerController, getLinkPickerState } from "@/components/docs/compass-link-picker-extension";
import { flattenSearch, insertCompassLink } from "@/components/docs/compass-link-picker";

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b";

function setup(content: string, enabled = true) {
  const linkPicker = new LinkPickerController();
  linkPicker.setEnabled(enabled);
  const editor = new Editor({ extensions: createDocEditorExtensions([], { linkPicker }), content });
  editor.commands.focus("end");
  return editor;
}
const md = (e: Editor) => (e.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();

describe("[[ link picker", () => {
  it("opens on [[ plus a query at the cursor, mid-paragraph or in a list", () => {
    const e = setup("See [[che");
    e.commands.insertContent(""); // refresh state
    const s = getLinkPickerState(e.state);
    expect(s).toMatchObject({ active: true, query: "che" });
    e.destroy();
    const l = setup("- item [[");
    l.commands.insertContent("");
    expect(getLinkPickerState(l.state)).toMatchObject({ active: true, query: "" });
    l.destroy();
  });

  it("stays closed without the trigger or when disabled", () => {
    const a = setup("plain [text]");
    a.commands.insertContent("");
    expect(getLinkPickerState(a.state).active).toBe(false);
    a.destroy();
    const b = setup("x [[abc", false);
    b.commands.insertContent("");
    expect(getLinkPickerState(b.state).active).toBe(false);
    b.destroy();
  });

  it("replaces [[query with a compass link that serializes as markdown", () => {
    const e = setup("See [[che");
    e.commands.insertContent("");
    const s = getLinkPickerState(e.state);
    expect(insertCompassLink(e, s, { kind: "task", id: ID, label: "TASK-3 Checkout" })).toBe(true);
    expect(md(e)).toContain(`See [TASK-3 Checkout](compass://task/${ID})`);
    expect(md(e)).not.toContain("[[");
    e.destroy();
  });

  it("flattenSearch keeps only embeddable kinds and prefixes display ids", () => {
    const out = flattenSearch({
      query: "x",
      groups: [
        { type: "task", label: "Tasks", items: [{ type: "task", id: ID, displayId: "TASK-3", title: "Checkout", href: "/x" }] },
        { type: "feedback", label: "Feedback", items: [{ type: "feedback", id: ID, title: "Nope", href: "/y" }] },
      ],
    });
    expect(out).toEqual([{ kind: "task", id: ID, label: "TASK-3 Checkout" }]);
  });
});
