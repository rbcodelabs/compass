/**
 * Shared validation for in-app feedback creation, used by both the
 * workspace-scoped `createFeedback` action and the global
 * `sendCompassFeedback` action so the two entry points enforce identical
 * rules. (The public portal route validates independently — it has its
 * own trust boundary and attachment handling — but uses the same caps.)
 */

// Mirrors FeedbackItem.title's `@db.VarChar(255)` column limit.
export const FEEDBACK_TITLE_MAX_LENGTH = 255;
// FeedbackItem.description is `@db.Text` (unbounded), but an unbounded
// textarea invites accidental paste-dumps; cap at a generous length.
export const FEEDBACK_DESCRIPTION_MAX_LENGTH = 5000;

export type FeedbackInput = {
  title: string;
  description?: string | null;
};

export type ValidatedFeedbackInput = {
  title: string;
  description: string | null;
};

export type FeedbackValidationResult =
  | { valid: true; data: ValidatedFeedbackInput }
  | { valid: false; error: string };

export function validateFeedbackInput(input: FeedbackInput): FeedbackValidationResult {
  const title = (input.title ?? "").trim();
  if (!title) {
    return { valid: false, error: "Title is required" };
  }
  if (title.length > FEEDBACK_TITLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Title must be ${FEEDBACK_TITLE_MAX_LENGTH} characters or fewer`,
    };
  }

  const description = (input.description ?? "").trim();
  if (description.length > FEEDBACK_DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description must be ${FEEDBACK_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    };
  }

  return {
    valid: true,
    data: { title, description: description || null },
  };
}

/**
 * The write that links a feedback item to an opportunity (or unlinks it, with
 * null). Every entry point — the grid's opportunity cell, MCP's
 * link_feedback_to_opportunity and the opportunity composer's "Seed from
 * feedback" — uses this, so linking has the same side effects everywhere.
 *
 * Explicit `updatedAt`: DSQL has no trigger support, so the schema uses
 * `@default(now())` instead of `@updatedAt` and nothing bumps it for us.
 * Linking deliberately does not change the feedback item's status.
 */
export function feedbackOpportunityLinkData(opportunityId: string | null, now: Date = new Date()) {
  return { opportunityId, updatedAt: now };
}
