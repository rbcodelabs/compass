"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
}: {
  orgSlug: string;
  rows: AgentAccessRow[];
  canManage: boolean;
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
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">No active agents owned by organization members.</p>
      ) : (
        <Table className="min-w-[40rem]">
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Scoring-model admin</TableHead>
                <TableHead><span className="sr-only">Action</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.agentId}>
                  <TableCell className="font-medium text-text-primary">{row.agentName}</TableCell>
                  <TableCell>{row.ownerName}</TableCell>
                  <TableCell>
                    {!row.granted && "Not granted"}
                    {row.granted && !row.inactive && `Granted by ${row.grantedByName}`}
                    {row.granted && row.inactive && (
                      <span className="text-status-danger">
                        Inactive — grantor no longer an org admin ({row.grantedByName})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {row.granted ? (
                      <Button variant="outline" size="sm" disabled={isPending} onClick={() => run(revokeAgentScoringModelAdmin, row.agentId)}>
                        Revoke
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={isPending} onClick={() => run(grantAgentScoringModelAdmin, row.agentId)}>
                        Allow scoring-model admin
                      </Button>
                    )}
                    {row.granted && row.inactive && (
                      <Button className="ml-2" size="sm" disabled={isPending} onClick={() => run(grantAgentScoringModelAdmin, row.agentId)}>
                        Re-grant as me
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
        </Table>
      )}
    </div>
  );
}
