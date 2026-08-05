/** Handler functions for OKR hierarchy MCP tools. */

import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy";

export async function listEligibleParentKeyResults({
  workspaceId,
  cycleId,
}: {
  workspaceId: string;
  cycleId: string;
}) {
  const options = await getEligibleParentKeyResults(workspaceId, cycleId);
  const text = options.length
    ? options
        .map((kr) => `${kr.cycleTitle} / ${kr.objectiveTitle} / ${kr.title}\nID: ${kr.id}`)
        .join("\n\n")
    : "No eligible higher-level Key Results found.";
  return { content: [{ type: "text" as const, text }] };
}
