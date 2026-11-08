/**
 * Tests for lib/artifact-share-comments.ts: outsiders must only ever see their OWN comments,
 * magic links are single-use / share-bound / expiring, and commenter sessions die with the
 * password. Uses an in-memory stand-in for the tables; the comment store keeps a nested
 * `externalAuthor` object so the authorship filter is exercised for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

// Loose in-memory prisma row stand-in; fields vary by table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const tables: Record<string, Row[]> = { comment: [], portalVerificationToken: [], portalAccount: [], artifactShare: [], artifactShareCommenter: [] }
let counter = 0

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime()
    if (expected && typeof expected === "object") {
      if ("gt" in expected || "lt" in expected) {
        if ("gt" in expected && !(actual > expected.gt)) return false
        if ("lt" in expected && !(actual < expected.lt)) return false
        return true
      }
      // Relation filter: a missing relation never matches (like Prisma on a null relation).
      return actual != null && typeof actual === "object" && matches(actual, expected)
    }
    return actual === expected
  })
}

function model(name: string) {
  const rows = () => tables[name]
  return {
    findUnique: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows().filter((r) => matches(r, where)),
    count: async ({ where }: { where?: Row } = {}) => rows().filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `${name}-${(counter += 1)}`, createdAt: new Date(), ...data }
      rows().push(row)
      return row
    },
    upsert: async ({ where, create }: { where: Row; create: Row }) => {
      const found = rows().find((r) => matches(r, where))
      if (found) return found
      const row = { id: `${name}-${(counter += 1)}`, createdAt: new Date(), ...create }
      rows().push(row)
      return row
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = rows().length
      tables[name] = rows().filter((r) => !matches(r, where))
      return { count: before - tables[name].length }
    },
  }
}

const prisma = {
  comment: model("comment"),
  portalVerificationToken: model("portalVerificationToken"),
  portalAccount: model("portalAccount"),
  artifactShare: model("artifactShare"),
  artifactShareCommenter: model("artifactShareCommenter"),
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/portal-auth", () => ({ normalizePortalEmail: (email: string) => email.trim().toLowerCase() }))
vi.mock("@/lib/comments", () => ({
  createComment: async (input: Row, options: { beforeCreate?: (tx: typeof prisma) => Promise<void> }) => {
    await options.beforeCreate?.(prisma)
    return prisma.comment.create({
      data: {
        workspaceId: input.workspaceId, targetType: input.targetType, targetId: input.targetId, parentId: input.parentId ?? null,
        body: input.body, source: input.source, externalAuthor: input.externalAuthor,
      },
    })
  },
}))

import { hashShareToken, type PublicShare } from "@/lib/artifact-share"
import {
  SHARE_COMMENT_HOURLY_LIMIT, SHARE_MAGIC_LINK_TTL_MS, ShareCommentError, assertCommentingOpen, createShareComment, hashMagicToken,
  issueMagicToken, listOwnShareComments, parseEmail, redeemMagicToken, verifyCommenter,
} from "@/lib/artifact-share-comments"

const share: PublicShare = { id: "share-1", artifactId: "art-1", workspaceId: "ws-1", passwordChangedAt: new Date(Date.now() - 60_000), commentsEnabled: true }
const otherShare: PublicShare = { ...share, id: "share-2" }

async function signIn(forShare: PublicShare, email: string) {
  const issued = await issueMagicToken(forShare, email)
  if (!issued) throw new Error("throttled")
  const redeemed = await redeemMagicToken(forShare, issued.rawToken)
  const commenter = await verifyCommenter(forShare, redeemed!.commenterToken)
  return { commenter: commenter!, commenterToken: redeemed!.commenterToken }
}

beforeEach(() => {
  for (const key of Object.keys(tables)) tables[key] = []
  tables.artifactShare.push({ id: "share-1", revokedAt: null, commentsEnabled: true })
})

describe("visibility", () => {
  it("shows an outsider only their own comments, never internal comments, internal replies, pins, or other outsiders'", async () => {
    const alice = (await signIn(share, "alice@example.com")).commenter
    const bob = (await signIn(share, "bob@example.com")).commenter
    const base = { workspaceId: "ws-1", targetType: "ARTIFACT", targetId: "art-1", createdAt: new Date() }
    tables.comment.push(
      { ...base, id: "internal-root", parentId: null, body: "secret internal", source: "UI" },
      { ...base, id: "internal-pin", parentId: null, body: "secret pin", source: "UI", elementAnchor: { selector: "#x" } },
      { ...base, id: "internal-reply", parentId: "internal-root", body: "secret reply", source: "UI" },
      { ...base, id: "mcp", parentId: null, body: "agent note", source: "MCP" },
      // A SHARE-sourced comment with no external author must not match either.
      { ...base, id: "orphan", parentId: null, body: "orphan", source: "SHARE" },
    )
    const aliceOwn = await createShareComment(share, alice, { body: "hi from alice" })
    await createShareComment(share, bob, { body: "hi from bob" })
    // A comment on another artifact, same author id, must not leak in either.
    tables.comment.push({ ...base, id: "elsewhere", targetId: "art-2", parentId: null, body: "other artifact", source: "SHARE", externalAuthor: { portalAccountId: alice.portalAccountId } })

    const visible = await listOwnShareComments(share, alice)
    expect(visible.map((c) => c.id)).toEqual([aliceOwn.id])
    expect(JSON.stringify(visible)).not.toMatch(/secret|agent note|bob|orphan|other artifact/)
  })

  it("only accepts replies to the viewer's own root comment; anything else is 404", async () => {
    const alice = (await signIn(share, "alice@example.com")).commenter
    const bob = (await signIn(share, "bob@example.com")).commenter
    tables.comment.push({ id: "internal-root", workspaceId: "ws-1", targetType: "ARTIFACT", targetId: "art-1", parentId: null, body: "internal", source: "UI", createdAt: new Date() })
    const root = await createShareComment(share, alice, { body: "root" })

    await expect(createShareComment(share, alice, { body: "x", parentId: "internal-root" })).rejects.toMatchObject({ status: 404 })
    await expect(createShareComment(share, bob, { body: "x", parentId: root.id })).rejects.toMatchObject({ status: 404 })
    await expect(createShareComment(share, alice, { body: "x", parentId: "does-not-exist" })).rejects.toMatchObject({ status: 404 })

    const reply = await createShareComment(share, alice, { body: "follow-up", parentId: root.id })
    expect(reply.parentId).toBe(root.id)
    // A reply to a reply is not a root, so it is refused too.
    await expect(createShareComment(share, alice, { body: "x", parentId: reply.id })).rejects.toMatchObject({ status: 404 })
  })
})

describe("magic link", () => {
  it("is single use", async () => {
    const issued = (await issueMagicToken(share, "a@example.com"))!
    expect(await redeemMagicToken(share, issued.rawToken)).not.toBeNull()
    expect(await redeemMagicToken(share, issued.rawToken)).toBeNull()
  })

  it("cannot be redeemed against a different share, and stays valid for the right one", async () => {
    const issued = (await issueMagicToken(share, "a@example.com"))!
    expect(await redeemMagicToken(otherShare, issued.rawToken)).toBeNull()
    expect(await redeemMagicToken(share, issued.rawToken)).not.toBeNull()
  })

  it("is stored under a share-bound hash that the bare portal hash cannot match", async () => {
    const issued = (await issueMagicToken(share, "a@example.com"))!
    const [row] = tables.portalVerificationToken
    expect(row.tokenHash).toBe(hashMagicToken(share.id, issued.rawToken))
    expect(row.tokenHash).not.toBe(hashShareToken(issued.rawToken))
    expect(JSON.stringify(row)).not.toContain(issued.rawToken)
  })

  it("expires", async () => {
    const issued = (await issueMagicToken(share, "a@example.com"))!
    tables.portalVerificationToken[0].expiresAt = new Date(Date.now() - 1)
    expect(await redeemMagicToken(share, issued.rawToken)).toBeNull()
    expect(SHARE_MAGIC_LINK_TTL_MS).toBe(15 * 60 * 1000)
  })

  it("throttles a second request while one is live, without creating another token", async () => {
    expect(await issueMagicToken(share, "a@example.com")).not.toBeNull()
    expect(await issueMagicToken(share, "a@example.com")).toBeNull()
    expect(tables.portalVerificationToken).toHaveLength(1)
  })

  it("rejects malformed emails and tokens", async () => {
    expect(() => parseEmail("nope")).toThrow(ShareCommentError)
    expect(() => parseEmail(42)).toThrow(ShareCommentError)
    expect(parseEmail("  A@Example.COM ")).toBe("a@example.com")
    expect(await redeemMagicToken(share, "short")).toBeNull()
  })
})

describe("commenter sessions", () => {
  it("are invalid after a password change, for another share, or once expired", async () => {
    const { commenterToken } = await signIn(share, "a@example.com")
    expect(await verifyCommenter(share, commenterToken)).not.toBeNull()
    expect(await verifyCommenter(otherShare, commenterToken)).toBeNull()
    expect(await verifyCommenter({ ...share, passwordChangedAt: new Date(Date.now() + 1000) }, commenterToken)).toBeNull()
    expect(await verifyCommenter(share, undefined)).toBeNull()
    tables.artifactShareCommenter[0].expiresAt = new Date(Date.now() - 1)
    expect(await verifyCommenter(share, commenterToken)).toBeNull()
  })
})

describe("commenting gates", () => {
  it("assertCommentingOpen refuses when comments are off", () => {
    expect(() => assertCommentingOpen({ ...share, commentsEnabled: false })).toThrow(ShareCommentError)
    expect(() => assertCommentingOpen(share)).not.toThrow()
  })

  it("refuses to write if the share was revoked or comments switched off after the request began", async () => {
    const { commenter } = await signIn(share, "a@example.com")
    tables.artifactShare[0].commentsEnabled = false
    await expect(createShareComment(share, commenter, { body: "late" })).rejects.toMatchObject({ status: 403 })
    tables.artifactShare[0].commentsEnabled = true
    tables.artifactShare[0].revokedAt = new Date()
    await expect(createShareComment(share, commenter, { body: "late" })).rejects.toMatchObject({ status: 403 })
    expect(tables.comment).toHaveLength(0)
  })

  it("refuses to write if the commenter was signed out mid-request", async () => {
    const { commenter } = await signIn(share, "a@example.com")
    tables.artifactShareCommenter = []
    await expect(createShareComment(share, commenter, { body: "late" })).rejects.toMatchObject({ status: 403 })
  })

  it("validates body length and rate-limits per commenter", async () => {
    const { commenter } = await signIn(share, "a@example.com")
    await expect(createShareComment(share, commenter, { body: "   " })).rejects.toMatchObject({ status: 400 })
    await expect(createShareComment(share, commenter, { body: "x".repeat(4001) })).rejects.toMatchObject({ status: 400 })
    for (let i = 0; i < SHARE_COMMENT_HOURLY_LIMIT; i += 1) await createShareComment(share, commenter, { body: `c${i}` })
    await expect(createShareComment(share, commenter, { body: "one too many" })).rejects.toMatchObject({ status: 429 })
  })
})
