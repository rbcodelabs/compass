"use client"

import { useState, useTransition } from "react"
import { createApiKey, revokeApiKey } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

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
        // Refresh key list — server action revalidated the path, but since this
        // is a client component we just refetch by reloading the server-rendered data
        // The page will re-render with fresh data from the server on next navigation.
        // For now, add an optimistic stub so the list updates immediately.
        setKeys((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
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

  function handleRevoke(keyId: string) {
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
  }

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys.filter((k) => k.revokedAt)

  return (
    <div className="flex flex-col gap-4">
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
            <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1 font-mono break-all">
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

      {/* Active keys */}
      {activeKeys.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          <Table>
            <TableHeader className="bg-slate-50">
              <TableRow className="hover:bg-slate-50">
                <TableHead className="px-3 py-2 text-xs text-slate-500">Name</TableHead>
                <TableHead className="px-3 py-2 text-xs text-slate-500">Prefix</TableHead>
                <TableHead className="px-3 py-2 text-xs text-slate-500">Created</TableHead>
                <TableHead className="px-3 py-2 text-xs text-slate-500">Last used</TableHead>
                <TableHead className="px-3 py-2"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeKeys.map((k) => (
                <TableRow key={k.id} className="bg-white">
                  <TableCell className="px-3 py-2 font-medium text-slate-900">{k.name}</TableCell>
                  <TableCell className="px-3 py-2 font-mono text-slate-500">cmp_{k.keyPrefix}…</TableCell>
                  <TableCell className="px-3 py-2 text-slate-500">
                    {k.createdAt.toLocaleDateString()}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-slate-500">
                    {k.lastUsedAt ? k.lastUsedAt.toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(k.id)}
                      disabled={isPending}
                      className="text-destructive hover:text-destructive"
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeKeys.length === 0 && !newKey && (
        <p className="text-sm text-muted-foreground">No API keys yet. Generate one above.</p>
      )}

      {/* Revoked keys */}
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
                    <TableCell className="px-3 py-2 font-medium line-through text-slate-500">{k.name}</TableCell>
                    <TableCell className="px-3 py-2 font-mono text-slate-400">cmp_{k.keyPrefix}…</TableCell>
                    <TableCell className="px-3 py-2 text-slate-400">
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
