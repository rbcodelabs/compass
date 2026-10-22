// @vitest-environment jsdom
/**
 * Mermaid in Docs: the ```mermaid fence must survive the markdown round trip
 * through the REAL doc-editor extension set (the node view is presentation
 * only), invalid syntax must surface as an error rather than a throw, and the
 * SVG handed to innerHTML must be sanitized.
 */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { MarkdownStorage } from "tiptap-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";
import { MarkdownContent } from "@/components/markdown-content";
import { renderMermaid, sanitizeSvg } from "@/lib/mermaid-render";

function roundTrip(content: string): { markdown: string; types: string[]; language: unknown } {
  const editor = new Editor({ extensions: createDocEditorExtensions([]), content });
  try {
    const first = editor.state.doc.firstChild;
    return {
      markdown: (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown(),
      types: editor.state.doc.children.map((n) => n.type.name),
      language: first?.attrs.language,
    };
  } finally {
    editor.destroy();
  }
}

const FLOWCHART = "```mermaid\nflowchart LR\n  A[Start] --> B{Ok?}\n  B -- yes --> C[Done]\n```";

describe("mermaid fenced blocks in the Docs editor", () => {
  it("parses as a code block with language mermaid and serializes back unchanged", () => {
    const { markdown, types, language } = roundTrip(FLOWCHART);
    expect(types).toEqual(["codeBlock"]);
    expect(language).toBe("mermaid");
    expect(markdown).toBe(FLOWCHART);
  });

  it("is lossless between surrounding prose and other fences", () => {
    const doc = `Intro paragraph.\n\n${FLOWCHART}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\nOutro.`;
    expect(roundTrip(doc).markdown).toBe(doc);
  });

  it("keeps syntactically invalid mermaid source verbatim", () => {
    const doc = "```mermaid\nflowchart LR\n  A --> --> B [\n```";
    expect(roundTrip(doc).markdown).toBe(doc);
  });

  it("does not change a non-mermaid code block", () => {
    const doc = "```js\nlet x = 1;\n```";
    expect(roundTrip(doc).markdown).toBe(doc);
  });
});

describe("renderMermaid", () => {
  const samples: Record<string, string> = {
    flowchart: "flowchart LR\n A[Start] --> B{Ok?}\n B -- yes --> C[Done]",
    sequence: "sequenceDiagram\n Alice->>Bob: Hi\n Bob-->>Alice: Hello",
    er: "erDiagram\n CUSTOMER ||--o{ ORDER : places",
    state: "stateDiagram-v2\n [*] --> Idle\n Idle --> Busy: go",
    class: "classDiagram\n class Animal {\n +eat()\n }\n Animal <|-- Dog",
    gantt: "gantt\n dateFormat YYYY-MM-DD\n section A\n Task1 :a1, 2026-01-01, 5d",
  };

  for (const [name, source] of Object.entries(samples)) {
    it(`renders a ${name} diagram to svg`, async () => {
      const result = await renderMermaid(source);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.svg).toContain("<svg");
    });
  }

  it("returns an error (does not throw) for invalid syntax, with the line", async () => {
    const result = await renderMermaid("flowchart LR\n A --> --> B [");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/parse error/i);
      expect(result.line).toBe(2);
    }
  });

  it("reports an empty diagram as an error", async () => {
    expect((await renderMermaid("   \n")).ok).toBe(false);
  });

  it("never emits script, handlers or javascript: links for hostile input", async () => {
    const result = await renderMermaid(
      'flowchart LR\n A["<img src=x onerror=alert(1)><script>alert(2)</script>"] --> B\n click B "javascript:alert(3)"',
    );
    if (result.ok) {
      expect(result.svg).not.toMatch(/<script|onerror=|javascript:/i);
    }
  });
});

describe("sanitizeSvg", () => {
  it("removes scripts, foreignObject, event handlers, unsafe hrefs and unsafe styles", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">' +
      "<script>alert(1)</script>" +
      "<foreignObject><div>hi</div></foreignObject>" +
      '<a href="javascript:alert(1)"><rect onclick="x()" style="fill:url(http://evil/x)"/></a>' +
      '<a xlink:href="https://ok.example/"><circle style="fill:var(--a);marker-end:url(#m)"/></a>' +
      "</svg>";
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|foreignObject|onload|onclick|javascript:|evil/i);
    expect(clean).toContain("https://ok.example/");
    expect(clean).toContain("url(#m)");
  });

  it("returns an empty string for non-svg input", () => {
    expect(sanitizeSvg("<div>nope</div>")).toBe("");
    expect(sanitizeSvg("<svg")).toBe("");
  });
});

describe("read-only markdown view", () => {
  it("routes mermaid fences to the diagram renderer and leaves other fences alone", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{"```mermaid\nflowchart LR\n A-->B\n```\n\n```js\nlet x = 1;\n```"}</MarkdownContent>,
    );
    expect(html).toContain('data-testid="mermaid-loading"');
    expect(html).not.toContain("language-mermaid");
    expect(html).toContain("language-js");
  });
});
