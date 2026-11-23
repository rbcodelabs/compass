/**
 * Ownership + guarded release of feedback-attachment blobs (lib/feedback-attachment-ownership.ts).
 *
 * Design: Products/Compass/Runs/compass-attachment-leak-small-fix-design.md (revision 3). The release helper is the ONLY deleter of
 * a feedback blob when a workspace's rows are purged or torn down, and a deleted file cannot be restored, so most of this file is
 * guard tests: every guard has a named mutation (recorded in the PR body) that makes exactly its test fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const deleteMock = vi.fn<(urls: string[]) => Promise<void>>()
vi.mock("@/lib/storage/public-store", () => ({
  getPublicFileStore: () => ({ delete: deleteMock, put: vi.fn(), fetch: vi.fn() }),
}))

import {
  createReleaseBudget,
  feedbackAttachmentTable,
  parseOwnedFeedbackKey,
  releaseOwnedFeedbackBlobs,
} from "@/lib/feedback-attachment-ownership"

const WS = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb"
const OTHER_WS = "cccccccc-2222-4222-8222-dddddddddddd"
const HOST = "store123.public.blob.vercel-storage.com"
const keyUrl = (ws = WS, name = "1700000000000-shot.png", host = HOST) => `https://${host}/feedback/${ws}/${name}`

function setEnv({ compass = "production", vercel, flag = "1" }: { compass?: string | null; vercel?: string; flag?: string | null } = {}) {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secret")
  vi.stubEnv("COMPASS_ENV", compass ?? "")
  vi.stubEnv("VERCEL_ENV", vercel ?? "")
  vi.stubEnv("FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED", flag ?? "")
}

/** A prisma stand-in whose reference scan returns these rows (other workspaces' attachment rows that mention WS). */
function prismaWith(rows: { id: string; url: string }[] | Error = []) {
  const $queryRaw = vi.fn(async (..._args: unknown[]) => {
    if (rows instanceof Error) throw rows
    return rows
  })
  return { prisma: { $queryRaw } as never, $queryRaw }
}

let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  deleteMock.mockReset()
  deleteMock.mockResolvedValue(undefined)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  info = vi.spyOn(console, "info").mockImplementation(() => {})
  setEnv()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("parseOwnedFeedbackKey (strict, case-sensitive; anything doubtful is null and never deleted)", () => {
  it("accepts the canonical key and returns its pathname without the leading slash", () => {
    expect(parseOwnedFeedbackKey(keyUrl(), WS)).toBe(`feedback/${WS}/1700000000000-shot.png`)
    expect(parseOwnedFeedbackKey(keyUrl(WS, "a_b.c-d.PNG"), WS)).toBe(`feedback/${WS}/a_b.c-d.PNG`)
    expect(parseOwnedFeedbackKey(keyUrl(WS, "x".repeat(300)), WS)).toBe(`feedback/${WS}/${"x".repeat(300)}`)
  })

  const rejects: [string, unknown, string?][] = [
    ["uppercase workspace UUID in the URL", keyUrl(WS.toUpperCase())],
    ["another workspace's namespace", keyUrl(OTHER_WS)],
    ["another host", keyUrl(WS, "a.png", "other.public.blob.vercel-storage.com")],
    ["an attacker host", keyUrl(WS, "a.png", "evil.example")],
    ["http", keyUrl().replace("https:", "http:")],
    ["a query string", `${keyUrl()}?download=1`],
    ["an empty query marker", `${keyUrl()}?`],
    ["a fragment", `${keyUrl()}#x`],
    ["userinfo", `https://user:pw@${HOST}/feedback/${WS}/a.png`],
    ["a port", `https://${HOST}:8443/feedback/${WS}/a.png`],
    ["a .. segment", `https://${HOST}/feedback/${WS}/../${OTHER_WS}/a.png`],
    ["a . segment", `https://${HOST}/feedback/${WS}/./a.png`],
    ["an encoded slash", `https://${HOST}/feedback/${WS}/a%2Fb.png`],
    ["an encoded dot", `https://${HOST}/feedback/${WS}/%2e%2e.png`],
    ["an encoded backslash", `https://${HOST}/feedback/${WS}/a%5Cb.png`],
    ["an encoded NUL", `https://${HOST}/feedback/${WS}/a%00.png`],
    ["a literal backslash", `https://${HOST}/feedback/${WS}/a\\b.png`],
    ["an extra path segment", `https://${HOST}/feedback/${WS}/sub/a.png`],
    ["a 301-character filename", keyUrl(WS, "x".repeat(301))],
    ["an empty filename", `https://${HOST}/feedback/${WS}/`],
    ["a different prefix", `https://${HOST}/branding/${WS}/a.png`],
    ["a non-string", 42],
    ["null", null],
  ]
  it.each(rejects)("rejects %s", (_label, url) => {
    expect(parseOwnedFeedbackKey(url as string, WS)).toBeNull()
  })

  it("rejects a workspace id that is not a lowercase UUID, whatever the URL says", () => {
    expect(parseOwnedFeedbackKey(keyUrl(WS.toUpperCase()), WS.toUpperCase())).toBeNull()
    expect(parseOwnedFeedbackKey(keyUrl(), "ws-1")).toBeNull()
    expect(parseOwnedFeedbackKey(keyUrl(), "")).toBeNull()
  })

  it("owns nothing when the Blob store is not configured", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
    expect(parseOwnedFeedbackKey(keyUrl(), WS)).toBeNull()
  })
})

