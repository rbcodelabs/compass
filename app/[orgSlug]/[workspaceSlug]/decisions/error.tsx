"use client"
export default function DecisionsError({ reset }: { error: Error; reset: () => void }) {
  return <main className="p-6"><div className="rounded-xl border p-6"><h1 className="text-lg font-semibold">Decisions could not be loaded</h1><p className="mt-2 text-sm text-muted-foreground">Try again. Your existing decisions are safe.</p><button className="mt-4 rounded-md border px-3 py-2 text-sm" onClick={reset}>Try again</button></div></main>
}
