/**
 * The single writer of legacy-mirrored link types (ADR "One generic entity_links table", section 6, phase 4).
 *
 * Solution <-> Key Result is "new-only": the legacy Solution-Key Result table stays the source of truth and every read
 * stays on it. lib/typed-links.ts writes the legacy row, then calls the functions below inside the SAME
 * transaction, so the mirror row and the legacy row commit or roll back together and neither can drift.
 * Nothing is backfilled, so entity_links holds a partial shadow (links written while the flag was on);
 * reads, summaries and the generic link tools therefore ignore the type until a later phase backfills and
 * flips reads. Rollback is the flag: with it off no new mirror rows are written and nothing reads them.
 *
 * This module is the only caller that passes `viaLegacyWriter` to lib/links/service.ts.
 */
import type { AppTransactionClient } from "@/lib/db"
import { isLinkTypeEnabled, requireLinkType } from "@/lib/links/registry"
import { linkEntities, unlinkEntities } from "@/lib/links/service"
import type { LinkContext } from "@/lib/typed-links"

const KEY = "SOLUTION_TARGETS_KEY_RESULT"

type Pair = { solutionId: string; keyResultId: string; workspaceId: string }

/** Mirrors a link (idempotent) while the flag is on. The endpoints were verified by the legacy writer in this transaction and are re-verified by the service. */
export async function mirrorSolutionTargetsKeyResult(tx: AppTransactionClient, input: Pair & { ctx: LinkContext }): Promise<void> {
  if (!isLinkTypeEnabled(requireLinkType(KEY))) return
  await linkEntities(tx, {
    linkType: KEY,
    fromId: input.solutionId,
    toId: input.keyResultId,
    expectedWorkspaceId: input.workspaceId,
    ctx: input.ctx,
    viaLegacyWriter: true,
  })
}

/**
 * Removes the mirror row regardless of the flag, so a legacy unlink never strands a mirror row written while it was on.
 * The service verifies only the Solution (`from`) endpoint, so a Key Result deleted since is still handled.
 */
export async function unmirrorSolutionTargetsKeyResult(tx: AppTransactionClient, input: Pair): Promise<void> {
  await unlinkEntities(tx, { linkType: KEY, fromId: input.solutionId, toId: input.keyResultId, expectedWorkspaceId: input.workspaceId, viaLegacyWriter: true })
}
