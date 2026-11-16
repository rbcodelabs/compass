"use client"

import { useEffect, useState } from "react"
import * as NextNavigation from "next/navigation"

export const CLIENT_SUGGESTIONS_CACHE_MAX = 50
export const CLIENT_SUGGESTIONS_SETTLE_MS = 400
export const CLIENT_SUGGESTIONS_LOADING_DELAY_MS = 150
export const CLIENT_SUGGESTIONS_STALE_RECHECK_MS = 120_000

export type CachedPageSuggestions = {
  label: string | null
  pageUrl: string
  revisionKey: string | null
  mode: "reading" | "authoring" | null
  suggestions: string[]
  fetchedAt: number
}

type ApiPageSuggestionsResponse = {
  label?: string | null
  pageUrl?: string | null
  revisionKey?: string | null
  mode?: "reading" | "authoring" | null
  suggestions?: unknown
}

type SearchParamsLike = { get(name: string): string | null }

function readPathnameFallback(): string {
  return typeof window !== "undefined" ? window.location.pathname : ""
}

function readSearchParamsFallback(): SearchParamsLike {
  return new URLSearchParams(typeof window !== "undefined" ? window.location.search : "")
}

function getPathnameHook(): () => string | null {
  try {
    if (typeof NextNavigation.usePathname === "function") {
      return NextNavigation.usePathname
    }
  } catch {
    // Legacy tests that partially mock `next/navigation` with only `useRouter`
  }
  return readPathnameFallback
}

function getSearchParamsHook(): () => SearchParamsLike | null {
  try {
    if (typeof NextNavigation.useSearchParams === "function") {
      return NextNavigation.useSearchParams
    }
  } catch {
    // Legacy tests that partially mock `next/navigation` with only `useRouter`
  }
  return readSearchParamsFallback
}

function useSafePathname(): string {
  const usePathnameHook = getPathnameHook()
  return usePathnameHook() ?? ""
}

function useSafeSearchParams(): SearchParamsLike | null {
  const useSearchParamsHook = getSearchParamsHook()
  return useSearchParamsHook()
}

function isEligibleWorkspacePageUrl(rawPageUrl: string): boolean {
  if (!rawPageUrl.startsWith("/") || rawPageUrl.startsWith("//")) return false
  const qIndex = rawPageUrl.indexOf("?")
  const pathname = qIndex === -1 ? rawPageUrl : rawPageUrl.slice(0, qIndex)
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length < 2) return false
  if (segments[2] === "agent") return false
  return true
}

const clientSuggestionsCache = new Map<string, CachedPageSuggestions>()

export function peekClientCachedSuggestions(key: string): CachedPageSuggestions | null {
  return clientSuggestionsCache.get(key) ?? null
}

export function setClientCachedSuggestions(key: string, entry: CachedPageSuggestions): void {
  clientSuggestionsCache.delete(key)
  if (clientSuggestionsCache.size >= CLIENT_SUGGESTIONS_CACHE_MAX) {
    const oldestKey = clientSuggestionsCache.keys().next().value
    if (oldestKey !== undefined) {
      clientSuggestionsCache.delete(oldestKey)
    }
  }
  clientSuggestionsCache.set(key, entry)
}

/** Test seam: clears the module-scoped client suggestion cache between tests. */
export function resetClientPageSuggestionsCache(): void {
  clientSuggestionsCache.clear()
}

export type UsePageSuggestionsInput = {
  workspaceId: string
  enabled: boolean
  hasDraft: boolean
}

export type UsePageSuggestionsResult = {
  label: string | null
  pageUrl: string
  mode: "reading" | "authoring" | null
  suggestions: string[]
  loading: boolean
  pinnedWhileTyping: boolean
}

