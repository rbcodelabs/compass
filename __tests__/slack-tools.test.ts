import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectError, connectMocks, resetConnectMocks } from "./helpers/mock-vercel-connect"

vi.mock("@vercel/connect", async () => (await import("./helpers/mock-vercel-connect")).connectModule())

import { slackListChannels, slackReadChannel, slackReadThread, slackSearchUsers } from "@/lib/slack-tool-handlers"

const fetchMock = vi.fn()

function slack(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: init.status ?? 200 }))
}

const sent = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit]
  return { url, headers: init.headers as Record<string, string>, body: Object.fromEntries(new URLSearchParams(String(init.body))) }
}

beforeEach(() => {
  resetConnectMocks()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("COMPASS_SLACK_CONNECTOR", "slack/compass")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("slack tools", () => {
  it("is off, without calling Slack or Connect, when the connector is unset", async () => {
    vi.stubEnv("COMPASS_SLACK_CONNECTOR", "")
    const result = await slackListChannels({})
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.message).toContain("isn't configured")
    expect(connectMocks.getToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("mints an app token from the configured connector and lists the bot's channels", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: true, channels: [{ id: "C1", name: "pm", is_private: false, num_members: 4, purpose: { value: "Product" } }], response_metadata: { next_cursor: "n1" } }))
    const result = await slackListChannels({ limit: 500 })
    expect(connectMocks.getToken).toHaveBeenCalledWith("slack/compass", { subject: { type: "app" } })
    const call = sent()
    expect(call.url).toBe("https://slack.com/api/users.conversations")
    expect(call.headers.Authorization).toBe("Bearer connect-token")
    expect(call.body.limit).toBe("100") // clamped
    expect(result.structuredContent.data).toMatchObject({ count: 1, nextCursor: "n1", items: [{ id: "C1", name: "pm", isPrivate: false }] })
  })

  it("reads a channel by ID and shapes messages", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: true, messages: [{ ts: "1700000000.000100", user: "U1", text: "hi", reply_count: 2, thread_ts: "1700000000.000100" }] }))
    const result = await slackReadChannel({ channel: "C0123ABCD", limit: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().url).toBe("https://slack.com/api/conversations.history")
    expect(sent().body).toMatchObject({ channel: "C0123ABCD", limit: "5" })
    expect(result.structuredContent.data).toMatchObject({ items: [{ user: "U1", text: "hi", replyCount: 2, time: "2023-11-14T22:13:20.000Z" }] })
  })

  it("resolves #name only among channels the bot is in", async () => {
    fetchMock
      .mockReturnValueOnce(slack({ ok: true, channels: [{ id: "CAAAAAAA1", name: "general" }, { id: "CBBBBBBB2", name: "pm-team" }] }))
      .mockReturnValueOnce(slack({ ok: true, messages: [] }))
    await slackReadChannel({ channel: "#PM-Team" })
    expect(sent(0).url).toContain("users.conversations")
    expect(sent(1).body.channel).toBe("CBBBBBBB2")
  })

  it("explains how to fix a channel the bot is not in, and never echoes Slack bodies", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: false, error: "not_in_channel", secret: "leak-me" }))
    const result = await slackReadChannel({ channel: "C0123ABCD" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.message).toContain("Invite the bot")
    expect(JSON.stringify(result)).not.toContain("leak-me")
  })

  it("reports an unknown #name as not found", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: true, channels: [{ id: "CAAAAAAA1", name: "general" }] }))
    const result = await slackReadChannel({ channel: "#nope" })
    expect(result.structuredContent.message).toContain("Invite the bot")
  })

  it("reads a thread", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: true, messages: [{ ts: "1.1", user: "U1", text: "a" }, { ts: "1.2", user: "U2", text: "b" }] }))
    const result = await slackReadThread({ channel: "C0123ABCD", threadTs: "1.1" })
    expect(sent().url).toBe("https://slack.com/api/conversations.replies")
    expect(sent().body.ts).toBe("1.1")
    expect(result.structuredContent.data).toMatchObject({ count: 2 })
  })

  it("truncates very long message text", async () => {
    fetchMock.mockReturnValueOnce(slack({ ok: true, messages: [{ ts: "1.1", text: "x".repeat(9000) }] }))
    const result = await slackReadChannel({ channel: "C0123ABCD" })
    const text = (result.structuredContent.data as { items: { text: string }[] }).items[0].text
    expect(text.length).toBeLessThan(4100)
    expect(text).toContain("[truncated]")
  })

  it("searches users without returning emails", async () => {
    fetchMock.mockReturnValueOnce(slack({
      ok: true,
      members: [
        { id: "U1", name: "rick", real_name: "Rick Bowman", profile: { display_name: "rick", title: "PM", email: "rick@example.com" } },
        { id: "U2", name: "sam", real_name: "Sam", profile: {} },
        { id: "U3", name: "rickd", deleted: true, profile: {} },
      ],
    }))
    const result = await slackSearchUsers({ query: "RICK" })
    expect(result.structuredContent.data).toMatchObject({ count: 1, items: [{ id: "U1", realName: "Rick Bowman", title: "PM" }] })
    expect(JSON.stringify(result)).not.toContain("example.com")
  })

  it("maps Connect failures to an install hint without leaking detail", async () => {
    connectMocks.getToken.mockRejectedValueOnce(new ConnectError("raw upstream detail", { code: "client_installation_required" }))
    const result = await slackListChannels({})
    expect(result.structuredContent.message).toContain("Vercel Connect")
    expect(JSON.stringify(result)).not.toContain("raw upstream detail")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("maps rate limiting and network failures", async () => {
    fetchMock.mockReturnValueOnce(slack({}, { status: 429 }))
    expect((await slackListChannels({})).structuredContent.message).toContain("rate limiting")
    fetchMock.mockRejectedValueOnce(new Error("boom"))
    expect((await slackListChannels({})).structuredContent.message).toContain("network_error")
  })
})
