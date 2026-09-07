export function probeBudget(durationSeconds = 120) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) throw new Error("INVALID_BUDGET_DURATION")
  const audioInputTokens = Math.ceil(durationSeconds * 10)
  const maxOutputTokens = 128
  const transcriptionReserveUsd = 0.05
  const sandboxReserveUsd = 0.25 // 5min 1vCPU/2GB, creation + generous egress reserve
  // Rates verified 2026-09-07: gpt-realtime-2.1 $32/$64 audio,
  // $4/$24 text per million tokens. Count output against BOTH rates conservatively.
  const estimatedUsd = 1 + audioInputTokens * 32 / 1e6 + 8192 * 4 / 1e6 +
    maxOutputTokens * (64 + 24) / 1e6 + transcriptionReserveUsd + sandboxReserveUsd
  if (estimatedUsd >= 5) throw new Error("PROBE_BUDGET_EXCEEDED")
  return { estimatedUsd, audioInputTokens, maxOutputTokens, transcriptionReserveUsd, sandboxReserveUsd }
}
