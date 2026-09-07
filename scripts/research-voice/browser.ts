import type { Page } from "@playwright/test"
export async function prepareSyntheticBrowser(page: Page, wav: Buffer) {
  if (wav.length > 800_000) throw new Error("SYNTHETIC_AUDIO_TOO_LARGE")
  return page.evaluate(async (base64) => {
    const audio = new AudioContext({ sampleRate: 24000 })
    const buffer = await audio.decodeAudioData(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer)
    if (buffer.duration <= 0 || buffer.duration > 15 || buffer.numberOfChannels !== 1) throw new Error("INVALID_SYNTHETIC_AUDIO")
    const destination = audio.createMediaStreamDestination()
    const source = audio.createBufferSource(); source.buffer = buffer; source.connect(destination)
    const pc = new RTCPeerConnection()
    for (const track of destination.stream.getTracks()) pc.addTrack(track, destination.stream)
    pc.addEventListener("track", ({ streams }) => { const output = document.createElement("audio"); output.autoplay = true; output.srcObject = streams[0]; document.body.append(output) })
    ;(globalThis as unknown as { probe: unknown }).probe = { pc, audio, source }
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer)
    return { offerSdp: offer.sdp!, durationMs: buffer.duration * 1000 }
  }, wav.toString("base64"))
}
export async function releaseSyntheticBrowser(page: Page, answer: string) {
  await page.evaluate(async (sdp) => {
    const { pc, audio, source } = (globalThis as unknown as { probe: { pc: RTCPeerConnection; audio: AudioContext; source: AudioBufferSourceNode } }).probe
    if (pc.remoteDescription) throw new Error("SDP_ALREADY_RELEASED")
    await pc.setRemoteDescription({ type: "answer", sdp })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WEBRTC_NOT_CONNECTED")), 15_000)
      const check = () => { if (pc.connectionState === "connected") { clearTimeout(timer); pc.removeEventListener("connectionstatechange", check); resolve() } }
      pc.addEventListener("connectionstatechange", check); check()
    })
    await audio.resume()
    await new Promise<void>((resolve) => { source.onended = () => resolve(); source.start() })
    source.disconnect()
  }, answer)
}
