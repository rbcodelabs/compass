// @vitest-environment jsdom
/** Inline compass:// links must survive the editor as a link mark (they used to be stripped to plain text) and round-trip unchanged. */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { MarkdownStorage } from "tiptap-markdown";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";
import { parseCompassHref } from "@/components/docs/compass-link-extension";

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b";
const link = `[TASK-3](compass://task/${ID})`;

function run<T>(content: string, fn: (editor: Editor) => T): T {
  const editor = new Editor({ extensions: createDocEditorExtensions([]), content });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}
const md = (editor: Editor) => (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
const linkHrefs = (editor: Editor) => {
  const hrefs: string[] = [];
  editor.state.doc.descendants((node) => {
    node.marks.forEach((m) => m.type.name === "link" && hrefs.push(m.attrs.href));
  });
  return hrefs;
};

describe("inline compass links", () => {
  it.each([
    ["prose", `See ${link} for details.`],
    ["a bullet", `- ${link}`],
    ["a table cell", `| Task |\n| --- |\n| ${link} |`],
  ])("keeps the link mark in %s", (_name, source) => {
    expect(run(source, linkHrefs)).toEqual([`compass://task/${ID}`]);
    expect(run(source, md)).toContain(link);
  });

  it("parseCompassHref accepts only known kinds with a uuid", () => {
    expect(parseCompassHref(`compass://task/${ID}`)).toEqual({ kind: "task", id: ID });
    expect(parseCompassHref(`compass://bogus/${ID}`)).toBeNull();
    expect(parseCompassHref("compass://task/not-a-uuid")).toBeNull();
    expect(parseCompassHref("https://example.com")).toBeNull();
  });
});
