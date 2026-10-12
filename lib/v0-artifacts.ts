/**
 * `V0_CHAT` Artifacts: a v0 chat tracked as a first-class Artifact.
 *
 * The Artifact stores the v0 chat id (`artifacts.v0_chat_id`). Each revision
 * stores the chat URL plus the v0 *version marker* seen when it was captured
 * (`artifact_revisions.v0_version_id`). "Refresh from v0" asks v0 for the chat
 * again, using the **acting user's own** connector grant (ADR-0018), and inserts
 * a new revision only when the marker differs from the current revision's.
 *
 * Revisions stay insert-only; nothing here mutates an existing revision.
 */

import getPrisma from "@/lib/db"
import { callConnectorTool, listConnectorToolNames } from "@/lib/mcp-connectors/call"
import { validateArtifactTitle } from "@/lib/artifacts"
import { V0_PREVIEW_UPSTREAM_HOST } from "@/lib/v0-preview-proxy"

type Source = "UI" | "MCP"

/**
 * A failure whose message is written for the person who caused it (bad URL, v0
 * not connected, chat unreadable). UI server actions return these as values:
 * production replaces the message of a *thrown* server-action error with an
 * opaque digest ("Minified React error #441").
 */
export class V0ArtifactError extends Error {
  constructor(message: string) { super(message); this.name = "V0ArtifactError" }
}

/**
 * v0 MCP tool names that read one chat, in the order tried. The connector catalog
 * (lib/mcp-connectors/config.ts) records `getChat`; a live v0 MCP session on
 * 2026-10-06 exposed the same operation as `chats_get` (arg `chatId`). v0 has
 * renamed tools before, so the next name is tried only when the server says the
 * tool does not exist.
 */
export const V0_GET_CHAT_TOOLS = ["chats_get", "getChat"] as const
const UNKNOWN_TOOL = /unknown tool|tool .*not found|no such tool|invalid tool|method not found|unrecognized tool/i

const V0_HOSTS = new Set(["v0.app", "www.v0.app", "v0.dev", "www.v0.dev"])
const CHAT_ID = /^[A-Za-z0-9_-]{3,100}$/

/**
 * Accepts `https://v0.app/chat/<id>`, the title-slug form and team-prefixed links (also `v0.dev`, with or without query/hash
 * or a trailing slash) and returns the chat id and canonical URL. Throws a
 * user-presentable Error for anything else.
 */
export function parseV0ChatUrl(raw: string): { chatId: string; url: string } {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new V0ArtifactError("Enter a v0 chat URL such as https://v0.app/chat/abc123") }
  if (url.protocol !== "https:" || !V0_HOSTS.has(url.hostname.toLowerCase())) throw new V0ArtifactError("Enter a v0 chat URL such as https://v0.app/chat/abc123")
  if (url.username || url.password) throw new V0ArtifactError("The v0 URL must not contain credentials")
  // Real v0 links take three shapes: /chat/<id>, /chat/<title-slug>-<id> and, for team
  // chats, /<team>/chat/<title-slug>-<id>. The API wants only the id, which is the part
  // after the last hyphen of the slug (verified against chats_get: the full slug 404s).
  const parts = url.pathname.split("/").filter(Boolean)
  const chatIndex = parts.indexOf("chat")
  if (chatIndex < 0 || chatIndex > 1 || !parts[chatIndex + 1]) throw new V0ArtifactError("That is not a v0 chat URL. Expected https://v0.app/chat/<id>")
  const segment = decodeURIComponent(parts[chatIndex + 1])
  const trailing = segment.slice(segment.lastIndexOf("-") + 1)
  const chatId = segment.includes("-") && CHAT_ID.test(trailing) ? trailing : segment
  if (!CHAT_ID.test(chatId)) throw new V0ArtifactError("That v0 chat URL has an unrecognised chat id")
  return { chatId, url: canonicalV0ChatUrl(chatId) }
}

export function canonicalV0ChatUrl(chatId: string): string {
  return `https://v0.app/chat/${encodeURIComponent(chatId)}`
}

export interface V0Snapshot {
  chatId: string
  title: string | null
  /** Identifies the state of the chat; changes when v0 produces something new. */
  versionId: string
  url: string
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null)

/**
 * Pulls a snapshot out of whatever `getChat` returned.
 *
 * The version marker, in order of preference: the latest *version* id (changes
 * only when v0 generates new code), else the latest *message* id, else the
 * chat's `updatedAt`. `updatedAt` is last because a rename also bumps it.
 * (Observed 2026-10-06: v0's `chats_get` returns only chat metadata, so
 * `updatedAt` is what is actually used today.)
 * Exported for tests.
 */
