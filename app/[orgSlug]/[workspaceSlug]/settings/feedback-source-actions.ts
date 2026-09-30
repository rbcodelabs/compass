"use server";

/**
 * Server actions for feedback sources — the admin half of the embed credential.
 *
 * ## Why these return a result object instead of throwing
 *
 * Next redacts the message of an uncaught server-action error in production, so
 * a thrown `EmbedOriginError` would reach the operator as "An unexpected error
 * occurred" — losing the one thing that tells them how to fix their typo. Every
 * expected failure below is therefore returned as `{ ok: false, error }`, the
 * shape lib/analytics/action-result.ts already established for the same reason.
 * Unexpected failures are logged server-side and reported generically.
 *
 * ## Why workspace admin, not workspace member
 *
 * Minting an embed token creates a credential that lets an arbitrary page write
 * comments into this workspace, and editing the origin allowlist decides which
 * pages those are. That is a higher bar than changing a WIP limit, so these use
 * resolveWorkspaceAdmin (which also admits org admins) rather than the
 * membership-only resolveWorkspace used by most of settings/actions.ts.
 *
 * ## There is no delete
 *
 * Disabling a source is the off switch, and revoking a token is the kill switch.
 * Deleting one would orphan every Comment and CommentElementAnchor already filed
 * through it, and Aurora DSQL enforces no cascades, so the cleanup would have to
 * be hand-rolled here — deleting public feedback as a side effect of tidying up
 * a settings list. Not offered on purpose.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions";
import { EmbedOriginError, mintEmbedToken, revokeEmbedToken } from "@/lib/embed-sources";
import type { EmbedAuthMode } from "@/lib/embed-auth-mode";
import {
  EmbedSourceInputError as InputError,
  createEmbedSource,
  updateEmbedSource,
} from "@/lib/embed-source-service";

const MAX_LABEL_LENGTH = 255;

type Err = { ok: false; error: string };

export type CreateFeedbackSourceResult =
  | {
      ok: true
      id: string
      token: string
      tokenId: string
      tokenPrefix: string
      allowedOrigins: string[]
      /** Echoed back for the same reason allowedOrigins is: what was stored, not what was typed. */
      authMode: EmbedAuthMode
    }
  | Err;

export type UpdateFeedbackSourceResult =
  | { ok: true; allowedOrigins: string[]; name: string; enabled: boolean; authMode: EmbedAuthMode }
  | Err;

export type MintFeedbackSourceTokenResult =
  | { ok: true; token: string; tokenId: string; tokenPrefix: string }
  | Err;

export type RevokeFeedbackSourceTokenResult = { ok: true } | Err;

/** Echoed back so the panel renders the stored state rather than its own optimism. */
export type SetArtifactFeedbackPublicResult = { ok: true; artifactFeedbackPublic: boolean } | Err;

async function guard<T extends { ok: true }>(run: () => Promise<T>): Promise<T | Err> {
  try {
    return await run();
  } catch (error) {
    // Both carry messages written for a human to read and act on.
    if (error instanceof EmbedOriginError || error instanceof InputError) {
      return { ok: false, error: error.message };
    }
    if (isPermissionError(error)) return { ok: false, error: error.message };
    console.error("[feedback-sources] action failed", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

function optionalLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (!label) return null;
  if (label.length > MAX_LABEL_LENGTH) {
    throw new InputError(`A token label may be at most ${MAX_LABEL_LENGTH} characters.`);
  }
  return label;
}

/**
 * Resolves the caller as a workspace admin and returns their user id alongside.
 *
 * `resolveWorkspaceAdmin` deliberately returns no user id, but `createdById` on
 * both tables wants one, so the session is read again here rather than widening
 * a helper the whole app shares.
 */
async function adminContext(orgSlug: string, workspaceSlug: string) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  const session = await auth();
  return { prisma, workspaceId, userId: session?.user?.id ?? null };
}

export async function createFeedbackSource(
  orgSlug: string,
  workspaceSlug: string,
  input: { name: string; artifactId: string; allowedOrigins: string[]; authMode?: string }
): Promise<CreateFeedbackSourceResult> {
  return guard(async () => {
    const { prisma, workspaceId, userId } = await adminContext(orgSlug, workspaceSlug);
    // Validation, artifact scoping and token minting live in the shared service
    // so the MCP tool applies exactly the same rules.
    const created = await createEmbedSource({ prisma, workspaceId, userId }, input);

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return {
      ok: true as const,
      id: created.id,
      token: created.token,
      tokenId: created.tokenId,
      tokenPrefix: created.tokenPrefix,
      allowedOrigins: created.allowedOrigins,
      authMode: created.authMode,
    };
  });
}

export async function updateFeedbackSource(
  orgSlug: string,
  workspaceSlug: string,
  sourceId: string,
  input: { name?: string; allowedOrigins?: string[]; enabled?: boolean; authMode?: string }
): Promise<UpdateFeedbackSourceResult> {
  return guard(async () => {
    const { prisma, workspaceId } = await adminContext(orgSlug, workspaceSlug);
    const updated = await updateEmbedSource({ prisma, workspaceId, userId: null }, sourceId, input);

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const, ...updated };
  });
}

