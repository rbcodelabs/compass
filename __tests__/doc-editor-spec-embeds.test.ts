// @vitest-environment jsdom
/**
 * Phase 1 spike for Spec/Discovery Plan docs: does a markdown-it core rule turn
 * a paragraph holding exactly one compass:// link into a SpecEmbed node AND
 * serialize back to the identical markdown through the REAL doc-editor
 * tiptap-markdown config (html:false)?
 *
 * The other half matters as much: the node must be invisible to every document
 * that has no such paragraph, so ordinary docs must serialize exactly as they
 * did before the extension existed.
 */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { MarkdownStorage } from "tiptap-markdown";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";
import { createMarkdownEditorExtensions } from "@/components/markdown-editor-extensions";
import { parseDocEmbeds } from "@/lib/doc-embeds";

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b";
const ID2 = "11111111-2222-4333-8444-555555555555";
const link = (title: string, kind = "solution", id = ID) => `[${title}](compass://${kind}/${id})`;

function withEditor<T>(content: string, fn: (editor: Editor) => T, extensions = createDocEditorExtensions([])): T {
  const editor = new Editor({ extensions, content });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}

/** getMarkdown() never emits a trailing newline (true of every doc, with or without embeds). */
const canonical = (md: string) => md.replace(/\n+$/, "");

const markdownOf =(editor: Editor) =>
  (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
const toMarkdown = (content: string) => withEditor(content, markdownOf);
const topLevelTypes = (content: string) =>
  withEditor(content, (editor) => editor.state.doc.children.map((n) => n.type.name));
const embedAttrs = (content: string) =>
  withEditor(content, (editor) => {
    const found: Array<Record<string, unknown>> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "specEmbed") found.push({ ...node.attrs });
    });
    return found;
  });

describe("SpecEmbed block node", () => {
  it("parses a lone compass link paragraph into a specEmbed node", () => {
    expect(topLevelTypes(`Intro\n\n${link("Checkout redesign")}\n\nOutro\n`)).toEqual([
      "paragraph",
      "specEmbed",
      "paragraph",
    ]);
    expect(embedAttrs(`${link("Checkout redesign")}\n`)).toEqual([
      { kind: "solution", id: ID, title: "Checkout redesign" },
    ]);
  });

  it("round-trips a block embed byte-for-byte", () => {
    const md = `Intro\n\n${link("Checkout redesign")}\n\nOutro\n`;
    expect(toMarkdown(md)).toBe(canonical(md));
  });

  const lossless: Record<string, string> = {
    "bracketed title": `${link("Plan \\[draft\\] v2")}\n`,
    "parenthesised title": `${link("Plan (draft) v2")}\n`,
    "emoji title": `${link("Launch 🚀 plan 👩‍👩‍👧")}\n`,
    "backslash title": `${link("C:\\\\path")}\n`,
    "255 char title": `${link("a".repeat(255))}\n`,
    "300 char title": `${link("é".repeat(300))}\n`,
    "markdown-looking title": `${link("2 * 3 _ x `y` <z>")}\n`,
    "empty title": `${link("")}\n`,
    "every kind": `${["opportunity", "solution", "metric", "doc", "task", "experiment", "objective", "keyResult", "assumption", "roadmapItem", "artifact"]
      .map((k) => link(`A ${k}`, k))
      .join("\n\n")}\n`,
    "adjacent blocks": `${link("A")}\n\n${link("B", "task", ID2)}\n`,
    "between headings": `# H\n\n${link("A")}\n\n## H2\n`,
    "uppercase uuid": `${link("A", "solution", ID.toUpperCase())}\n`,
  };
  for (const [name, md] of Object.entries(lossless)) {
    it(`lossless: ${name}`, () => {
      expect(toMarkdown(md)).toBe(canonical(md));
    });
  }

  it("agrees with lib/doc-embeds on which links are blocks", () => {
    const corpus = [
      `${link("A")}\n`,
      `${link("A")}\n\n${link("B", "task", ID2)}\n`,
      `# H\n${link("A")}\n\ntext\n`,
      `text ${link("A")} text\n`,
      `${link("A")}\n${link("B", "task", ID2)}\n`,
      `- ${link("A")}\n`,
      `> ${link("A")}\n`,
      `${link("A")} ${link("B", "task", ID2)}\n`,
      `${link("A")}\n\n- x\n`,
      `${link("A")}\n- x\n`,
      "```ts\n" + link("A") + "\n```\n",
      "```\nx\n```\n" + link("A") + "\n",
      `   ${link("A")}\n`,
    ];
    for (const md of corpus) {
      const expectedBlocks = parseDocEmbeds(md).segments.filter((s) => s.type === "embed" && s.form === "block").length;
      expect({ md, blocks: embedAttrs(md).length }).toEqual({ md, blocks: expectedBlocks });
    }
  });
});

describe("SpecEmbed is invisible to everything else", () => {
  const untouched: Record<string, string> = {
    "ordinary https link": `[Docs](https://example.com/a)\n`,
    "unknown compass kind": `[x](compass://nope/${ID})\n`,
    "bad compass id": `[x](compass://solution/not-a-uuid)\n`,
    "mid-sentence compass link": `See ${link("this one")} now.\n`,
    "compass link in a list": `- ${link("One")}\n- ${link("Two", "task", ID2)}\n`,
    "compass link in a quote": `> ${link("Quoted")}\n`,
    "consecutive compass links": `${link("A")}\n${link("B", "task", ID2)}\n`,
    "reserved fence": "```compass-embed\n" + link("A") + "\n```\n",
    "reserved fence with json": '```compass-embed\n{"kind":"solution"}\n```\n',
  };
  for (const [name, md] of Object.entries(untouched)) {
    it(`${name} has no specEmbed node and serializes exactly as with the extension absent`, () => {
      expect(embedAttrs(md)).toEqual([]);
      const without = withEditor(md, markdownOf, createMarkdownEditorExtensions());
      expect(toMarkdown(md)).toBe(without);
    });
  }

  it("an embed directly under a heading is still a block; the editor only adds the usual blank line", () => {
    const md = `# H\n${link("A")}\n`;
    expect(topLevelTypes(md)).toEqual(["heading", "specEmbed"]);
    const once = toMarkdown(md);
    expect(once).toBe(`# H\n\n${link("A")}`);
    expect(toMarkdown(once)).toBe(once);
  });

  it("the reserved fence stays a plain code block", () => {
    const md = "```compass-embed\n" + link("A") + "\n```\n";
    expect(topLevelTypes(md)).toEqual(["codeBlock"]);
    expect(toMarkdown(md)).toBe(canonical(md));
  });

  it("ordinary docs serialize identically with and without SpecEmbed registered", () => {
    const md = [
      "# Title",
      "",
      "Some **bold** and _italic_ with [a link](https://example.com).",
      "",
      "- one",
      "- two",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
    ].join("\n");
    expect(toMarkdown(md)).toBe(withEditor(md, markdownOf, createMarkdownEditorExtensions()));
  });

  it("is not registered for the shared (description) editor path", () => {
    const names = createMarkdownEditorExtensions().map((e) => e.name);
    expect(names).not.toContain("specEmbed");
    expect(createDocEditorExtensions([]).map((e) => e.name)).toContain("specEmbed");
  });

  it("parsing repeatedly does not stack markdown-it rules or change results", () => {
    withEditor(`${link("A")}\n`, (editor) => {
      const md = `${link("B")}\n`;
      editor.commands.setContent(md);
      editor.commands.setContent(md);
      editor.commands.setContent(md);
      expect(markdownOf(editor)).toBe(canonical(md));
    });
  });
});
