/** TASK-195 S3: the pure URL rules of the comment-origin deep link. */
import { describe, expect, it } from "vitest"
import { canonicalCommentDeepLink, isCommentId, withoutCommentParam } from "@/lib/comment-deep-link"

const CID = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"

describe("isCommentId", () => {
  it("accepts a uuid and nothing else", () => {
    expect(isCommentId(MID)).toBe(true)
    expect(isCommentId(MID.toUpperCase())).toBe(true)
    for (const bad of ["", null, undefined, "OPP-3", "not-a-uuid", `${MID}x`, `${MID}&detail=task:1`, "../x"]) expect(isCommentId(bad)).toBe(false)
  })
})

describe("canonicalCommentDeepLink", () => {
  it("sets detail=conversation:<cid> and keeps comment=<mid>", () => {
    const href = canonicalCommentDeepLink({ pathname: "/acme/core/discovery/OPP-3", search: `?comment=${MID}`, hash: "", conversationId: CID, messageId: MID })
    const url = new URL(href, "https://x.test")
    expect(url.pathname).toBe("/acme/core/discovery/OPP-3")
    expect(url.searchParams.get("detail")).toBe(`conversation:${CID}`)
    expect(url.searchParams.get("comment")).toBe(MID)
  })

  it("preserves every other parameter and the hash", () => {
    const href = canonicalCommentDeepLink({ pathname: "/acme/core/roadmap", search: `?foo=bar&rail=help&ra=x%20y&comment=${MID}`, hash: "#lane-2", conversationId: CID, messageId: MID })
    const url = new URL(href, "https://x.test")
    expect(url.searchParams.get("foo")).toBe("bar")
    expect(url.searchParams.get("rail")).toBe("help")
    expect(url.searchParams.get("ra")).toBe("x y")
    expect(url.hash).toBe("#lane-2")
  })

  it("is a fixed point: applying it to its own output changes nothing", () => {
    const once = canonicalCommentDeepLink({ pathname: "/a/b/tasks/T-1", search: `?comment=${MID}&x=1`, hash: "#h", conversationId: CID, messageId: MID })
    const [path, rest] = once.split("?")
    const [search, hash] = rest!.split("#")
    expect(canonicalCommentDeepLink({ pathname: path!, search: `?${search}`, hash: `#${hash}`, conversationId: CID, messageId: MID })).toBe(once)
  })
})

describe("withoutCommentParam", () => {
  it("drops only comment and keeps the rest", () => {
    expect(withoutCommentParam({ pathname: "/a/b/c", search: `?comment=${MID}&foo=bar`, hash: "#h" })).toBe("/a/b/c?foo=bar#h")
  })
  it("leaves a bare path when comment was the only parameter", () => {
    expect(withoutCommentParam({ pathname: "/a/b/c", search: `?comment=${MID}`, hash: "" })).toBe("/a/b/c")
  })
})
