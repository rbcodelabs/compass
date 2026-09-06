"use client"

import { useFormStatus } from "react-dom"
import { Button } from "@/components/ui/button"

export function ResearchSubmitButton({ children, pendingLabel, variant = "default" }: { children: React.ReactNode; pendingLabel: string; variant?: "default" | "outline" | "ghost" }) {
  const { pending } = useFormStatus()
  return <Button disabled={pending} type="submit" variant={variant}>{pending ? pendingLabel : children}</Button>
}