describe("environment gate (compassEnv() inside try/catch; VERCEL_ENV is never read directly)", () => {
  const cases: [string, Parameters<typeof setEnv>[0], boolean][] = [
    ["COMPASS_ENV=production, VERCEL_ENV unset (non-Vercel host)", { compass: "production", vercel: "" }, true],
    ["COMPASS_ENV=production beats VERCEL_ENV=preview", { compass: "production", vercel: "preview" }, true],
    ["COMPASS_ENV=preview", { compass: "preview", vercel: "production" }, false],
    ["COMPASS_ENV=development", { compass: "development" }, false],
    ["VERCEL_ENV=production with COMPASS_ENV unset", { compass: null, vercel: "production" }, true],
    ["VERCEL_ENV=preview", { compass: null, vercel: "preview" }, false],
    ["an unrecognised COMPASS_ENV (compassEnv throws)", { compass: "prod" }, false],
  ]
  it.each(cases)("%s", async (_label, env, deletes) => {
    setEnv(env)
    const { prisma } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).toHaveBeenCalledTimes(deletes ? 1 : 0)
    expect(result.deleted).toBe(deletes ? 1 : 0)
  })

  it("no environment signal at all in a production build deletes nothing", async () => {
    setEnv({ compass: null, vercel: "" })
    vi.stubEnv("NODE_ENV", "production")
    const { prisma } = prismaWith([])
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).not.toHaveBeenCalled()
  })
})

describe("what is released", () => {
  it("deletes only the purging workspace's own keys, once each, and keeps everything else", async () => {
    const mine = keyUrl(WS, "a.png")
    const { prisma } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [
      mine,
      mine, // duplicate
      keyUrl(OTHER_WS, "theirs.png"),
      "https://evil.example/feedback/x.png",
      `${keyUrl(WS, "q.png")}?x=1`,
    ])
    expect(deleteMock.mock.calls).toEqual([[[mine]]])
    expect(result).toMatchObject({ deleted: 1 })
    expect(result.kept).toBe(3)
  })

  it("runs the reference scan as ONE bound-parameter ILIKE on the workspace UUID, schema-qualified", async () => {
    const { prisma, $queryRaw } = prismaWith([])
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl(WS, "a.png"), keyUrl(WS, "b.png")])
    expect($queryRaw).toHaveBeenCalledTimes(1)
    const sql = $queryRaw.mock.calls[0][0] as { text: string; values: unknown[] }
    expect(sql.text).toContain(`FROM ${feedbackAttachmentTable().text}`)
    expect(sql.text).toContain("ILIKE '%' || $1::text || '%'")
    expect(sql.values).toEqual([WS])
    expect(sql.text).not.toContain(WS) // never interpolated into the statement text
  })

  it("feedbackAttachmentTable() qualifies the active schema", () => {
    vi.stubEnv("COMPASS_ENV", "development")
    expect(feedbackAttachmentTable().text).toBe('"compass_dev"."feedback_attachment"')
    vi.stubEnv("PGSCHEMA", 'we"ird')
    expect(() => feedbackAttachmentTable()).toThrow() // an identifier that needs quoting is refused, never escaped and trusted
  })
})

