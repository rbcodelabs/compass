import { z } from "zod"
import { TRACKED_OPTION_LIMITS } from "@/lib/tracked-decision-types"

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
