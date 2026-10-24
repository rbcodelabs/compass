import { ConnectError, getToken } from "@vercel/connect"

/**
 * Read-only Slack Web API client. The bot token comes from Vercel Connect
 * (connector named by COMPASS_SLACK_CONNECTOR, e.g. "slack/compass"); Connect
 * holds the Slack app credentials and Compass never stores or logs the token.
 * Unset means the feature is off.
 *
 * Only methods that read are exposed here. Every method used is limited by
 * Slack itself to conversations the bot has been invited to, which is the
 * access boundary for the MCP tools built on this client.
 */
export const SLACK_CONNECTOR_ENV = "COMPASS_SLACK_CONNECTOR"

const SLACK_API = "https://slack.com/api"
const REQUEST_TIMEOUT_MS = 10_000
const MAX_USER_PAGES = 5

export function slackConnectorUid(): string | null {
  return process.env[SLACK_CONNECTOR_ENV]?.trim() || null
}

/** Carries only a Slack/Connect error code, never an upstream body or token. */
export class SlackError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? `Slack request failed (${code})`)
    this.code = code
  }
}

async function botToken(): Promise<string> {
  const uid = slackConnectorUid()
  if (!uid) throw new SlackError("not_configured", `${SLACK_CONNECTOR_ENV} must be configured`)
  try {
    return await getToken(uid, { subject: { type: "app" } })
  } catch (error) {
    if (error instanceof ConnectError) throw new SlackError("connect_" + String(error.code ?? error.status ?? "error"), `Vercel Connect Slack token request failed (${error.code ?? error.status ?? "error"})`)
    throw new SlackError("connect_error", "Vercel Connect Slack token request failed")
  }
}

type SlackParams = Record<string, string | number | boolean | undefined>

async function call<T>(method: string, params: SlackParams): Promise<T> {
  const token = await botToken()
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, String(value))
  let response: Response
  try {
    response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new SlackError("network_error")
  }
  if (response.status === 429) throw new SlackError("ratelimited")
  if (!response.ok) throw new SlackError(`http_${response.status}`)
  const json = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null
  if (!json?.ok) throw new SlackError(json?.error ?? "invalid_response")
  return json as T
}

export type SlackChannel = {
  id: string
  name: string
  isPrivate: boolean
  memberCount: number | null
  topic: string
  purpose: string
}

export type SlackMessage = {
  ts: string
  time: string
  user: string | null
  botId: string | null
  text: string
  threadTs: string | null
  replyCount: number
}

export type SlackUser = {
  id: string
  name: string
  displayName: string
  realName: string
  title: string
  isBot: boolean
}

export type Page<T> = { items: T[]; nextCursor: string | null }

const MAX_TEXT = 4000