describe("guard 2: a key still referenced by any row anywhere is never deleted (mutation M1: skip the reference check)", () => {
  const key = "1700000000000-shot.png"
  const referencing: [string, string][] = [
    ["a plain row in another workspace", keyUrl(WS, key)],
    ["a row with a query string", `${keyUrl(WS, key)}?download=1`],
    ["a row with a fragment", `${keyUrl(WS, key)}#top`],
    ["a row with an uppercase host and path", keyUrl(WS.toUpperCase(), key.toUpperCase()).replace("FEEDBACK", "feedback")],
    ["a row that percent-encodes part of the filename", keyUrl(WS, key.replace(".png", "%2Epng"))],
    ["a matching row that cannot be decoded", `${keyUrl(WS, key)}%E0%A4%A`],
    ["a matching row that is not a URL at all", `not a url ${WS}`],
  ]
  it.each(referencing)("keeps the file for %s", async (_label, url) => {
    const { prisma } = prismaWith([{ id: "r1", url }])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl(WS, key)])
    expect(deleteMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, kept: 1 })
  })

  it("deletes the key a different row does not reference, and keeps the one it does", async () => {
    const { prisma } = prismaWith([{ id: "r1", url: keyUrl(WS, "kept.png") }])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl(WS, "kept.png"), keyUrl(WS, "gone.png")])
    expect(deleteMock.mock.calls).toEqual([[[keyUrl(WS, "gone.png")]]])
    expect(result).toMatchObject({ deleted: 1, kept: 1 })
  })

  it("fails closed when the scan throws: nothing is deleted and the failure is logged, never thrown", async () => {
    const { prisma } = prismaWith(new Error("connection reset"))
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).not.toHaveBeenCalled()
    expect(result.deleted).toBe(0)
    expect(warn).toHaveBeenCalled()
  })
})

describe("guard 4: skipBlobCleanup (mutation M2: ignore skipBlobCleanup)", () => {
  it("makes zero provider and zero database calls", async () => {
    const { prisma, $queryRaw } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()], { skipBlobCleanup: true })
    expect(deleteMock).not.toHaveBeenCalled()
    expect($queryRaw).not.toHaveBeenCalled()
    expect(result).toMatchObject({ deleted: 0, dryRun: 0 })
  })
})

describe("guard 7: FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED (exact === \"1\", read at call time, dry-run when off)", () => {
  it.each([[""], ["0"], ["true"], ["yes"], ["1 "], [" 1"]])("flag %j stays dry-run: logs, deletes nothing", async (flag) => {
    setEnv({ flag })
    const { prisma, $queryRaw } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).not.toHaveBeenCalled()
    expect($queryRaw).toHaveBeenCalledTimes(1) // off is not free: the scan still runs
    expect(result).toMatchObject({ deleted: 0, dryRun: 1 })
    expect(info.mock.calls.flat().join(" ")).toMatch(/would delete/i)
  })

  it("is read at call time, not import time", async () => {
    const { prisma } = prismaWith([])
    setEnv({ flag: "" })
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).not.toHaveBeenCalled()
    setEnv({ flag: "1" })
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(deleteMock).toHaveBeenCalledTimes(1)
  })

  it("dry-run lines appear only in production", async () => {
    setEnv({ compass: "preview", flag: "" })
    const { prisma } = prismaWith([])
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])
    expect(info).not.toHaveBeenCalled()
  })

  it("a failure anywhere in the dry-run path is swallowed", async () => {
    setEnv({ flag: "" })
    const { prisma } = prismaWith(new Error("boom"))
    await expect(releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl()])).resolves.toMatchObject({ deleted: 0 })
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("logger down")
    })
    await expect(releaseOwnedFeedbackBlobs(prismaWith([]).prisma, WS, [keyUrl()])).resolves.toMatchObject({ deleted: 0 })
  })
})

