"use client"

import { useId, useState } from "react"
import { Search } from "lucide-react"

/**
 * The docs hub's search-first box. It filters the published docs already on this page (the docs widget's list
 * items) as you type, so it needs no search backend and can never surface anything the customer cannot see.
 */
export function HubSearch() {
  const inputId = useId()
  const [status, setStatus] = useState("")

  const filter = (query: string) => {
    const needle = query.trim().toLowerCase()
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-widget-type="docs"] li'))
    let shown = 0
    for (const item of items) {
      const match = needle === "" || (item.textContent ?? "").toLowerCase().includes(needle)
      item.hidden = !match
      if (match) shown += 1
    }
    if (needle === "") setStatus("")
    else if (items.length === 0) setStatus("No published docs on this page to search yet.")
    else setStatus(shown === 0 ? `No docs match "${query.trim()}".` : `${shown} ${shown === 1 ? "doc matches" : "docs match"}.`)
  }

  return (
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
          onChange={(event) => filter(event.target.value)}
          className="min-h-12 min-w-0 flex-1 bg-transparent text-[17px] text-[#14110F] outline-none placeholder:text-[#6F6A61]"
        />
        <button type="submit" className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90">Search</button>
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-[#B9B3A9]">{status}</p>
    </form>
  )
}