function clip(text: unknown): string {
  const s = typeof text === "string" ? text : ""
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [truncated]` : s
}

function isoFromTs(ts: string): string {
  const ms = Math.round(Number(ts) * 1000)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ""
}

type RawChannel = { id: string; name?: string; is_private?: boolean; num_members?: number; topic?: { value?: string }; purpose?: { value?: string } }
type RawMessage = { ts: string; user?: string; bot_id?: string; text?: string; thread_ts?: string; reply_count?: number }
type RawUser = { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string; title?: string } }
type Cursored = { response_metadata?: { next_cursor?: string } }

const nextCursor = (r: Cursored) => r.response_metadata?.next_cursor || null

function toMessage(m: RawMessage): SlackMessage {
  return {
    ts: m.ts,
    time: isoFromTs(m.ts),
    user: m.user ?? null,
    botId: m.bot_id ?? null,
    text: clip(m.text),
    threadTs: m.thread_ts ?? null,
    replyCount: m.reply_count ?? 0,
  }
}

/** Channels the bot is a member of (public and private). */
export async function listBotChannels(opts: { limit: number; cursor?: string }): Promise<Page<SlackChannel>> {
  const r = await call<{ channels: RawChannel[] } & Cursored>("users.conversations", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: opts.limit,
    cursor: opts.cursor,
  })
  return {
    items: r.channels.map(c => ({
      id: c.id,
      name: c.name ?? "",
      isPrivate: Boolean(c.is_private),
      memberCount: c.num_members ?? null,
      topic: c.topic?.value ?? "",
      purpose: c.purpose?.value ?? "",
    })),
    nextCursor: nextCursor(r),
  }
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/

/** Accepts a channel ID or a #name; names resolve only among channels the bot is in. */
export async function resolveChannelId(channel: string): Promise<string> {
  const value = channel.trim()
  if (CHANNEL_ID.test(value)) return value
  const wanted = value.replace(/^#/, "").toLowerCase()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await listBotChannels({ limit: 200, cursor })
    const hit = result.items.find(c => c.name.toLowerCase() === wanted)
    if (hit) return hit.id
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  throw new SlackError("channel_not_found")
}

export async function readChannelHistory(channelId: string, opts: { limit: number; cursor?: string; oldest?: string; latest?: string }): Promise<Page<SlackMessage>> {
  const r = await call<{ messages: RawMessage[] } & Cursored>("conversations.history", {
    channel: channelId,
    limit: opts.limit,
    cursor: opts.cursor,
    oldest: opts.oldest,
    latest: opts.latest,
  })
  return { items: r.messages.map(toMessage), nextCursor: nextCursor(r) }
}

export async function readThreadReplies(channelId: string, threadTs: string, opts: { limit: number; cursor?: string }): Promise<Page<SlackMessage>> {
  const r = await call<{ messages: RawMessage[] } & Cursored>("conversations.replies", {
    channel: channelId,
    ts: threadTs,
    limit: opts.limit,
    cursor: opts.cursor,
  })
  return { items: r.messages.map(toMessage), nextCursor: nextCursor(r) }
}

/**
 * Case-insensitive match on handle, display name and real name. Slack has no
 * server-side user search, so this pages users.list (bounded). Emails are never
 * requested or returned.
 */
export async function searchUsers(query: string, limit: number): Promise<{ items: SlackUser[]; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  const items: SlackUser[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_USER_PAGES; page++) {
    const r = await call<{ members: RawUser[] } & Cursored>("users.list", { limit: 200, cursor })
    for (const u of r.members) {
      if (u.deleted) continue
      const user: SlackUser = {
        id: u.id,
        name: u.name ?? "",
        displayName: u.profile?.display_name ?? "",
        realName: u.real_name ?? u.profile?.real_name ?? "",
        title: u.profile?.title ?? "",
        isBot: Boolean(u.is_bot),
      }
      if ([user.name, user.displayName, user.realName].some(v => v.toLowerCase().includes(needle))) {
        items.push(user)
        if (items.length >= limit) return { items, truncated: true }
      }
    }
    cursor = nextCursor(r) ?? undefined
    if (!cursor) return { items, truncated: false }
  }
  return { items, truncated: true }
}

/** User-facing explanation for a SlackError, without upstream detail. */
export function describeSlackError(error: unknown): string {
  if (!(error instanceof SlackError)) return "Slack request failed."
  switch (error.code) {
    case "not_configured":
      return `Slack isn't configured for this Compass deployment (${SLACK_CONNECTOR_ENV} is unset).`
    case "not_in_channel":
    case "channel_not_found":
      return "That channel wasn't found, or the Compass bot hasn't been invited to it. Invite the bot to the channel in Slack and try again."
    case "thread_not_found":
      return "That thread wasn't found in the channel. Check the thread timestamp."
    case "ratelimited":
      return "Slack is rate limiting requests. Try again shortly."
    case "missing_scope":
      return "The Slack app is missing a required scope. Ask an admin to update the Compass Slack app."
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "The Compass Slack bot credential was rejected. Ask an admin to reinstall the Slack connector."
    default:
      return error.code.startsWith("connect_")
        ? "The Compass Slack connector isn't installed or authorized. Ask an admin to finish the Vercel Connect Slack install."
        : `Slack request failed (${error.code}).`
  }
}
