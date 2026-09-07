import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appendParticipantVoiceEvent, claimParticipantVoiceLease, releaseParticipantVoiceLease } from "@/lib/research-participant-voice"
import { hashResearchResumeToken } from "@/lib/research-session"

const url = process.env.RESEARCH_PARTICIPANT_VOICE_DATABASE_URL
const run = url ? describe : describe.skip
run("participant voice persistence on owned real PostgreSQL", () => {
  const schema = `participant_events_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: url, max: 6 })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  let created = false
  beforeAll(async () => {
    const target = new URL(url!)
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true
    for (const table of ["organizations", "workspaces", "research_studies", "research_participant_tokens", "research_sessions", "research_turns", "research_attachments", "research_participant_voice_events"]) await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE compass_dev."${table}" INCLUDING ALL)`)
  })
  afterAll(async () => { await prisma.$disconnect(); if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); if (!pool.ended) await pool.end() })
  async function fixture() {
    const org = await prisma.organization.create({ data: { name: "Voice test", slug: randomUUID() } })
    const workspace = await prisma.workspace.create({ data: { organizationId: org.id, name: "Voice test", slug: randomUUID() } })
    const study = await prisma.researchStudy.create({ data: { workspaceId: workspace.id, name: "Voice test", goal: "Concrete experience", studyType: "CUSTOMER_INTERVIEW", status: "ACTIVE", guide: "[]" } })
    const participantToken = await prisma.researchParticipantToken.create({ data: { studyId: study.id, tokenHash: randomUUID().replaceAll("-", "").repeat(2), expiresAt: new Date(Date.now() + 60_000) } })
    const session = await prisma.researchSession.create({ data: { studyId: study.id, participantTokenId: participantToken.id, modality: "VOICE", status: "IN_PROGRESS", resumeTokenHash: hashResearchResumeToken(randomUUID()), nextSequence: 0 } })
    const resumeToken = randomUUID()
    await prisma.researchSession.update({ where: { id: session.id }, data: { resumeTokenHash: hashResearchResumeToken(resumeToken), updatedAt: new Date() } })
    const context = { prisma, study, participantToken }
    const common = { context, sessionId: session.id, resumeToken }
    const lease = await claimParticipantVoiceLease(common)
    return { ...common, leaseId: lease.leaseId }
  }
  it("persists one event on exact replay and rejects changed ordinal or omitted attachment", async () => {
    const common = await fixture()
    const attachment = await prisma.researchAttachment.create({ data: { workspaceId: common.context.study.workspaceId, studyId: common.context.study.id, sessionId: common.sessionId, idempotencyKey: randomUUID(), originalName: "screen.png", mimeType: "image/png", sizeBytes: 8, status: "READY", kind: "IMAGE", blobPathname: randomUUID(), sha256: "a".repeat(64) } })
    const input = { ...common, clientEventId: "one", reportedOrdinal: 0, role: "PARTICIPANT" as const, content: "I expected a different result.", attachmentId: attachment.id }
    expect((await appendParticipantVoiceEvent(input)).replayed).toBe(false)
    expect((await appendParticipantVoiceEvent(input)).replayed).toBe(true)
    await expect(appendParticipantVoiceEvent({ ...input, attachmentId: undefined })).rejects.toThrow("attachment")
    await expect(appendParticipantVoiceEvent({ ...input, reportedOrdinal: 1 })).rejects.toThrow("different content")
    expect(await prisma.researchTurn.count({ where: { sessionId: common.sessionId } })).toBe(1)
    expect(await prisma.researchSession.findUnique({ where: { id: common.sessionId } })).toMatchObject({ voiceTurnCount: 1, voiceTranscriptChars: input.content.length, nextSequence: 1 })
  })
  it("rejects revoked and expired authorization without saving new evidence", async () => {
    const common = await fixture()
    await prisma.researchParticipantToken.update({ where: { id: common.context.participantToken.id }, data: { revokedAt: new Date() } })
    await expect(appendParticipantVoiceEvent({ ...common, clientEventId: "revoked", reportedOrdinal: 0, role: "PARTICIPANT", content: "No write" })).rejects.toThrow("not authorized")
    expect(await prisma.researchTurn.count({ where: { sessionId: common.sessionId } })).toBe(0)
  })
  it("makes lease release idempotent without releasing a newer connection", async () => {
    const common = await fixture()
    expect(await releaseParticipantVoiceLease(common)).toEqual({ released: true })
    expect(await releaseParticipantVoiceLease(common)).toEqual({ released: true })
    await claimParticipantVoiceLease(common)
    await expect(releaseParticipantVoiceLease(common)).rejects.toThrow("different voice connection")
  })
  it.each(["revoked", "expired", "closed"])("releases the matching lease after %s without authorizing new evidence", async (condition) => {
    const common = await fixture()
    if (condition === "closed") await prisma.researchStudy.update({ where: { id: common.context.study.id }, data: { status: "CLOSED", updatedAt: new Date() } })
    else await prisma.researchParticipantToken.update({ where: { id: common.context.participantToken.id }, data: condition === "revoked" ? { revokedAt: new Date() } : { expiresAt: new Date(0) } })
    await expect(appendParticipantVoiceEvent({ ...common, clientEventId: "forbidden", reportedOrdinal: 0, role: "PARTICIPANT", content: "No new evidence" })).rejects.toThrow("not authorized")
    await expect(releaseParticipantVoiceLease({ ...common, resumeToken: "wrong" })).rejects.toThrow("not authorized")
    await expect(releaseParticipantVoiceLease({ ...common, sessionId: randomUUID() })).rejects.toThrow("not authorized")
    await expect(releaseParticipantVoiceLease({ ...common, leaseId: randomUUID() })).rejects.toThrow("different voice connection")
    expect(await releaseParticipantVoiceLease(common)).toEqual({ released: true })
  })
  it("serializes competing event writes without duplicate canonical turns", async () => {
    const common = await fixture()
    const input = { ...common, clientEventId: "race", reportedOrdinal: 0, role: "PARTICIPANT" as const, content: "One canonical turn" }
    const outcomes = await Promise.allSettled([appendParticipantVoiceEvent(input), appendParticipantVoiceEvent(input)])
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true)
    expect((await appendParticipantVoiceEvent(input)).replayed).toBe(true)
    expect(await prisma.researchTurn.count({ where: { sessionId: common.sessionId } })).toBe(1)
  })
})
