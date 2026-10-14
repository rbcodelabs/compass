import { z } from "zod"
import { TRACKED_OPTION_LIMITS, TRACKED_QUESTION_LIMITS } from "@/lib/tracked-decision-types"

const { min, max, labelMax, descriptionMax } = TRACKED_OPTION_LIMITS

/**
 * MCP input for `request_decision.options`. Kept beside the limits it shares
 * with `lib/tracked-decisions.ts` (which re-validates authoritatively) so the
 * tool schema and the service cannot drift apart.
 */
export const decisionOptionsInputSchema = z.array(z.object({
  label: z.string().min(1).max(labelMax).describe("Short choice label shown on the button. Unique (case-insensitive) within the request; \"Request changes\" and \"Reject\" are reserved."),
  description: z.string().max(descriptionMax).optional().describe("Optional one-to-two sentence explanation of what choosing this option means."),
})).min(min).max(max).optional().describe(`Single-choice answers for the human to pick from (${min}-${max}). Omit for the standard Approve / Request changes / Reject.`)

const { headerMax, questionMax, min: minQuestions, max: maxQuestions } = TRACKED_QUESTION_LIMITS

/**
 * MCP input for `request_decision.questions`: several questions in one
 * request, each with its own single-choice options. Mutually exclusive with
 * `options` (the service rejects both).
 */
export const decisionQuestionsInputSchema = z.array(z.object({
  header: z.string().max(headerMax).optional().describe(`Optional short label for the question (up to ${headerMax} characters), e.g. "Database".`),
  question: z.string().min(1).max(questionMax).describe("The question the human answers by picking one option."),
  options: z.array(z.object({
    label: z.string().min(1).max(labelMax).describe("Short choice label. Unique (case-insensitive) within this question; \"Request changes\" and \"Reject\" are reserved."),
    description: z.string().max(descriptionMax).optional().describe("Optional one-to-two sentence explanation of what choosing this option means."),
  })).min(min).max(max).describe(`${min}-${max} single-choice answers for this question.`),
})).min(minQuestions).max(maxQuestions).optional().describe(`Ask ${minQuestions}-${maxQuestions} questions in one request, each with its own single-choice options (like AskUserQuestion's questions[]). The human answers every question and submits once. Mutually exclusive with \`options\`. Omit for a single-question request.`)
