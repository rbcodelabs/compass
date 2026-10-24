import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

import { Markdown } from "@/components/agent/markdown"
import { MarkdownContent } from "@/components/markdown-content"
import { isWorkspaceImageSrc } from "@/components/agent/agent-image"

const WS = "22222222-2222-4222-8222-222222222222"
const NAME = "0d9a4f1e-6a3b-4c57-8f2a-3b1c9d8e7f60.png"
const OWN = `/api/docs/images/${WS}/${NAME}`

describe("agent transcript images", () => {
  it("renders a workspace image inline, linked to the full-size file", () => {
    const html = renderToStaticMarkup(<Markdown>{`Here:\n\n![page](${OWN})`}</Markdown>)
    expect(html).toContain(`<img src="${OWN}"`)
    expect(html).toContain('alt="page"')
    expect(html).toContain(`href="${OWN}"`)
  })

  it("never renders an external image: a crafted reply must not make the browser fetch a URL", () => {
    for (const src of [
      "https://evil.example/x.png?leak=secret",
      "//evil.example/x.png",
      `/api/docs/images/${WS}/../../other.png`,
      `/api/docs/images/${WS}/${NAME}?x=1`,
      `https://evil.example${OWN}`,
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "javascript:alert(1)",
      `/api/docs/images/not-a-uuid/${NAME}`,
      `/api/docs/images/${WS}/${NAME.replace(".png", ".svg")}`,
    ]) {
      const html = renderToStaticMarkup(<Markdown>{`![pic](${src})`}</Markdown>)
      expect(html, src).not.toContain("<img")
      expect(html, src).not.toContain("evil.example")
    }
  })

  it("falls back to the alt text for a rejected image", () => {
    expect(renderToStaticMarkup(<Markdown>{"![a cat](https://evil.example/c.png)"}</Markdown>)).toContain("a cat")
  })

  it("leaves every other MarkdownContent user without images, as before", () => {
    expect(renderToStaticMarkup(<MarkdownContent>{`![x](${OWN})`}</MarkdownContent>)).not.toContain("<img")
  })

  it("keeps links working alongside images", () => {
    const html = renderToStaticMarkup(<Markdown>{`[docs](https://example.com) ![s](${OWN})`}</Markdown>)
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain("<img")
  })
})

describe("isWorkspaceImageSrc", () => {
  it("accepts only the exact doc-image route shape", () => {
    expect(isWorkspaceImageSrc(OWN)).toBe(true)
    expect(isWorkspaceImageSrc(OWN.replace(".png", ".WEBP"))).toBe(true)
    expect(isWorkspaceImageSrc(undefined)).toBe(false)
    expect(isWorkspaceImageSrc(`${OWN}#frag`)).toBe(false)
  })
})
