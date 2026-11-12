/** Strips credentials, long opaque tokens, file paths and extra lines from text that is stored or shown (errors, floor reasons). */
export function sanitizeText(raw: string): string {
  return raw
    .split("\n")[0]
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/(?:\/[\w.@-]+){2,}(?::\d+){0,2}/g, "[path]")
    .slice(0, 300)
}

/** Name and message only: never a stack. */
export function sanitizeError(error: unknown): string {
  return sanitizeText(error instanceof Error ? `${error.name}: ${error.message}` : "Error: execution failed")
}
