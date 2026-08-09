/**
 * Minimal Server-Sent Events frame parser for the agent chat client.
 *
 * The agent turn route (app/api/agent/turn/route.ts) emits frames of the form
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 * over a chunked fetch body. Chunks don't align to frame boundaries, so callers
 * keep a rolling buffer: append each decoded chunk, call parseSseFrames, use the
 * returned complete frames, and carry `rest` forward for the next chunk.
 */

export type SseFrame = { event: string; data: string }

export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  let idx: number
  while ((idx = buffer.indexOf("\n\n")) >= 0) {
    const raw = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 2)
    let event = "message"
    const dataLines: string[] = []
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join("\n") })
  }
  return { frames, rest: buffer }
}
