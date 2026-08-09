import { describe, it, expect } from "vitest"
import { parseSseFrames } from "@/lib/sse-frames"

describe("parseSseFrames", () => {
  it("parses complete event/data frames", () => {
    const { frames, rest } = parseSseFrames('event: status\ndata: {"phase":"booting"}\n\nevent: done\ndata: {}\n\n')
    expect(frames).toEqual([
      { event: "status", data: '{"phase":"booting"}' },
      { event: "done", data: "{}" },
    ])
    expect(rest).toBe("")
  })

  it("carries an incomplete trailing frame forward in rest", () => {
    const { frames, rest } = parseSseFrames('event: result\ndata: {"text":"hi"}\n\nevent: don')
    expect(frames).toEqual([{ event: "result", data: '{"text":"hi"}' }])
    expect(rest).toBe("event: don")
  })

  it("reassembles a frame split across chunk boundaries", () => {
    let buf = "event: agent\nda"
    let out = parseSseFrames(buf)
    expect(out.frames).toEqual([])
    buf = out.rest + 'ta: {"n":1}\n\n'
    out = parseSseFrames(buf)
    expect(out.frames).toEqual([{ event: "agent", data: '{"n":1}' }])
  })

  it("defaults the event name to 'message' when only data is present", () => {
    const { frames } = parseSseFrames("data: hello\n\n")
    expect(frames).toEqual([{ event: "message", data: "hello" }])
  })
})