export function usePageSuggestions({
  workspaceId,
  enabled,
  hasDraft,
}: UsePageSuggestionsInput): UsePageSuggestionsResult {
  const pathname = useSafePathname()
  const searchParams = useSafeSearchParams()
  const detail = searchParams?.get("detail") ?? null

  const rawPageUrl = detail ? `${pathname}?detail=${encodeURIComponent(detail)}` : pathname
  const eligibleUrl = isEligibleWorkspacePageUrl(rawPageUrl)
  const cacheKey = workspaceId && eligibleUrl ? `${workspaceId}:${rawPageUrl}` : ""

  // Version tick increments whenever an async fetch writes to `clientSuggestionsCache`.
  const [, setCacheVersion] = useState(0)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  const currentCached = cacheKey ? peekClientCachedSuggestions(cacheKey) : null

  // Freeze whatever stack was visible when the user began typing in the composer
  // (`hasDraft === true`) so background navigation never swaps prompts under their cursor.
  const [pinnedSnapshot, setPinnedSnapshot] = useState<{
    key: string
    entry: CachedPageSuggestions | null
  }>(() => ({ key: cacheKey, entry: currentCached }))

  if (!hasDraft && (pinnedSnapshot.key !== cacheKey || pinnedSnapshot.entry !== currentCached)) {
    setPinnedSnapshot({ key: cacheKey, entry: currentCached })
  }

  useEffect(() => {
    if (!enabled || hasDraft || !workspaceId || !eligibleUrl || !cacheKey) {
      return
    }

    const existing = peekClientCachedSuggestions(cacheKey)
    const now = Date.now()

    // Fresh cache hit: 0ms revisit with zero network traffic.
    if (existing && now - existing.fetchedAt <= CLIENT_SUGGESTIONS_STALE_RECHECK_MS) {
      return
    }

    let controller: AbortController | null = null
    let loadingTimer: ReturnType<typeof setTimeout> | null = null

    const runFetch = async (isBackgroundRecheck: boolean) => {
      controller = new AbortController()
      if (!isBackgroundRecheck) {
        loadingTimer = setTimeout(() => {
          if (!controller?.signal.aborted) {
            setLoadingKey(cacheKey)
          }
        }, CLIENT_SUGGESTIONS_LOADING_DELAY_MS)
      }

      try {
        const query = new URLSearchParams({
          workspaceId,
          pageUrl: rawPageUrl,
        })
        const response = await fetch(`/api/agent/page-suggestions?${query.toString()}`, {
          method: "GET",
          signal: controller.signal,
        })
        if (loadingTimer) {
          clearTimeout(loadingTimer)
          loadingTimer = null
        }
        if (controller.signal.aborted) return

        if (!response.ok) {
          if (!isBackgroundRecheck) {
            setLoadingKey((prev) => (prev === cacheKey ? null : prev))
          }
          return
        }

        const data = (await response.json()) as ApiPageSuggestionsResponse
        if (controller.signal.aborted) return

        const suggestions = Array.isArray(data.suggestions)
          ? data.suggestions.filter((item): item is string => typeof item === "string")
          : []
        const nextEntry: CachedPageSuggestions = {
          label: typeof data.label === "string" ? data.label : null,
          pageUrl: typeof data.pageUrl === "string" && data.pageUrl ? data.pageUrl : rawPageUrl,
          revisionKey: typeof data.revisionKey === "string" ? data.revisionKey : null,
          mode: data.mode === "reading" || data.mode === "authoring" ? data.mode : null,
          suggestions,
          fetchedAt: Date.now(),
        }

        if (isBackgroundRecheck && existing) {
          if (nextEntry.revisionKey === existing.revisionKey) {
            setClientCachedSuggestions(cacheKey, {
              ...existing,
              fetchedAt: nextEntry.fetchedAt,
            })
            return
          }
        }

        setClientCachedSuggestions(cacheKey, nextEntry)
        setLoadingKey((prev) => (prev === cacheKey ? null : prev))
        setCacheVersion((v) => v + 1)
      } catch {
        if (loadingTimer) {
          clearTimeout(loadingTimer)
          loadingTimer = null
        }
        if (!controller?.signal.aborted && !isBackgroundRecheck) {
          setLoadingKey((prev) => (prev === cacheKey ? null : prev))
        }
      }
    }

    // Stale cache hit (> 120s old): surface cached stack in 0ms and quietly re-check in background.
    if (existing) {
      void runFetch(true)
      return () => {
        if (loadingTimer) clearTimeout(loadingTimer)
        controller?.abort()
      }
    }

    // Uncached screen: debounce 400ms so rapid navigation never fires wasted requests.
    const debounceTimer = setTimeout(() => {
      void runFetch(false)
    }, CLIENT_SUGGESTIONS_SETTLE_MS)

    return () => {
      clearTimeout(debounceTimer)
      if (loadingTimer) clearTimeout(loadingTimer)
      controller?.abort()
    }
  }, [cacheKey, eligibleUrl, enabled, hasDraft, rawPageUrl, workspaceId])

  if (!enabled) {
    return {
      label: null,
      pageUrl: rawPageUrl,
      mode: null,
      suggestions: [],
      loading: false,
      pinnedWhileTyping: false,
    }
  }

  const activeEntry = hasDraft ? pinnedSnapshot.entry : currentCached
  const suggestions = activeEntry?.suggestions ?? []
  const loading = Boolean(!hasDraft && !activeEntry && loadingKey === cacheKey && cacheKey !== "")
  const pinnedWhileTyping = Boolean(hasDraft && suggestions.length > 0)

  return {
    label: activeEntry?.label ?? null,
    pageUrl: activeEntry?.pageUrl ?? rawPageUrl,
    mode: activeEntry?.mode ?? null,
    suggestions,
    loading,
    pinnedWhileTyping,
  }
}
