import { randomBytes } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  forwardPreviewRequest,
  mintPreviewTicket,
  normalizeEmbedder,
  openPreviewTicket,
  parseTicketPath,
  previewFrameSrc,
  previewHost,
  rewriteLocation,
  ticketPrefixFromReferer,
  upstreamRequestHeaders,
  type V0PreviewTicket,
} from "@/lib/v0-preview-proxy"

const env = { V0_PREVIEW_TICKET_KEY: randomBytes(32).toString("base64"), V0_PREVIEW_HOST: "v0-preview.example.com" } as unknown as NodeJS.ProcessEnv
const EMBEDDER = "https://compass.example.com"
const NOW = Date.parse("2026-10-06T12:00:00Z")
const source = { url: "https://demo-abc.v0.build/", token: "tok.en", expiresAt: "2026-10-06T13:00:00Z" }

const ticket: V0PreviewTicket = { upstream: "https://demo-abc.v0.build", token: "tok.en", expiresAt: NOW + 60_000, embedder: EMBEDDER }
const PREFIX = "/p/abc"

describe("previewHost", () => {
  it("is null unless configured with a plain host", () => {
    expect(previewHost({} as NodeJS.ProcessEnv)).toBeNull()
    expect(previewHost({ V0_PREVIEW_HOST: "a b/c" } as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(previewHost({ V0_PREVIEW_HOST: " V0-Preview.Example.com " } as unknown as NodeJS.ProcessEnv)).toBe("v0-preview.example.com")
  })
})

describe("normalizeEmbedder", () => {
  it.each([
    ["https://compass.example.com/some/path", "https://compass.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("accepts %s", (input, expected) => expect(normalizeEmbedder(input)).toBe(expected))
  it.each([["http://compass.example.com"], ["https://u:p@compass.example.com"], ["javascript:alert(1)"], ["nope"], [null], [""]])("rejects %s", (input) => {
    expect(normalizeEmbedder(input as string | null)).toBeNull()
  })
})

describe("preview tickets", () => {
  it("round-trips the upstream, token and embedder", () => {
    const minted = mintPreviewTicket(source, EMBEDDER, NOW, env)!
    expect(minted).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(minted).not.toContain("tok.en")
    const opened = openPreviewTicket(minted, NOW + 1_000, env)
    expect(opened).toEqual({ ok: true, ticket: { upstream: "https://demo-abc.v0.build", token: "tok.en", expiresAt: Date.parse(source.expiresAt), embedder: EMBEDDER } })
  })

  it("caps the lifetime at an hour even if v0 reports longer", () => {
    const minted = mintPreviewTicket({ ...source, expiresAt: "2027-01-01T00:00:00Z" }, EMBEDDER, NOW, env)!
    expect(openPreviewTicket(minted, NOW + 59 * 60_000, env).ok).toBe(true)
    expect(openPreviewTicket(minted, NOW + 61 * 60_000, env)).toEqual({ ok: false, reason: "expired" })
  })

  it("reports expiry distinctly from tampering", () => {
    const minted = mintPreviewTicket(source, EMBEDDER, NOW, env)!
    expect(openPreviewTicket(minted, Date.parse(source.expiresAt) + 1, env)).toEqual({ ok: false, reason: "expired" })
    const tampered = `${minted.slice(0, -4)}AAAA`
    expect(openPreviewTicket(tampered, NOW, env)).toEqual({ ok: false, reason: "invalid" })
    expect(openPreviewTicket("garbage", NOW, env)).toEqual({ ok: false, reason: "invalid" })
  })

  it("will not open a ticket under a different key", () => {
    const minted = mintPreviewTicket(source, EMBEDDER, NOW, env)!
    const other = { ...env, V0_PREVIEW_TICKET_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv
    expect(openPreviewTicket(minted, NOW, other)).toEqual({ ok: false, reason: "invalid" })
  })

  it.each([
    ["a foreign host", "https://evil.example.com/"],
    ["a look-alike host", "https://v0.build.evil.com/"],
    ["http", "http://demo.v0.build/"],
    ["credentials", "https://u:p@demo.v0.build/"],
    ["garbage", "not a url"],
  ])("refuses to mint for %s", (_label, url) => {
    expect(mintPreviewTicket({ ...source, url }, EMBEDDER, NOW, env)).toBeNull()
  })

  it("fails closed without a key, an embedder, or time left", () => {
    expect(mintPreviewTicket(source, EMBEDDER, NOW, {} as NodeJS.ProcessEnv)).toBeNull()
    expect(mintPreviewTicket(source, null, NOW, env)).toBeNull()
    expect(mintPreviewTicket({ ...source, expiresAt: "2020-01-01T00:00:00Z" }, EMBEDDER, NOW, env)).toBeNull()
    expect(openPreviewTicket("anything", NOW, {} as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "invalid" })
  })
})

describe("previewFrameSrc", () => {
  it("points at the preview host's /p/<ticket> (no trailing slash: Next would 308 it)", () => {
    const src = previewFrameSrc(source, EMBEDDER, NOW, env)!
    expect(src).toMatch(/^https:\/\/v0-preview\.example\.com\/p\/[A-Za-z0-9_-]+$/)
  })
  it("is null when the host is not configured", () => {
    expect(previewFrameSrc(source, EMBEDDER, NOW, { V0_PREVIEW_TICKET_KEY: env.V0_PREVIEW_TICKET_KEY } as unknown as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe("path helpers", () => {
  it("parses /p/<ticket>/rest", () => {
    expect(parseTicketPath("/p/abc")).toEqual({ ticket: "abc", rest: "/" })
    expect(parseTicketPath("/p/abc/")).toEqual({ ticket: "abc", rest: "/" })
    expect(parseTicketPath("/p/abc/_next/static/x.js")).toEqual({ ticket: "abc", rest: "/_next/static/x.js" })
    expect(parseTicketPath("/api/foo")).toBeNull()
    expect(parseTicketPath("/p/")).toBeNull()
  })
  it("recovers the ticket prefix from a same-host Referer only", () => {
    expect(ticketPrefixFromReferer("https://v0-preview.example.com/p/abc/", "v0-preview.example.com")).toBe("/p/abc")
    expect(ticketPrefixFromReferer("https://v0-preview.example.com/p/abc/deep/page?x=1", "v0-preview.example.com")).toBe("/p/abc")
    expect(ticketPrefixFromReferer("https://evil.example.com/p/abc/", "v0-preview.example.com")).toBeNull()
    expect(ticketPrefixFromReferer("https://v0-preview.example.com/other", "v0-preview.example.com")).toBeNull()
    expect(ticketPrefixFromReferer(null, "v0-preview.example.com")).toBeNull()
    expect(ticketPrefixFromReferer("not a url", "v0-preview.example.com")).toBeNull()
  })
})

describe("upstreamRequestHeaders", () => {
  it("strips credentials and forwarding headers, and sets the preview token", () => {
    const incoming = new Headers({
      cookie: "session=secret",
      authorization: "Bearer x",
      host: "v0-preview.example.com",
      "x-forwarded-for": "1.2.3.4",
      "x-vercel-id": "iad1::abc",
      "x-v0-preview-token": "attacker",
      referer: "https://v0-preview.example.com/p/SECRETTICKET/",
      origin: "https://v0-preview.example.com",
      accept: "text/html",
    })
    const out = upstreamRequestHeaders(incoming, ticket)
    for (const name of ["cookie", "authorization", "host", "x-forwarded-for", "x-vercel-id"]) expect(out.has(name)).toBe(false)
    expect(out.get("x-v0-preview-token")).toBe("tok.en")
    expect(out.get("referer")).toBe("https://demo-abc.v0.build/")
    expect(out.get("origin")).toBe("https://demo-abc.v0.build")
    expect(out.get("accept")).toBe("text/html")
  })
  it("sends no token header when the ticket has none", () => {
    expect(upstreamRequestHeaders(new Headers(), { ...ticket, token: null }).has("x-v0-preview-token")).toBe(false)
  })
})

describe("rewriteLocation", () => {
  it("keeps same-origin redirects inside the prefix", () => {
    expect(rewriteLocation("/dashboard?a=1#x", ticket, PREFIX)).toBe("/p/abc/dashboard?a=1#x")
    expect(rewriteLocation("https://demo-abc.v0.build/next", ticket, PREFIX)).toBe("/p/abc/next")
  })
  it("returns null for anything that leaves the preview", () => {
    expect(rewriteLocation("https://v0.app/chat/api/vm/open?x=1", ticket, PREFIX)).toBeNull()
    expect(rewriteLocation("//evil.example.com/x", ticket, PREFIX)).toBeNull()
  })
})

describe("forwardPreviewRequest", () => {
  const request = (init?: RequestInit, headers?: Record<string, string>) => new Request("https://v0-preview.example.com/p/abc/", { ...init, headers })
  const html = (extra: Record<string, string> = {}, status = 200) =>
    new Response("<html>hi</html>", { status, headers: { "content-type": "text/html", ...extra } })

  it("forwards with the token and rewrites headers so only the embedder can frame it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html({
      "set-cookie": "a=b",
      "x-frame-options": "DENY",
      link: "</x.js>; rel=preload",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    }))
    const res = await forwardPreviewRequest(request(undefined, { cookie: "session=secret" }), ticket, PREFIX, "/", "?q=1", fetchImpl)
    const [target, init] = fetchImpl.mock.calls[0] as [URL, RequestInit]
    expect(target.toString()).toBe("https://demo-abc.v0.build/?q=1")
    const sent = new Headers(init.headers)
    expect(sent.get("x-v0-preview-token")).toBe("tok.en")
    expect(sent.has("cookie")).toBe(false)
    expect(init.redirect).toBe("manual")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("<html>hi</html>")
    expect(res.headers.has("set-cookie")).toBe(false)
    expect(res.headers.has("x-frame-options")).toBe(false)
    expect(res.headers.has("link")).toBe(false)
    expect(res.headers.get("content-security-policy")).toBe(`default-src 'self'; frame-ancestors ${EMBEDDER}`)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("referrer-policy")).toBe("same-origin")
  })

  it("reports a redirect to v0's sign-in as expired, without following it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://v0.app/chat/api/vm/open?x=1" } }))
    const res = await forwardPreviewRequest(request(), ticket, PREFIX, "/", "", fetchImpl)
    expect(res.status).toBe(410)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(res.headers.get("location")).toBeNull()
    expect(await res.text()).toContain("expired")
  })

  it("keeps same-origin redirects inside the prefix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "/home" } }))
    const res = await forwardPreviewRequest(request(), ticket, PREFIX, "/", "", fetchImpl)
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("/p/abc/home")
  })

  it("refuses a path that would leave the preview origin, without fetching", async () => {
    const fetchImpl = vi.fn()
    const res = await forwardPreviewRequest(request(), ticket, PREFIX, "//evil.example.com/x", "", fetchImpl)
    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns 502 when the upstream is unreachable", async () => {
    const res = await forwardPreviewRequest(request(), ticket, PREFIX, "/", "", vi.fn().mockRejectedValue(new Error("down")))
    expect(res.status).toBe(502)
  })

  it("forwards request bodies for non-GET methods", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html())
    await forwardPreviewRequest(request({ method: "POST", body: "a=1" }, { "content-type": "application/x-www-form-urlencoded" }), ticket, PREFIX, "/submit", "", fetchImpl)
    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit & { duplex?: string }]
    expect(init.method).toBe("POST")
    expect(init.body).toBeTruthy()
    expect(init.duplex).toBe("half")
  })
})
