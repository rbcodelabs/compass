/**
 * Create/update of feedback sources, shared by every caller that has already
 * decided the actor may administer the workspace.
 *
 * Two callers exist: the settings server actions (session auth, resolved by
 * `resolveWorkspaceAdmin`) and the `create_feedback_source` /
 * `update_feedback_source` MCP tools (gated by `assertWorkspaceAdmin`). This
 * module deliberately contains NO session or authorization logic — it takes the
 * prisma client, the already-authorized workspace id and the acting user id, and
 * enforces only the data rules (input validation, artifact in the same
 * workspace, origin normalization, visitor-session revocation).
 */
import type getPrisma from "@/lib/db"
import {
  DEFAULT_EMBED_AUTH_MODE,
  parseEmbedAuthMode,
  resolveEmbedAuthMode,
  type EmbedAuthMode,
} from "@/lib/embed-auth-mode"
import { mintEmbedToken, normalizeAllowedOrigins } from "@/lib/embed-sources"

export const MAX_NAME_LENGTH = 255

/** Operator-facing input failures, distinct from a bug or a permission denial. */
export class EmbedSourceInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmbedSourceInputError"
  }
}

export type EmbedServiceContext = {
  prisma: ReturnType<typeof getPrisma>
  /** Already authorized by the caller; the service never re-checks membership. */
  workspaceId: string
  userId: string | null
}

export function requireName(value: string): string {
  const name = value.trim()
  if (!name) throw new EmbedSourceInputError("Give this feedback source a name.")
  if (name.length > MAX_NAME_LENGTH) {
    throw new EmbedSourceInputError(`A name may be at most ${MAX_NAME_LENGTH} characters.`)
  }
  return name
}

/**
 * Validates an operator-chosen auth mode, or falls back to the safe default.
 *
 * `undefined` means "the caller did not ask", which is right on create. A
 * present but unrecognized value is rejected loudly: silently filing it as
 * INTERNAL_SSO would flip a source the operator believed was set to external
 * reviewers.
 */
export function requireAuthMode(value: string | undefined): EmbedAuthMode {
  if (value === undefined) return DEFAULT_EMBED_AUTH_MODE
  const parsed = parseEmbedAuthMode(value)
  if (!parsed) throw new EmbedSourceInputError("Choose who can comment on this prototype.")
  return parsed
}

/**
 * A source is only usable when bound to an ACTIVE artifact in *this* workspace —
 * resolveEmbedToken refuses an unbound source with a 501, and a cross-workspace
 * binding would let an admin of one workspace open a write path into another.
 */
export async function requireArtifact(
  prisma: EmbedServiceContext["prisma"],
  workspaceId: string,
  artifactId: string
): Promise<string> {
  const id = artifactId.trim()
  if (!id) throw new EmbedSourceInputError("Choose which prototype this feedback belongs to.")
  const artifact = await prisma.artifact.findFirst({
    where: { id, workspaceId, status: "ACTIVE" },
    select: { id: true },
  })
  if (!artifact) throw new EmbedSourceInputError("That prototype no longer exists in this workspace.")
  return artifact.id
}

export type CreatedEmbedSource = {
  id: string
  token: string
  tokenId: string
  tokenPrefix: string
  allowedOrigins: string[]
  authMode: EmbedAuthMode
}

