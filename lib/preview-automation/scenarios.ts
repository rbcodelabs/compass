import type { AppTransactionClient } from "@/lib/db";
import {
  type SqlExec,
  seedSquads,
  seedOkrCycleAndObjectives,
  seedFullDemoData,
} from "@/seed-screenshots";

/**
 * Optional fixture shapes for a bootstrapped preview-automation run.
 *
 * ADR-0008 bootstraps a deliberately minimal fixture: one org, two empty
 * workspaces, and fixed owner/member personas. That is the right default
 * for the automated product-flow checks, which build the data they assert
 * on. It is a poor starting point for `preview:flow --explore`, where a
 * human or agent is reviewing a deployment and an empty workspace shows
 * nothing worth looking at.
 *
 * These scenarios close that gap without widening the trust boundary.
 * They are a closed, server-defined catalog keyed by a validated grant
 * claim — the request supplies an identifier, never table names, row
 * counts, or arbitrary content. This mirrors how `persona` already works
 * for session issuance: the client picks from a fixed set the server
 * defines, consistent with the ADR's "server generates synthetic
 * identities … neither arbitrary account identifiers nor arbitrary roles
 * are accepted".
 *
 * Seeding reuses the same exported fixture builders as
 * seed-screenshots.ts, so the demo-data script and preview runs can never
 * drift apart. Every row lands in the run's own workspace, so the
 * existing exact-ID teardown owns it: each table these builders touch
 * (squads, okr_cycles, objectives, key_results, opportunities, solutions,
 * assumptions, experiments, roadmap_items, feedback, tasks, task_links,
 * docs) is already deleted by deleteWorkspaceCascade. None of them are
 * artifacts or research attachments, so cleanupPreviewRun's blob-review
 * guard is not tripped.
 */
export const PREVIEW_SCENARIOS = ["empty", "full-data", "mid-okr-cycle"] as const;

export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number];

/**
 * Applied when a grant carries no scenario claim. Keeps previously signed
 * grants — and every existing CI workflow — on exactly the fixture they
 * bootstrap today.
 */
export const DEFAULT_PREVIEW_SCENARIO: PreviewScenario = "empty";

export function isPreviewScenario(value: unknown): value is PreviewScenario {
  return typeof value === "string" && (PREVIEW_SCENARIOS as readonly string[]).includes(value);
}

/** Human-facing one-liners for `preview:flow --scenario=…` help output. */
export const PREVIEW_SCENARIO_DESCRIPTIONS: Record<PreviewScenario, string> = {
  empty: "Bare org and workspaces, exactly as ADR-0008 bootstraps them (default).",
  "full-data": "Squads, an active OKR cycle, discovery, experiments, roadmap, feedback, tasks, and a doc.",
  "mid-okr-cycle": "Squads and an active OKR cycle only — no discovery or delivery work started.",
};

/**
 * Runs inside the caller's bootstrap transaction so fixtures commit with
 * the run registry row that owns them: a scenario can never leave rows
 * behind that teardown has no registered run to find.
 */
export async function applyPreviewScenario(
  tx: AppTransactionClient,
  options: { schema: string; workspaceId: string; scenario: PreviewScenario }
): Promise<void> {
  const { schema, workspaceId, scenario } = options;
  const exec: SqlExec = async (sql, params = []) =>
    (await tx.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];

  switch (scenario) {
    case "empty":
      return;
    case "mid-okr-cycle":
      await seedSquads(exec, schema, workspaceId);
      await seedOkrCycleAndObjectives(exec, schema, workspaceId);
      return;
    case "full-data":
      await seedFullDemoData(exec, schema, workspaceId);
      return;
    default: {
      // Unreachable for a validated grant; keeps the catalog and this
      // switch provably in sync if a scenario is added without a branch.
      const unhandled: never = scenario;
      throw new Error(`No seed strategy for preview scenario "${String(unhandled)}"`);
    }
  }
}
