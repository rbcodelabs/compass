/** Never log error messages, stacks, payloads, or arbitrary provider codes. */
export function researchFailureDiagnostic(error: unknown): { category: string; status?: number } {
  const value = error && typeof error === "object" ? error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown; response?: unknown; cause?: unknown } : {}
  const response = value.response && typeof value.response === "object" ? value.response as { status?: unknown } : {}
  const cause = value.cause && typeof value.cause === "object" ? value.cause as { code?: unknown } : {}
  const rawStatus = value.status ?? value.statusCode ?? response.status
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined
  // Inspect messages only to map to fixed labels; the source text never leaves this function.
  const message = typeof value.message === "string" ? value.message : ""
  const category = status === 401 || /authentication_error|invalid.api.key/i.test(message) ? "authentication_failed"
    : status === 403 || value.code === "EACCES" ? "permission_denied"
    : value.code === "ENOENT" ? "file_not_found"
    : [value.code, cause.code].some(code => typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(code)) ? "network_failure"
    : status === 429 || /rate.limit/i.test(message) ? "rate_limited"
    : status === 404 || /model.*not.found|not_found_error/i.test(message) ? "resource_not_found"
    : value.name === "AbortError" || /deadline|timed?.?out|timeout/i.test(message) ? "deadline_exceeded"
    : value.name === "VercelOidcContextError" || /not initialized|not configured/i.test(message) ? "configuration_missing"
    : /context.*(length|window)|too.many.tokens|prompt.is.too.long/i.test(message) ? "context_limit"
    : /error_max_turns/i.test(message) ? "max_turns"
    : /error_during_execution/i.test(message) ? "provider_execution_failed"
    : value.name === "SyntaxError" || value.name === "ZodError" ? "invalid_output"
    : status && status >= 500 ? "upstream_unavailable"
    : "unexpected_failure"
  return { category, ...(status === undefined ? {} : { status }) }
}
