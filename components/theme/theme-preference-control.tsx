"use client"

import { Laptop, Moon, Sun } from "lucide-react"

import { cn } from "@/lib/utils"
import { themePreferences, type ThemePreference } from "@/lib/theme"
import { useTheme } from "@/components/theme/theme-provider"

const labels: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
}

const icons = { light: Sun, dark: Moon, system: Laptop }

export function ThemePreferenceControl() {
  const { preference, setPreference } = useTheme()

  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Color theme">
      {themePreferences.map((option) => {
        const Icon = icons[option]
        const selected = preference === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => setPreference(option)}
            className={cn(
              "flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
              selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-border-default bg-surface-panel text-text-secondary hover:bg-surface-interactive hover:text-text-primary"
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{labels[option]}</span>
          </button>
        )
      })}
    </div>
  )
}
