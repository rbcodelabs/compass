"use client"

import { useId, useState } from "react"
import { Search } from "lucide-react"

/**
 * The docs hub's search-first box. It filters the published docs already on this page (the docs widget's list
 * items) as you type, so it needs no search backend and can never surface anything the customer cannot see.
 */
export function HubSearch({ suggestions = [] }: { suggestions?: string[] }) {
  const inputId = useId()
  const [status, setStatus] = useState("")
  const [query, setQuery] = useState("")

  const filter = (value: string) => {
    setQuery(value)
    const needle = value.trim().toLowerCase()
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-widget-type="docs"] li'))
    let shown = 0
    for (const item of items) {
      const match = needle === "" || (item.textContent ?? "").toLowerCase().includes(needle)
      item.hidden = !match
      if (match) shown += 1
    }
    if (needle === "") setStatus("")
    else if (items.length === 0) setStatus("No published docs on this page to search yet.")
    else setStatus(shown === 0 ? `No docs match "${value.trim()}".` : `${shown} ${shown === 1 ? "doc matches" : "docs match"}.`)
  }

  return (
    <>
    <form
      role="search"
      aria-label="Search docs"
      className="mx-auto w-full max-w-2xl"
      onSubmit={(event) => {
        event.preventDefault()
        document.getElementById("docs")?.scrollIntoView({ behavior: "smooth", block: "start" })
      }}
    >
      <label htmlFor={inputId} className="sr-only">Search the docs</label>
      <div className="relative flex items-center rounded-xl bg-white p-1.5 pl-12 shadow-[0_18px_40px_rgba(0,0,0,0.45)] focus-within:ring-4 focus-within:ring-[#A294FF]">
        <Search className="absolute left-4 size-5 text-[#5B564F]" aria-hidden />
        <input
          id={inputId}
          type="search"
          autoComplete="off"
          placeholder="Search the docs"
          value={query}
          onChange={(event) => filter(event.target.value)}
          className="min-h-12 min-w-0 flex-1 bg-transparent text-[17px] text-[#14110F] outline-none placeholder:text-[#6F6A61]"
        />
        <button type="submit" className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90">Search</button>
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-[#B9B3A9]">{status}</p>
    </form>
    {suggestions.length > 0 ? (
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2" data-testid="hub-popular">
        <span className="mr-1 text-[13px] font-semibold tracking-[0.08em] text-[#B9B3A9] uppercase">Popular</span>
        {suggestions.map((term) => (
          <button
            key={term}
            type="button"
            onClick={() => filter(term)}
            className="max-w-full truncate rounded-full border border-[#4D473E] px-3.5 py-1 text-sm text-[#FAF9F6] hover:border-[#A294FF] hover:bg-[#26221E] focus-visible:ring-2 focus-visible:ring-[#A294FF] focus-visible:outline-none"
          >
            {term}
          </button>
        ))}
      </div>
    ) : null}
    </>
  )
}
