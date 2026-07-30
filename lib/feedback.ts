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
