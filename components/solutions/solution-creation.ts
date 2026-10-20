import { useMemo } from "react";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import type {
  GridBatchResult,
  GridCreation,
  GridDraftSubmitItem,
  GridDraftValues,
  GridEditOption,
} from "@/components/data-grid";
import { createSolutionsBatch } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { BATCH_DESCRIPTION_MAX_LENGTH, BATCH_MAX_ITEMS, BATCH_REQUEST_MAX_BYTES } from "@/lib/batch-create-limits";
import { OPPORTUNITY_TITLE_MAX_LENGTH } from "@/lib/opportunity-draft";

/**
 * "Add solutions" for the data grid: shared by the Discovery table (parent
 * preselected from an expanded row) and the Solutions backlog table. The parent
 * is chosen once per batch in the draft area's picker; a pasted parent column
 * may override it per row. Every user-visible word for the entities comes from
 * the workspace's thinking-model labels (`terms`), never a literal.
 */

/** Same cap as `SOLUTION_TITLE_MAX_LENGTH` in the batch core (not imported: it pulls Prisma into the client). */
export const SOLUTION_DRAFT_TITLE_MAX_LENGTH = OPPORTUNITY_TITLE_MAX_LENGTH;

export type SolutionParentOption = GridEditOption;

/** The workspace's words for the entities involved, from `useLabels()`. */
export type SolutionCreationTerms = {
  solution: { singular: string; plural: string };
  /** Capitalized, e.g. for the picker's accessible name. */
  parentLabel: string;
  /** Lowercase singular and plural. */
  parent: { singular: string; plural: string };
};

/** The workspace's own words for solutions and their parent, memoized so configs built from them stay stable. */
export function useSolutionCreationTerms(): SolutionCreationTerms {
  const { solution, opportunity } = useLabels();
  return useMemo(
    () => ({
      solution: { singular: solution.lower, plural: solution.lowerPlural },
      parentLabel: opportunity.singular,
      parent: { singular: opportunity.lower, plural: opportunity.lowerPlural },
    }),
    [solution.lower, solution.lowerPlural, opportunity.singular, opportunity.lower, opportunity.lowerPlural],
  );
}

export type ParentFailure =
  | { reason: "missing"; text: string }
  | { reason: "ambiguous"; text: string; count: number }
  | { reason: "unavailable" }
  | { reason: "unchosen" };

export type ParentMatch = { ok: true; id: string } | ({ ok: false } & ParentFailure);

/**
 * Resolves pasted parent text to an id by EXACT title (surrounding whitespace
 * ignored, case and spelling not). No fuzzy matching: writing a Solution under
 * the wrong parent is worse than asking the user to fix a cell. Zero matches
 * and several matches are both failures.
 */
export function matchParentByTitle(options: readonly SolutionParentOption[], text: string): ParentMatch {
  const wanted = text.trim();
  const matches = options.filter((option) => option.label.trim() === wanted);
  if (matches.length === 1) return { ok: true, id: matches[0].value };
  if (matches.length === 0) return { ok: false, reason: "missing", text: wanted };
  return { ok: false, reason: "ambiguous", text: wanted, count: matches.length };
}

export function describeParentFailure(failure: ParentFailure, terms: SolutionCreationTerms["parent"]): string {
  switch (failure.reason) {
    case "missing":
      return `No ${terms.singular} titled "${failure.text}". Check the title, or leave this cell empty to use the chosen one.`;
    case "ambiguous":
      return `${failure.count} ${terms.plural} are titled "${failure.text}". Leave this cell empty and choose one above.`;
    case "unavailable":
      return `That ${terms.singular} is not available in this workspace.`;
    case "unchosen":
      return `Choose ${/^[aeiou]/i.test(terms.singular) ? "an" : "a"} ${terms.singular} above, or enter its exact title.`;
  }
}

/** The row's own parent cell wins over the batch parent. */
function resolveParent(options: readonly SolutionParentOption[], values: GridDraftValues): ParentMatch {
  const typed = (values.opportunity ?? "").trim();
  if (typed) return matchParentByTitle(options, typed);
  const chosen = values.parent ?? "";
  if (!chosen) return { ok: false, reason: "unchosen" };
  if (!options.some((option) => option.value === chosen)) return { ok: false, reason: "unavailable" };
  return { ok: true, id: chosen };
}

export function buildSolutionCreation(
  parents: readonly SolutionParentOption[],
  terms: SolutionCreationTerms,
): Omit<GridCreation, "submit"> {
  const noun = terms.solution;
  return {
    fields: [
      { id: "title", label: "Title", kind: "text", maxLength: SOLUTION_DRAFT_TITLE_MAX_LENGTH },
      { id: "opportunity", label: `${terms.parentLabel} (optional)`, kind: "text", width: "12rem" },
      { id: "description", label: "Description", kind: "text", maxLength: BATCH_DESCRIPTION_MAX_LENGTH },
    ],
    makeValues: (): GridDraftValues => ({ title: "", opportunity: "", description: "" }),
    validate: (values) => {
      const errors: Record<string, string> = {};
      const title = (values.title ?? "").trim();
      if (!title) errors.title = "Add a title.";
      else if (title.length > SOLUTION_DRAFT_TITLE_MAX_LENGTH) {
        errors.title = `Title must be ${SOLUTION_DRAFT_TITLE_MAX_LENGTH} characters or fewer.`;
      }
      if ((values.description ?? "").trim().length > BATCH_DESCRIPTION_MAX_LENGTH) {
        errors.description = `Description must be ${BATCH_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
      }
      const parent = resolveParent(parents, values);
      if (!parent.ok) errors.opportunity = describeParentFailure(parent, terms.parent);
      return errors;
    },
    limits: { maxItems: BATCH_MAX_ITEMS.human, maxBytes: BATCH_REQUEST_MAX_BYTES },
    maxRows: 200,
    noun,
    addLabel: `Add ${noun.singular}...`,
    parent: {
      label: terms.parentLabel,
      options: parents,
      placeholder: `Choose ${/^[aeiou]/i.test(terms.parent.singular) ? "an" : "a"} ${terms.parent.singular}`,
    },
  };
}

/** Draft values to the server's item shape. A row that cannot resolve a parent is sent without one so the server reports it. */
export function toSolutionBatchItem(parents: readonly SolutionParentOption[], { clientId, values }: GridDraftSubmitItem) {
  const parent = resolveParent(parents, values);
  return {
    clientId,
    title: values.title ?? "",
    description: values.description?.trim() || null,
    parent: parent.ok ? { id: parent.id } : undefined,
  };
}

/** Server field names to draft field ids, so a server error lands on its cell; unmapped ones land on the row. */
const DRAFT_FIELD_BY_SERVER_FIELD: Record<string, string> = {
  title: "title",
  description: "description",
  parent: "opportunity",
};

export async function submitSolutionDrafts(
  slugs: { orgSlug: string; workspaceSlug: string } | null,
  parents: readonly SolutionParentOption[],
  items: GridDraftSubmitItem[],
): Promise<GridBatchResult> {
  if (!slugs) return { ok: false, error: "This workspace is not available." };
  const response = await createSolutionsBatch(slugs.orgSlug, slugs.workspaceSlug, items.map((item) => toSolutionBatchItem(parents, item)));
  if (!response.ok) return response;
  return {
    ok: true,
    results: response.results.map((result) =>
      result.ok ? result : { ...result, field: result.field ? DRAFT_FIELD_BY_SERVER_FIELD[result.field] : undefined },
    ),
  };
}