export async function createEmbedSource(
  ctx: EmbedServiceContext,
  input: { name: string; artifactId: string; allowedOrigins: string[]; authMode?: string }
): Promise<CreatedEmbedSource> {
  const { prisma, workspaceId, userId } = ctx
  const name = requireName(input.name)
  const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins)
  const authMode = requireAuthMode(input.authMode)
  const artifactId = await requireArtifact(prisma, workspaceId, input.artifactId)

  const { source, minted } = await prisma.$transaction(async (tx) => {
    const source = await tx.feedbackSource.create({
      // `authMode` is written explicitly even though NULL would read as
      // INTERNAL_SSO: the column has no database default (DSQL cannot add one to an
      // existing column), so an operator who chose the default deserves a row that
      // records the choice.
      data: { workspaceId, artifactId, name, allowedOrigins, enabled: true, authMode, createdById: userId },
      select: { id: true },
    })
    // Persisting the hash and creating the source are one unit: callers must
    // never receive an unusable one-time credential or leave an orphan source.
    const minted = await mintEmbedToken({
      feedbackSourceId: source.id,
      label: "Initial token",
      createdById: userId,
    }, tx)
    return { source, minted }
  })
  return {
    id: source.id,
    token: minted.token,
    tokenId: minted.tokenId,
    tokenPrefix: minted.tokenPrefix,
    allowedOrigins,
    authMode,
  }
}

export type UpdatedEmbedSource = {
  name: string
  allowedOrigins: string[]
  enabled: boolean
  authMode: EmbedAuthMode
}

export async function updateEmbedSource(
  ctx: EmbedServiceContext,
  sourceId: string,
  input: { name?: string; allowedOrigins?: string[]; enabled?: boolean; authMode?: string }
): Promise<UpdatedEmbedSource> {
  const { prisma, workspaceId } = ctx

  // Scoped by workspaceId, not just id: a valid uuid belonging to another
  // workspace must not be editable here.
  const existing = await prisma.feedbackSource.findFirst({
    where: { id: sourceId, workspaceId },
    select: { id: true, name: true, allowedOrigins: true, enabled: true, authMode: true },
  })
  if (!existing) throw new EmbedSourceInputError("That feedback source no longer exists.")

  const name = input.name === undefined ? existing.name : requireName(input.name)
  const allowedOrigins =
    input.allowedOrigins === undefined
      ? (existing.allowedOrigins as string[])
      : normalizeAllowedOrigins(input.allowedOrigins)
  const enabled = input.enabled === undefined ? existing.enabled : input.enabled
  // `requireAuthMode` is not reused for the omitted case: its `undefined` means
  // "default", which is right on create and wrong on update — toggling `enabled`
  // must not silently reset a PORTAL source to internal. An omitted field keeps
  // the stored value, read through resolveEmbedAuthMode so a legacy NULL comes
  // back as a real mode and gets persisted as one on the next save.
  const previousMode = resolveEmbedAuthMode(existing.authMode)
  const authMode = input.authMode === undefined ? previousMode : requireAuthMode(input.authMode)

  await prisma.$transaction(async tx => {
    await tx.feedbackSource.update({
      where: { id: existing.id },
      data: { name, allowedOrigins, enabled, authMode, updatedAt: new Date() },
    })

    // The mode and its visitor-session kill switch are one security change.
    // A failed revocation must roll back the mode update so retry still sees
    // the old mode and attempts revocation again.
    if (authMode !== previousMode) {
      await tx.embedVisitorSession.updateMany({
        where: { feedbackSourceId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
  })
  return { name, allowedOrigins, enabled, authMode }
}

export type EmbedSnippet = {
  /** The full tag when the Compass origin is known, otherwise null. */
  snippet: string | null
  scriptPath: string
  scriptUrl: string | null
}

export const EMBED_SCRIPT_PATH = "/embed/widget.js"

/**
 * The paste-ready script tag. When the deployment's public origin is not
 * configured no tag is produced at all (a relative `src` would silently load
 * from the *embedding* site and 404), so callers get the path and token
 * separately and can explain why.
 */
export function buildEmbedSnippet(baseUrl: string | null, token: string): EmbedSnippet {
  if (!baseUrl) return { snippet: null, scriptPath: EMBED_SCRIPT_PATH, scriptUrl: null }
  const scriptUrl = `${baseUrl.replace(/\/+$/, "")}${EMBED_SCRIPT_PATH}`
  return {
    snippet: `<script src="${scriptUrl}" data-compass-token="${token}" defer></script>`,
    scriptPath: EMBED_SCRIPT_PATH,
    scriptUrl,
  }
}
