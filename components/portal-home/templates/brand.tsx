import { cn } from "@/lib/utils"

/** The workspace mark: its logo when it has one, otherwise the Compass glyph on the brand colour. */
export function BrandMark({ name, logoUrl, className }: { name: string; logoUrl?: string | null; className?: string }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- workspace-supplied logo URL, arbitrary host
    return <img src={logoUrl} alt="" className={cn("size-8 shrink-0 rounded-lg object-contain", className)} />
  }
  return (
    <span aria-hidden="true" title={name} className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm", className)}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    </span>
  )
}

export function PortalFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-border-default px-6 py-4 text-center", className)}>
      <p className="text-xs text-text-subtle">Powered by Compass</p>
    </footer>
  )
}
