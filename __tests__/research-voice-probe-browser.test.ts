import { chromium } from "@playwright/test"
import { describe, expect, it } from "vitest"
import { prepareSyntheticBrowser, releaseSyntheticBrowser } from "@/scripts/research-voice/browser"
import { packageProbeWorker } from "@/scripts/research-voice/build"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

describe("packaged probe local smoke", () => {
  it("loads the complete bundled worker under the test runner's Node22 without network", async () => {
    expect(process.versions.node.split(".")[0]).toBe("22")
    const dir = mkdtempSync(join(tmpdir(), "voice-worker-load-"))
    try {
      const path = join(dir, "worker.cjs")
      writeFileSync(path, await packageProbeWorker())
      const result = spawnSync(process.execPath, [path, "--self-test"], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, NODE_ENV: "test" } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("PROBE_WORKER_LOADED\n")
    } finally { rmSync(dir, { recursive: true }) }
  })
  it.skipIf(process.env.RUN_RESEARCH_VOICE_PROBE_BROWSER !== "1")("prepares audio-only SDP from a local synthetic buffer without microphone or remote SDP", async () => {
    const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
    try {
      const page = await browser.newPage()
      const frames = 2400; const wav = Buffer.alloc(44 + frames * 2)
      wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8)
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
      wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40)
      const result = await prepareSyntheticBrowser(page, wav)
      expect(result.durationMs).toBe(100)
      expect(result.offerSdp).toContain("m=audio")
      expect(result.offerSdp).not.toContain("m=application")
      expect(await page.evaluate(() => (globalThis as unknown as { probe: { pc: RTCPeerConnection } }).probe.pc.remoteDescription)).toBeNull()
      const answer = await page.evaluate(async (offer) => {
        const remote = new RTCPeerConnection()
        ;(globalThis as unknown as { remoteProbe: RTCPeerConnection }).remoteProbe = remote
        await remote.setRemoteDescription({ type: "offer", sdp: offer })
        await remote.setLocalDescription(await remote.createAnswer())
        await new Promise<void>((resolve) => {
          if (remote.iceGatheringState === "complete") return resolve()
          remote.addEventListener("icegatheringstatechange", () => { if (remote.iceGatheringState === "complete") resolve() })
        })
        return remote.localDescription!.sdp
      }, result.offerSdp)
      await releaseSyntheticBrowser(page, answer)
      expect(await page.evaluate(() => (globalThis as unknown as { probe: { pc: RTCPeerConnection } }).probe.pc.connectionState)).toBe("connected")
      await expect(releaseSyntheticBrowser(page, answer)).rejects.toThrow("SDP_ALREADY_RELEASED")
    } finally { await browser.close() }
  })
})
