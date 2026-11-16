// @vitest-environment node
import { describe, expect, it } from "vitest"
import { htmlToMarkdown, normalizePlainText } from "@/lib/html-to-markdown"

const convert = (html: string, base = "https://example.com/dir/page") => htmlToMarkdown(html, base)

describe("htmlToMarkdown", () => {
  it("keeps headings, paragraphs, lists, links and code, and reads the title", () => {
    const { title, text } = convert(`<!doctype html><html><head><title> My  Page </title></head><body>
      <h1>Heading</h1><p>First <b>bold</b> paragraph with a <a href="/docs/a?x=1#frag">link</a>.</p>
      <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
      <ol><li>first</li><li>second</li></ol>
      <pre>  line 1
  line 2</pre><p>Inline <code>code()</code> here</p>
      <blockquote>quoted text</blockquote></body></html>`)
    expect(title).toBe("My Page")
    expect(text).toContain("# Heading")
    expect(text).toContain("First bold paragraph with a [link](https://example.com/docs/a?x=1).")
    expect(text).toContain("- one")
    expect(text).toContain("- two")
    expect(text).toContain("  - nested")
    expect(text).toContain("1. first")
    expect(text).toContain("2. second")
    expect(text).toContain("```\n  line 1\n  line 2\n```")
    expect(text).toContain("Inline `code()` here")
    expect(text).toContain("> quoted text")
    expect(text).not.toContain("My Page")
  })

  it("drops script, style, noscript, iframe, svg and other non-content elements", () => {
    const { text } = convert(`<body><p>visible</p><script>alert("SCRIPT_BODY")</script><style>.a{color:red}STYLE_BODY</style>
      <noscript>NOSCRIPT_BODY</noscript><iframe src="https://evil.example/">IFRAME_BODY</iframe><svg><text>SVG_BODY</text></svg>
      <template><p>TEMPLATE_BODY</p></template><object>OBJECT_BODY</object><!-- COMMENT_BODY --><button>BUTTON_BODY</button></body>`)
    expect(text).toBe("visible")
  })

  it("drops content hidden from the reader", () => {
    const { text } = convert(`<body><p>shown</p><p hidden>HIDDEN_ATTR</p><div aria-hidden="true">ARIA</div>
      <span style="display: none">DISPLAY_NONE</span><span style="visibility:hidden">VIS</span></body>`)
    expect(text).toBe("shown")
  })

  it("only keeps http(s) links and resolves them against the page", () => {
    const { text } = convert(`<p><a href="javascript:alert(1)">js</a> <a href="mailto:a@b.c">mail</a> <a href="data:text/html,x">data</a>
      <a href="//cdn.example.org/x">proto</a> <a href="rel/path">rel</a> <a href="https://same.example/">https://same.example/</a></p>`)
    expect(text).not.toContain("javascript:")
    expect(text).not.toContain("mailto:")
    expect(text).not.toContain("data:text")
    expect(text).toContain("[proto](https://cdn.example.org/x)")
    expect(text).toContain("[rel](https://example.com/dir/rel/path)")
    expect(text).toContain("https://same.example/")
    expect(text).not.toContain("[https://same.example/]")
  })

  it("renders table rows as lines", () => {
    const { text } = convert("<table><tr><th>Name</th><th>Rate</th></tr><tr><td>A</td><td>5.1%</td></tr></table>")
    expect(text).toBe("Name | Rate\nA | 5.1%")
  })

  it("strips invisible and bidi control characters and collapses blank lines", () => {
    const { text } = convert("<p>a​b‮c</p><br><br><br><br><p>d</p>")
    expect(text).toBe("abc\n\nd")
  })

  it("survives pathological nesting and huge documents without throwing", () => {
    const deep = `${"<div>".repeat(5000)}deep${"</div>".repeat(5000)}`
    expect(() => convert(deep)).not.toThrow()
    const wide = `<ul>${"<li>x</li>".repeat(50_000)}</ul>`
    expect(convert(wide).text.length).toBeGreaterThan(0)
  })

  it("handles empty and malformed input", () => {
    expect(convert("")).toEqual({ title: "", text: "" })
    expect(convert("<p>unclosed <b>tags <i>everywhere").text).toBe("unclosed tags everywhere")
    expect(htmlToMarkdown("<p><a href='/x'>t</a></p>", "not a url").text).toBe("t")
  })

  it("normalizes plain text", () => {
    expect(normalizePlainText("a\r\nb\rc\u0000​\n\n\n\nd  ")).toBe("a\nb\nc\n\nd")
  })
})