describe("guard 5: partial failure, budget, bounded concurrency (nothing thrown; remaining pathnames logged in chunks of 50)", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, "0")}.png`)
  const warnLines = () => warn.mock.calls.map((c) => String(c[0] ?? "") + " " + c.slice(1).map(String).join(" "))

  it("one rejected delete never stops the others, and exactly that file is listed as leaked", async () => {
    deleteMock.mockImplementation(async ([url]) => {
      if (url.endsWith("f0001.png")) throw new Error("provider 500")
    })
    const { prisma } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, names(4).map((n) => keyUrl(WS, n)))
    expect(deleteMock).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ deleted: 3, failed: 1 })
    const lines = warnLines().filter((l) => l.includes(WS) && l.includes("f0001.png"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("f0000.png")
  })

  it("budget exhaustion stops starting deletes, lists every remaining pathname, and does not throw", async () => {
    let clock = 0
    const now = () => clock
    deleteMock.mockImplementation(async () => {
      clock += 30_000 // the first provider call burns the whole 20 s budget
    })
    const { prisma } = prismaWith([])
    const urls = names(12).map((n) => keyUrl(WS, n))
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, urls, { budget: createReleaseBudget(20_000, now), now })
    expect(result.deleted).toBe(1)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    const text = warnLines().join("\n")
    for (const n of names(12).slice(1)) expect(text).toContain(n)
    expect(text).not.toContain("f0000.png")
    expect(warnLines().filter((l) => l.includes("f0001.png"))).toHaveLength(1) // all 11 fit one line of 50
  })

  it("a long remainder is chunked 50 pathnames per line with no overall cap, each line carrying workspace, chunk and total", async () => {
    let clock = 0
    const now = () => clock
    deleteMock.mockImplementation(async () => {
      clock += 30_000
    })
    const { prisma } = prismaWith([])
    const urls = names(131).map((n) => keyUrl(WS, n))
    await releaseOwnedFeedbackBlobs(prisma, WS, urls, { budget: createReleaseBudget(20_000, now), now })
    const lines = warnLines().filter((l) => l.includes(WS) && l.includes(".png"))
    expect(lines).toHaveLength(3) // 130 remaining = 50 + 50 + 30
    expect(lines[0]).toMatch(/chunk"?[:= ]+1\b/)
    expect(lines[2]).toMatch(/chunks?"?[:= ]+3\b/)
    const all = lines.join("\n")
    for (const n of names(131).slice(1)) expect(all).toContain(n)
  })

  it("never has more than 5 deletes in flight", async () => {
    let inFlight = 0
    let peak = 0
    deleteMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    const { prisma } = prismaWith([])
    const result = await releaseOwnedFeedbackBlobs(prisma, WS, names(25).map((n) => keyUrl(WS, n)))
    expect(result.deleted).toBe(25)
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it("one shared budget spans several releases (account deletion): the second sees the first one's spend", async () => {
    let clock = 0
    const now = () => clock
    deleteMock.mockImplementation(async () => {
      clock += 30_000
    })
    const budget = createReleaseBudget(20_000, now)
    const { prisma } = prismaWith([])
    await releaseOwnedFeedbackBlobs(prisma, WS, [keyUrl(WS, "a.png")], { budget, now })
    const second = await releaseOwnedFeedbackBlobs(prisma, OTHER_WS, [keyUrl(OTHER_WS, "b.png")], { budget, now })
    expect(second.deleted).toBe(0)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(warnLines().some((l) => l.includes(OTHER_WS) && l.includes("b.png"))).toBe(true)
  })
})
