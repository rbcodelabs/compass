/**
 * The `updatedAt` write interceptor, kept in its own module — deliberately free
 * of any relative import — so that it can be loaded from three places
 * `lib/db.ts` cannot reach:
 *
 *  1. unit tests, without dragging in `pg`/`@prisma/adapter-pg` and the
 *     env-dependent connection logic in `lib/db.ts`;
 *  2. `scripts/*.ts`, which Node executes directly under
 *     `--experimental-strip-types` and therefore cannot resolve `lib/db.ts`
 *     (that file imports `./schema` without a file extension);
 *  3. the `*.integration.test.ts` specs, which build their own client against a
 *     throwaway schema and must still match the production client exactly.
 */
import { Prisma } from "@prisma/client";

/**
 * Model names that declare an `updatedAt` field, derived from the generated
 * datamodel rather than hardcoded so this can never drift from the schema.
 * Built once at module scope — `Prisma.dmmf` is static for a given client.
 */
export const MODELS_WITH_UPDATED_AT: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "updatedAt"))
    .map((model) => model.name)
);

/**
 * Sets `updatedAt` on a write payload unless the caller supplied it.
 *
 * Uses an `in` check rather than a truthiness check so that an explicit
 * `updatedAt: undefined` is still treated as caller-supplied and left alone.
 */
function applyUpdatedAt(payload: unknown, now: Date): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
  if ("updatedAt" in payload) return;
  (payload as Record<string, unknown>).updatedAt = now;
}

/**
 * Injects `updatedAt` into update-shaped writes.
 *
 * Aurora DSQL has no trigger support, so `prisma/schema.prisma` declares
 * `updatedAt DateTime @default(now())` instead of `@updatedAt` and nothing
 * bumps the column for us. Relying on every call site to remember
 * (`.claude/pr-guidelines.md`) did not hold: an audit of origin/main found 38
 * of 82 direct write paths omitted it, leaving Experiment, Solution,
 * Assumption, Opportunity, Objective and KeyResult timestamps frozen at
 * creation time. Doing it here makes the guarantee structural instead of
 * depending on reviewer vigilance.
 *
 * `create`/`createMany` are deliberately untouched — `@default(now())`
 * already covers inserts. For `upsert` only the `update` branch is modified,
 * for the same reason.
 *
 * KNOWN LIMITATION: this hook only sees the top-level operation, so nested
 * relation writes (e.g. `data: { solutions: { update: { ... } } }`) do NOT get
 * an injected `updatedAt` on the nested model and still need it passed
 * explicitly. Separately, mutating a child row never marks its parent as
 * updated — that is a deliberate product decision tracked outside this file.
 */
export const injectUpdatedAtExtension = Prisma.defineExtension({
  name: "injectUpdatedAt",
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (model && MODELS_WITH_UPDATED_AT.has(model)) {
          const now = new Date();
          if (operation === "update" || operation === "updateMany") {
            applyUpdatedAt((args as { data?: unknown }).data, now);
          } else if (operation === "upsert") {
            applyUpdatedAt((args as { update?: unknown }).update, now);
          }
        }
        return query(args);
      },
    },
  },
});
