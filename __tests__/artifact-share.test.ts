/**
 * Tests for lib/artifact-share.ts against a small in-memory stand-in for the four share
 * tables and `artifact`. Covers the security properties: hashed-only storage, password
 * verification, the pre-check attempt budget, session invalidation, and the
 * capability-gated commenting flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Loose in-memory prisma row stand-in; fields vary by table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const tables: Record<string, Row[]> = { artifactShare: [], artifactShareSession: [], artifactShareCommenter: [], artifactShareEvent: [], artifact: [] }
let counter = 0

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("not" in expected) return row[key] !== expected.not
      if ("lt" in expected) return row[key] < expected.lt
    }
    if (expected instanceof Date) return row[key] instanceof Date && row[key].getTime() === expected.getTime()
    return row[key] === expected
  })
}

function model(name: string, defaults: () => Row = () => ({})) {
  const rows = () => tables[name]
  return {
    findUnique: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows().filter((r) => matches(r, where)),
    create: async ({ data }: { data: Row }) => {
      const unique = ["tokenHash", "artifactId"].find((k) => name !== "artifactShareEvent" && k in data && rows().some((r) => r[k] === data[k]) && !(name.includes("Session") && k === "artifactId"))
      if (unique) throw Object.assign(new Error("unique"), { code: "P2002" })
      const row = { id: `id-${(counter += 1)}`, createdAt: new Date(), ...defaults(), ...data }
      rows().push(row)
      return row
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows().find((r) => matches(r, where))!
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows().filter((r) => matches(r, where))
      hit.forEach((r) => Object.assign(r, data))
      return { count: hit.length }
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = rows().length
      tables[name] = rows().filter((r) => !matches(r, where))
      return { count: before - tables[name].length }
    },
  }
}

const prisma = {
  artifactShare: model("artifactShare", () => ({ commentsEnabled: false, failedAttempts: 0, failedWindowAt: null, revokedAt: null })),
  artifactShareSession: model("artifactShareSession"),
  artifactShareCommenter: model("artifactShareCommenter"),
  artifactShareEvent: model("artifactShareEvent"),
  artifact: model("artifact"),
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import {
  ArtifactShareError, SHARE_MAX_FAILED_ATTEMPTS, changeArtifactSharePassword, enableArtifactShare, getOwnerShareState,
  hashShareToken, resolveShareByToken, revokeArtifactShare, rotateArtifactShareLink, setArtifactShareComments,
  shareSessionCookieName, unlockShare, verifyShareSession,
} from "@/lib/artifact-share"

const owner = { workspaceId: "ws-1", artifactId: "art-1", actorId: "user-1" }
const PASSWORD = "correct horse battery"

beforeEach(() => {
  for (const key of Object.keys(tables)) tables[key] = []
  tables.artifact.push({ id: "art-1", workspaceId: "ws-1", sourceType: "HTML_UPLOAD", status: "ACTIVE" })
  delete process.env.AUTH_RESEND_KEY
})
afterEach(() => {
  delete process.env.AUTH_RESEND_KEY
})

describe("enable / storage", () => {
  it("stores only hashes and returns the raw token once", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    const [row] = tables.artifactShare
    expect(row.tokenHash).toBe(hashShareToken(rawToken))
    expect(JSON.stringify(row)).not.toContain(rawToken)
    expect(row.passwordHash).toMatch(/^scrypt\$/)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
    const state = await getOwnerShareState(owner)
    expect(JSON.stringify(state)).not.toContain(rawToken)
    expect(JSON.stringify(state)).not.toContain(row.passwordHash)
    expect(state.enabled).toBe(true)
    expect(tables.artifactShareEvent.map((e) => e.eventType)).toEqual(["ENABLED"])
  })

  it("rejects short passwords, non-HTML artifacts, archived artifacts, and double enable", async () => {
    await expect(enableArtifactShare({ ...owner, password: "short" })).rejects.toBeInstanceOf(ArtifactShareError)
    tables.artifact[0].sourceType = "V0_CHAT"
    await expect(enableArtifactShare({ ...owner, password: PASSWORD })).rejects.toMatchObject({ status: 400 })
    tables.artifact[0].sourceType = "HTML_UPLOAD"
    tables.artifact[0].status = "ARCHIVED"
    await expect(enableArtifactShare({ ...owner, password: PASSWORD })).rejects.toMatchObject({ status: 400 })
    tables.artifact[0].status = "ACTIVE"
    await enableArtifactShare({ ...owner, password: PASSWORD })
    await expect(enableArtifactShare({ ...owner, password: PASSWORD })).rejects.toMatchObject({ status: 409 })
  })

  it("does not reach another workspace's artifact", async () => {
    await expect(enableArtifactShare({ ...owner, workspaceId: "ws-other", password: PASSWORD })).rejects.toMatchObject({ status: 404 })
  })
})

describe("unlock", () => {
  it("unlocks with the right password and rejects the wrong one identically to an unknown link", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    const wrong = await unlockShare(rawToken, "not the password")
    const unknown = await unlockShare("x".repeat(43), PASSWORD)
    expect(wrong).toEqual({ ok: false, reason: "invalid" })
    expect(unknown).toEqual({ ok: false, reason: "invalid" })
    const ok = await unlockShare(rawToken, PASSWORD)
    expect(ok.ok).toBe(true)
  })

  it("locks after the attempt budget even when parallel guesses race, and refuses the right password while locked", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    const results = await Promise.all(Array.from({ length: 12 }, () => unlockShare(rawToken, "wrong-guess-here")))
    expect(results.filter((r) => !r.ok && r.reason === "invalid").length).toBeLessThanOrEqual(SHARE_MAX_FAILED_ATTEMPTS)
    expect(await unlockShare(rawToken, PASSWORD)).toEqual({ ok: false, reason: "locked" })
  })

  it("starts a fresh budget once the window has elapsed", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    for (let i = 0; i < SHARE_MAX_FAILED_ATTEMPTS; i += 1) await unlockShare(rawToken, "wrong-guess-here")
    tables.artifactShare[0].failedWindowAt = new Date(Date.now() - 16 * 60 * 1000)
    expect((await unlockShare(rawToken, PASSWORD)).ok).toBe(true)
  })
})

describe("sessions", () => {
  async function unlocked() {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    const result = await unlockShare(rawToken, PASSWORD)
    if (!result.ok) throw new Error("expected unlock")
    return { rawToken, sessionToken: result.sessionToken }
  }

  it("accepts a fresh session and stores only its hash", async () => {
    const { rawToken, sessionToken } = await unlocked()
    expect(JSON.stringify(tables.artifactShareSession)).not.toContain(sessionToken)
    const share = (await resolveShareByToken(rawToken))!
    expect(await verifyShareSession(share, sessionToken)).toBe(true)
    expect(await verifyShareSession(share, undefined)).toBe(false)
    expect(await verifyShareSession(share, "garbage")).toBe(false)
  })

  it("rejects expired sessions and sessions from a different share", async () => {
    const { rawToken, sessionToken } = await unlocked()
    const share = (await resolveShareByToken(rawToken))!
    tables.artifactShareSession[0].expiresAt = new Date(Date.now() - 1000)
    expect(await verifyShareSession(share, sessionToken)).toBe(false)
    tables.artifactShareSession[0].expiresAt = new Date(Date.now() + 60_000)
    expect(await verifyShareSession({ ...share, id: "other-share" }, sessionToken)).toBe(false)
  })

  it("rejects a session minted before the password changed, even if the row survives", async () => {
    const { rawToken, sessionToken } = await unlocked()
    const share = (await resolveShareByToken(rawToken))!
    expect(await verifyShareSession({ ...share, passwordChangedAt: new Date(Date.now() + 5000) }, sessionToken)).toBe(false)
  })

  it("password change, rotate, and revoke each sign viewers out", async () => {
    const { rawToken, sessionToken } = await unlocked()
    await changeArtifactSharePassword({ ...owner, password: "another long password" })
    expect(tables.artifactShareSession).toHaveLength(0)
    expect(await unlockShare(rawToken, PASSWORD)).toMatchObject({ ok: false })
    expect((await unlockShare(rawToken, "another long password")).ok).toBe(true)

    const rotated = await rotateArtifactShareLink(owner)
    expect(tables.artifactShareSession).toHaveLength(0)
    expect(await resolveShareByToken(rawToken)).toBeNull()
    expect(await resolveShareByToken(rotated.rawToken)).not.toBeNull()
    expect(shareSessionCookieName(rotated.rawToken)).not.toBe(shareSessionCookieName(rawToken))

    await revokeArtifactShare(owner)
    expect(await resolveShareByToken(rotated.rawToken)).toBeNull()
    void sessionToken
  })
})

describe("resolve", () => {
  it("is null for archived and non-HTML artifacts", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    expect(await resolveShareByToken(rawToken)).not.toBeNull()
    tables.artifact[0].status = "ARCHIVED"
    expect(await resolveShareByToken(rawToken)).toBeNull()
    tables.artifact[0].status = "ACTIVE"
    tables.artifact[0].sourceType = "V0_CHAT"
    expect(await resolveShareByToken(rawToken)).toBeNull()
  })

  it("rejects malformed tokens without touching the database", async () => {
    expect(await resolveShareByToken("")).toBeNull()
    expect(await resolveShareByToken("a".repeat(500))).toBeNull()
  })
})

describe("external commenting capability", () => {
  it("cannot be enabled without an email provider, and reads as off in every view", async () => {
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    await expect(setArtifactShareComments({ ...owner, enabled: true })).rejects.toMatchObject({ status: 400 })
    expect(tables.artifactShare[0].commentsEnabled).toBe(false)
    expect((await getOwnerShareState(owner)).commentingAvailable).toBe(false)
    expect((await resolveShareByToken(rawToken))!.commentsEnabled).toBe(false)
  })

  it("is off server-side if the provider disappears after the owner turned it on", async () => {
    process.env.AUTH_RESEND_KEY = "re_test"
    const { rawToken } = await enableArtifactShare({ ...owner, password: PASSWORD })
    await setArtifactShareComments({ ...owner, enabled: true })
    expect((await resolveShareByToken(rawToken))!.commentsEnabled).toBe(true)
    delete process.env.AUTH_RESEND_KEY
    expect((await resolveShareByToken(rawToken))!.commentsEnabled).toBe(false)
    expect((await getOwnerShareState(owner)).commentsEnabled).toBe(false)
  })

  it("turning comments off removes commenter sessions", async () => {
    process.env.AUTH_RESEND_KEY = "re_test"
    await enableArtifactShare({ ...owner, password: PASSWORD })
    await setArtifactShareComments({ ...owner, enabled: true })
    tables.artifactShareCommenter.push({ id: "c1", shareId: tables.artifactShare[0].id })
    await setArtifactShareComments({ ...owner, enabled: false })
    expect(tables.artifactShareCommenter).toHaveLength(0)
  })
})
