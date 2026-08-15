/** Handler functions for OKR hierarchy MCP tools. */

import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy";
import { ok, fail } from "@/lib/mcp-output";

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
  return options.length
    ? ok(text, {
        items: options.map((kr) => ({
          id: kr.id,
          cycleTitle: kr.cycleTitle,
          objectiveTitle: kr.objectiveTitle,
          title: kr.title,
        })),
        count: options.length,
      })
    : fail(text);
}
