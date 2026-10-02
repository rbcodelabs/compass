"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { grantAgentScoringModelAdmin, revokeAgentScoringModelAdmin } from "@/app/[orgSlug]/settings/actions";
import type { AgentAccessRow } from "@/lib/agent-org-admin-access";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Org-admin control for ADR 0020 AgentOrgAdminGrant. The page is already
 * admin-gated by the settings layout; `canManage` is a second, explicit gate
 * so a non-admin can never be handed the controls. The actions re-check
 * server-side regardless.
 */
export function AgentAccessPanel({
  orgSlug,
  rows,
  canManage,
  agentsEnabled,
}: {
  orgSlug: string;
  rows: AgentAccessRow[];
  canManage: boolean;
  agentsEnabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  if (!canManage) return null;

  function run(action: (orgSlug: string, agentId: string) => Promise<ActionResult>, agentId: string) {
    setError(null);
    startTransition(async () => {
      const result = await action(orgSlug, agentId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-subtle">
        &ldquo;Allow scoring-model admin&rdquo; lets an agent create, update and archive this organization&rsquo;s
        scoring models and assign one to a workspace. The grant lapses automatically if the admin who
        granted it loses their Owner/Admin role.
      </p>
      {!agentsEnabled && (
        <p className="text-sm text-text-muted">Agent changes are currently disabled; grants can be revoked but not issued.</p>
      )}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">No active agents owned by organization members.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-text-muted">
                <th className="py-2 pr-4 font-medium">Agent</th>
                <th className="py-2 pr-4 font-medium">Owner</th>
                <th className="py-2 pr-4 font-medium">Scoring-model admin</th>
                <th className="py-2 font-medium"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.agentId} className="border-b border-border-default last:border-0">
                  <td className="py-2 pr-4 font-medium text-text-primary">{row.agentName}</td>
                  <td className="py-2 pr-4">{row.ownerName}</td>
                  <td className="py-2 pr-4">
                    {!row.granted && "Not granted"}
                    {row.granted && !row.inactive && `Granted by ${row.grantedByName}`}
                    {row.granted && row.inactive && (
                      <span className="text-status-danger">
                        Inactive — grantor no longer an org admin ({row.grantedByName})
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {row.granted ? (
                      <Button variant="outline" size="sm" disabled={isPending} onClick={() => run(revokeAgentScoringModelAdmin, row.agentId)}>
                        Revoke
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={isPending || !agentsEnabled} onClick={() => run(grantAgentScoringModelAdmin, row.agentId)}>
                        Allow scoring-model admin
                      </Button>
                    )}
                    {row.granted && row.inactive && (
                      <Button className="ml-2" size="sm" disabled={isPending || !agentsEnabled} onClick={() => run(grantAgentScoringModelAdmin, row.agentId)}>
                        Re-grant as me
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
