"use client"

import { useCallback, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { createApiKey, revokeApiKey } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { DataGrid, type GridColumnDef } from "@/components/data-grid"

export type ApiKeyRow = {
  id: string
  name: string
  keyPrefix: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

type Props = {
  orgSlug: string
  workspaceSlug: string
  initialKeys: ApiKeyRow[]
}

export function ManageApiKeysPanel({ orgSlug, workspaceSlug, initialKeys }: Props) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys)
  const [newName, setNewName] = useState("")
  const [newKey, setNewKey] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleCreate() {
    if (!newName.trim()) return
    setError(null)
    startTransition(async () => {
      try {
        const result = await createApiKey(orgSlug, workspaceSlug, newName.trim())
        setNewKey(result.rawKey)
        setNewName("")
        setKeys((prev) => [
          ...prev,
          {
            id: result.id,
            name: newName.trim(),
            keyPrefix: result.rawKey.slice(4, 12),
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
          },
        ])
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create key")
      }
    })
  }

  // `revokeApiKey` throws rather than returning a result object, so this is
  // deliberately NOT wired through the grid's inline-edit contract (whose
  // `save` must resolve, never reject) — it stays a plain cell button.
  const handleRevoke = useCallback(
    (keyId: string) => {
      setError(null)
      startTransition(async () => {
        try {
          await revokeApiKey(orgSlug, workspaceSlug, keyId)
          setKeys((prev) =>
            prev.map((k) => (k.id === keyId ? { ...k, revokedAt: new Date() } : k))
          )
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to revoke key")
        }
      })
    },
    [orgSlug, workspaceSlug],
  )

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys.filter((k) => k.revokedAt)

  // Columns stay in this file rather than a sibling `*-columns` module:
  // `scripts/check-ui-colors.mjs` keys its baseline on `file::class`, and this
  // file carries a dozen baselined raw-palette classes. Relocating any of them
  // would start a new file at a baseline of zero and fail the gate.
  const columns = useMemo<GridColumnDef<ApiKeyRow>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        // No width — absorbs the remainder under `table-fixed`, with a
        // `minWidth` floor so it cannot collapse when the other columns
        // (33rem) out-sum the container. 12rem rather than the 18rem the
        // Tasks/Discovery titles use: key names are short self-chosen labels,
        // and this grid sits inside a narrow settings card, so a tighter floor
        // keeps the whole 45rem table reachable with less scrolling.
        meta: { label: "Name", hideable: false, minWidth: "12rem", cellClassName: "font-medium text-text-primary" },
        cell: ({ row }) => <span className="truncate">{row.original.name}</span>,
      },
      {
        id: "prefix",
        header: "Prefix",
        meta: { label: "Prefix", width: "10rem", cellClassName: "font-mono text-text-subtle" },
        cell: ({ row }) => `cmp_${row.original.keyPrefix}…`,
      },
      {
        id: "created",
        header: "Created",
        meta: { label: "Created", width: "8rem", cellClassName: "text-text-subtle" },
        // Pre-existing: an unlocalised `toLocaleDateString()` can differ
        // between the server and the browser. Unchanged by this migration —
        // the call still runs during render, just from a cell renderer.
        cell: ({ row }) => row.original.createdAt.toLocaleDateString(),
      },
      {
        id: "lastUsed",
        header: "Last used",
        meta: { label: "Last used", width: "8rem", cellClassName: "text-text-subtle" },
        cell: ({ row }) =>
          row.original.lastUsedAt ? row.original.lastUsedAt.toLocaleDateString() : "Never",
      },
      {
        id: "actions",
        // Empty visible header with a named label, matching the `sr-only`
        // "Actions" span this replaces. `hideable: false` pins it last.
        header: "",
        meta: { label: "Actions", hideable: false, width: "7rem", align: "end" },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleRevoke(row.original.id)}
            disabled={isPending}
            className="text-destructive hover:text-destructive"
          >
            Revoke
          </Button>
        ),
      },
    ],
    [handleRevoke, isPending],
  )

  return (
    <div className="flex flex-col gap-4">
      <Link href="/settings/agents" className="text-sm underline">Manage agent identities and keys</Link>
      {/* New key form */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="Key name (e.g. Claude Desktop)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          className="h-9 flex-1"
          disabled={isPending}
        />
        <Button
          onClick={handleCreate}
          disabled={isPending || !newName.trim()}
          className="h-9"
        >
          Generate
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* One-time key reveal */}
      {newKey && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-emerald-800">
            Copy this key now — it will never be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-surface-panel border border-emerald-200 rounded px-2 py-1 font-mono break-all">
              {newKey}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { navigator.clipboard.writeText(newKey); }}
              className="shrink-0 text-emerald-700 hover:text-emerald-900"
            >
              Copy
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setNewKey(null)}
            className="self-end text-emerald-600 hover:text-emerald-800"
          >
            I&apos;ve saved it ✓
          </Button>
        </div>
      )}

      {/* Active keys. `natural` height: this panel lives on a normally
          scrolling settings page, not inside a clipping content area. */}
      {activeKeys.length > 0 && (
        <DataGrid<ApiKeyRow>
          gridId="settings-api-keys"
          columns={columns}
          rows={activeKeys}
          getRowId={(row) => row.id}
          caption="Active API keys"
          height="natural"
          maxHeight="20rem"
          pagination={false}
          toolbar={false}
          className="overflow-hidden rounded-md border border-border bg-surface-panel"
        />
      )}

      {activeKeys.length === 0 && !newKey && (
        <p className="text-sm text-muted-foreground">No API keys yet. Generate one above.</p>
      )}

      {/* Revoked keys. Deliberately NOT migrated to DataGrid: this list has no
          header row by design, and the grid always renders a `<thead>` outside
          mobile mode. Converting it would add a header, a caption and a second
          persisted column-preference record to a collapsed three-column
          archive — a regression dressed as standardization. */}
      {revokedKeys.length > 0 && (
        <Collapsible className="group text-sm">
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" size="sm" className="text-muted-foreground" />}
          >
            <ChevronRight className="transition-transform group-data-open:rotate-90" />
            {revokedKeys.length} revoked {revokedKeys.length === 1 ? "key" : "keys"}
          </CollapsibleTrigger>
          <CollapsibleContent>
          <div className="mt-2 overflow-hidden rounded-md border border-border">
            <Table>
              <TableBody>
                {revokedKeys.map((k) => (
                  <TableRow key={k.id} className="bg-muted opacity-60">
                    <TableCell className="px-3 py-2 font-medium line-through text-text-subtle">{k.name}</TableCell>
                    <TableCell className="px-3 py-2 font-mono text-text-subtle">cmp_{k.keyPrefix}…</TableCell>
                    <TableCell className="px-3 py-2 text-text-subtle">
                      Revoked {k.revokedAt?.toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