export function extractV0Snapshot(payload: unknown, requestedChatId: string): V0Snapshot {
  const root = asRecord(payload)
  // v0's REST-style tools wrap the chat as `{ success, data: {...} }`.
  const unwrapped = asRecord(root?.data) ?? root
  const chat = asRecord(unwrapped?.chat) ?? unwrapped
  if (!chat) throw new V0ArtifactError("v0 returned a response Compass could not read for this chat.")
  const returnedId = asString(chat.id) ?? asString(chat.chatId)
  if (returnedId && returnedId !== requestedChatId) throw new V0ArtifactError("v0 returned a different chat than the one requested.")

  const latestVersion = asRecord(chat.latestVersion) ?? asRecord(chat.version)
  const versions = Array.isArray(chat.versions) ? chat.versions : null
  const messages = Array.isArray(chat.messages) ? chat.messages : null
  const lastOf = (items: unknown[] | null) => asRecord(items && items.length ? items[items.length - 1] : null)

  const versionId =
    asString(latestVersion?.id) ??
    asString(chat.latestVersionId) ??
    asString(chat.versionId) ??
    asString(lastOf(versions)?.id) ??
    asString(lastOf(messages)?.id) ??
    asString(chat.lastMessageId) ??
    asString(chat.updatedAt)
  if (!versionId) throw new V0ArtifactError("v0 did not report a version for this chat, so Compass cannot tell whether it changed.")

  const returnedUrl = asString(chat.webUrl) ?? asString(chat.url)
  let url = canonicalV0ChatUrl(requestedChatId)
  if (returnedUrl) {
    try {
      const parsed = parseV0ChatUrl(returnedUrl)
      if (parsed.chatId === requestedChatId) url = parsed.url
    } catch { /* keep the canonical URL */ }
  }
  return { chatId: requestedChatId, title: asString(chat.title) ?? asString(chat.name), versionId: versionId.slice(0, 200), url }
}

const GET_CHAT_LIKE = /^(?:chats?[._-]?get|get[._-]?chat|chats?[._-]?retrieve|retrieve[._-]?chat)$/i

export async function fetchV0Snapshot(userId: string, chatId: string): Promise<V0Snapshot> {
  const attempt = async (toolName: string) => {
    const result = await callConnectorTool({ slug: "v0", userId, toolName, args: { chatId } })
    return extractV0Snapshot(result.structured, chatId)
  }
  let lastError: unknown
  for (const toolName of V0_GET_CHAT_TOOLS) {
    try {
      return await attempt(toolName)
    } catch (error) {
      lastError = error
      // Only "that tool does not exist" moves on to the next name; auth, timeout
      // and chat-level errors must surface as they are.
      if (!(error instanceof Error) || !UNKNOWN_TOOL.test(error.message)) throw error
    }
  }
  // Neither known name exists on this server, so ask it what it offers.
  let names: string[]
  try { names = await listConnectorToolNames({ slug: "v0", userId }) } catch { throw lastError }
  const match = names.find((n) => GET_CHAT_LIKE.test(n) && !(V0_GET_CHAT_TOOLS as readonly string[]).includes(n))
  if (!match) throw new V0ArtifactError(`Compass could not find a "get chat" tool on the v0 connector. It offers: ${names.slice(0, 40).join(", ") || "(none)"}.`)
  return attempt(match)
}

function requireUser(userId: string | null | undefined): string {
  if (!userId) throw new V0ArtifactError("v0 chats are read with your own v0 connection, so this needs a signed-in user (not a service key).")
  return userId
}

export async function createV0Artifact(input: {
  workspaceId: string; url: string; title?: string | null; description?: string | null; userId: string | null | undefined; source: Source
}) {
  const userId = requireUser(input.userId)
  const { chatId } = parseV0ChatUrl(input.url)
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true } })
  if (!workspace) throw new V0ArtifactError("Workspace not found")
  const explicit = input.title?.trim()
  // Read v0 before writing anything: a user who has not connected v0, or a chat
  // they cannot see, must not leave a half-made Artifact behind.
  const snapshot = await fetchV0Snapshot(userId, chatId)
  const title = validateArtifactTitle(explicit || snapshot.title || `v0 chat ${chatId}`)
  return prisma.$transaction(async (tx) => {
    const artifact = await tx.artifact.create({ data: {
      workspaceId: input.workspaceId, title, description: input.description?.trim() || null,
      sourceType: "V0_CHAT", v0ChatId: chatId, createdById: userId, updatedById: userId, source: input.source,
    } })
    const revision = await tx.artifactRevision.create({ data: {
      artifactId: artifact.id, revisionNumber: 1, externalUrl: snapshot.url, v0VersionId: snapshot.versionId, createdById: userId, source: input.source,
    } })
    await tx.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: revision.id, updatedAt: new Date() } })
    return { ...artifact, currentRevisionId: revision.id }
  })
}