/**
 * Turns `Workspace.artifactFeedbackPublic` on or off — the read side of the embed
 * feature, and until now an enforced-but-unsettable flag: four readers, no writer,
 * backfilled `false` by migration 062. The widget's read path consulted it and
 * nothing in the product could change it.
 *
 * Workspace-admin, same as every other action in this file and deliberately not
 * the membership-only `resolveWorkspace` that settings/actions.ts uses for the
 * portal toggles. Turning this on publishes a comment thread to every holder of an
 * embed token for this workspace, which is the same class of decision as minting
 * one of those tokens in the first place.
 *
 * Scoped to the whole workspace rather than per source because the column is: a
 * single flag covers every source, and pretending otherwise in the UI would
 * promise an isolation the schema cannot keep.
 */
export async function setArtifactFeedbackPublic(
  orgSlug: string,
  workspaceSlug: string,
  artifactFeedbackPublic: boolean
): Promise<SetArtifactFeedbackPublicResult> {
  return guard(async () => {
    const { prisma, workspaceId } = await adminContext(orgSlug, workspaceSlug);
    // `resolveWorkspaceAdmin` has already established that this workspace exists
    // and that the caller administers it, so the id needs no second scoping here —
    // unlike a sourceId or a tokenId, it did not come from the browser.
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { artifactFeedbackPublic },
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const, artifactFeedbackPublic };
  });
}

export async function mintFeedbackSourceToken(
  orgSlug: string,
  workspaceSlug: string,
  sourceId: string,
  label?: string | null
): Promise<MintFeedbackSourceTokenResult> {
  return guard(async () => {
    const { prisma, workspaceId, userId } = await adminContext(orgSlug, workspaceSlug);
    const source = await prisma.feedbackSource.findFirst({
      where: { id: sourceId, workspaceId },
      select: { id: true },
    });
    if (!source) throw new InputError("That feedback source no longer exists.");

    const minted = await mintEmbedToken({
      feedbackSourceId: source.id,
      label: optionalLabel(label),
      createdById: userId,
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const, token: minted.token, tokenId: minted.tokenId, tokenPrefix: minted.tokenPrefix };
  });
}

export async function revokeFeedbackSourceToken(
  orgSlug: string,
  workspaceSlug: string,
  tokenId: string
): Promise<RevokeFeedbackSourceTokenResult> {
  return guard(async () => {
    const { prisma, workspaceId } = await adminContext(orgSlug, workspaceSlug);
    // The workspace is reached through the parent source, so this is the same
    // cross-workspace guard as above — a token id alone proves nothing.
    const token = await prisma.feedbackSourceToken.findFirst({
      where: { id: tokenId, feedbackSource: { workspaceId } },
      select: { id: true },
    });
    if (!token) throw new InputError("That token no longer exists.");

    // False means it was already revoked. Reported as success: the caller asked
    // for a state that now holds, and an error would only be confusing.
    await revokeEmbedToken(token.id);

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true as const };
  });
}
