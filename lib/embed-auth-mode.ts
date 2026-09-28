/**
 * Which identity a feedback source accepts from someone leaving a comment.
 *
 * Three modes:
 *
 *   - **INTERNAL_SSO** — the commenter is a Compass user, signed in through the
 *     ordinary SSO flow, **and a member of the workspace that owns the source**.
 *     Their comments are first-class `Comment` rows with a real `authorId`.
 *   - **PORTAL** — the commenter is a verified `PortalAccount`, reached by an
 *     emailed magic link, and their comments carry a `CommentExternalAuthor`
 *     shim instead. This is the original mode and the only one that existed
 *     first. A workspace with Portal SSO Identify configured can *also* let a
 *     PORTAL source's visitor skip the magic link via `POST /api/embed/sso` —
 *     that is an optional shortcut alongside the email path, not a different
 *     mode.
 *   - **PORTAL_SSO** — the same `PortalAccount` identity as PORTAL, reached
 *     *only* through Portal SSO Identify (`POST /api/embed/sso`). There is no
 *     magic-link fallback for this mode: the widget never offers one, and the
 *     first-party sign-in popup (app/embed/signin/actions.ts) refuses the
 *     magic-link path outright for a source in this mode, even when a portal
 *     session already exists from somewhere else. Distinct from PORTAL because
 *     the product decision (Compass Task cec67fab-92bc-4004-9527-ab62e291e054)
 *     is that an operator choosing "who can comment" sees this as a separate,
 *     explicit option rather than a hidden sub-mode of PORTAL gated by a
 *     workspace-level toggle.
 *
 * ## Why INTERNAL_SSO is the default, including for a NULL column
 *
 * It is the fail-safe direction: INTERNAL_SSO demands membership of the workspace
 * that owns the source, which is strictly stronger than "holds an email address
 * that can receive mail". So a NULL column, a source created by a caller that
 * does not set it, and an unrecognized stored value all resolve here rather than
 * being treated as PORTAL or throwing — a garbled column must not silently widen
 * who may write.
 *
 * Reading a NULL as PORTAL would be the unsafe inverse twice over: it would admit
 * anyone who can receive mail to a source nobody chose to open up, and it would do
 * so on a deployment where magic-link delivery may not be configured at all, which
 * turns "wrong mode" into "no working write path".
 *
 * ## Why the column is nullable rather than NOT NULL DEFAULT
 *
 * Aurora DSQL rejects `ADD COLUMN` that carries any constraint and counts
 * `DEFAULT` as one, so a schema that gains this column after the fact can only get
 * it as a bare nullable add. Rather than have two schemas disagree about the
 * column's shape, the `CREATE TABLE` declares it nullable with no DEFAULT too and
 * the coalesce lives here, in one place, in the application layer. Same pattern as
 * `workspaces.artifact_feedback_public`.
 */

export const EMBED_AUTH_MODES = ["INTERNAL_SSO", "PORTAL", "PORTAL_SSO"] as const

export type EmbedAuthMode = (typeof EMBED_AUTH_MODES)[number]

/** See the module header: null, unset, and unrecognized all land here. */
export const DEFAULT_EMBED_AUTH_MODE: EmbedAuthMode = "INTERNAL_SSO"

/**
 * Reads a stored `feedback_sources.auth_mode` into a mode.
 *
 * Total by construction — there is no failure case to handle at a call site,
 * because every unusable value resolves to the stricter mode.
 */
export function resolveEmbedAuthMode(stored: string | null | undefined): EmbedAuthMode {
  return EMBED_AUTH_MODES.includes(stored as EmbedAuthMode) ? (stored as EmbedAuthMode) : DEFAULT_EMBED_AUTH_MODE
}

/**
 * Validates a mode arriving from a form or an action argument.
 *
 * Distinct from {@link resolveEmbedAuthMode} on purpose: a *stored* value must
 * never fail closed-with-an-error (that would take a source offline over a data
 * problem), but operator *input* that does not name a real mode is a mistake
 * worth reporting rather than quietly rewriting. Returns null so the caller
 * shapes the message.
 */
export function parseEmbedAuthMode(value: unknown): EmbedAuthMode | null {
  return typeof value === "string" && EMBED_AUTH_MODES.includes(value as EmbedAuthMode)
    ? (value as EmbedAuthMode)
    : null
}