export type RefreshV0Result =
  | { changed: true; revisionId: string; revisionNumber: number; versionId: string }
  | { changed: false; revisionNumber: number | null; versionId: string }

export async function refreshV0Artifact(input: {
  artifactId: string; workspaceId: string; userId: string | null | undefined; source: Source
}): Promise<RefreshV0Result> {
  const userId = requireUser(input.userId)
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({
    where: { id: input.artifactId, workspaceId: input.workspaceId, sourceType: "V0_CHAT" },
    select: { id: true, status: true, v0ChatId: true, currentRevision: { select: { revisionNumber: true, v0VersionId: true } } },
  })
  if (!artifact || !artifact.v0ChatId) throw new V0ArtifactError("v0 chat artifact not found")
  if (artifact.status !== "ACTIVE") throw new V0ArtifactError("Archived artifacts cannot be refreshed")

  const snapshot = await fetchV0Snapshot(userId, artifact.v0ChatId)
  if (artifact.currentRevision?.v0VersionId === snapshot.versionId)
    return { changed: false, revisionNumber: artifact.currentRevision.revisionNumber, versionId: snapshot.versionId }

  const latest = await prisma.artifactRevision.findFirst({ where: { artifactId: artifact.id }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } })
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1
  try {
    const revision = await prisma.$transaction(async (tx) => {
      const created = await tx.artifactRevision.create({ data: {
        artifactId: artifact.id, revisionNumber, externalUrl: snapshot.url, v0VersionId: snapshot.versionId, createdById: userId, source: input.source,
      } })
      await tx.artifact.update({ where: { id: artifact.id }, data: { currentRevisionId: created.id, updatedById: userId, updatedAt: new Date() } })
      return created
    })
    return { changed: true, revisionId: revision.id, revisionNumber, versionId: snapshot.versionId }
  } catch (error) {
    // A concurrent refresh took this revision number. Its revision already
    // reflects (at least) what we fetched, so report "no change" rather than fail.
    if ((error as { code?: string }).code === "P2002")
      return { changed: false, revisionNumber: latest?.revisionNumber ?? null, versionId: snapshot.versionId }
    throw error
  }
}

export interface V0Preview {
  /** v0's running preview of the chat (the `*.v0.build` origin). */
  url: string
  /** Sent as `x-v0-preview-token`; v0 redirects to sign-in without it. Never put it in a URL. */
  token: string | null
  /** When v0 stops honouring the token, if it said. */
  expiresAt: string | null
}

const V0_PREVIEW_TOOLS = ["chats_getPreview", "getPreview"] as const
const PREVIEW_LIKE = /^(?:chats?[._-]?get[._-]?preview|get[._-]?(?:chat[._-]?)?preview)$/i

/** Exported for tests. Returns null for "no preview yet" or an unframeable URL. */
export function extractV0Preview(payload: unknown): V0Preview | null {
  const root = asRecord(payload)
  const data = asRecord(root?.data) ?? root
  const rawUrl = asString(data?.url)
  if (!rawUrl) return null
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== "https:" || url.username || url.password || !V0_PREVIEW_UPSTREAM_HOST.test(url.hostname)) return null
  return { url: url.toString(), token: asString(data?.token) ?? null, expiresAt: asString(data?.expiresAt) ?? null }
}

/**
 * The live preview of a chat, read with the viewer's own v0 grant. The preview
 * URL is never stored: v0 issues a short-lived token with it, so it is fetched
 * on each view. Best effort: any failure (v0 not connected, no preview yet, an
 * unknown tool) yields null and the page falls back to the link to the chat.
 */
export async function fetchV0Preview(userId: string, chatId: string, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<V0Preview | null> {
  // The page waits on this, so a slow connector must cost a few seconds, not the connector's 30s.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.())
  return Promise.race([loadV0Preview(userId, chatId), timeout])
}

const PREVIEW_TIMEOUT_MS = 6_000

async function loadV0Preview(userId: string, chatId: string): Promise<V0Preview | null> {
  try {
    const call = async (toolName: string) => extractV0Preview((await callConnectorTool({ slug: "v0", userId, toolName, args: { chatId } })).structured)
    for (const toolName of V0_PREVIEW_TOOLS) {
      try { return await call(toolName) } catch (error) {
        if (!(error instanceof Error) || !UNKNOWN_TOOL.test(error.message)) return null
      }
    }
    const match = (await listConnectorToolNames({ slug: "v0", userId })).find((n) => PREVIEW_LIKE.test(n) && !(V0_PREVIEW_TOOLS as readonly string[]).includes(n))
    return match ? await call(match) : null
  } catch (error) {
    console.warn("[v0-artifacts] preview unavailable:", error instanceof Error ? error.message : error)
    return null
  }
}
