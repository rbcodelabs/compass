"use client"

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { currentValue, specReducer, type EditableEntity, type EditableField } from "@/lib/spec-canvas/reducer"
import { createSpecAssumption, createSpecExperiment, createSpecSolution, saveSpecField, SpecValidationError, type SpecContext } from "@/lib/spec-canvas/mutations"
import type { SpecAssumption, SpecCanvas, SpecExperiment, SpecSolution } from "@/lib/spec-canvas/shape"

export type SaveState = { pending: number; error: string | null; savedAt: number | null }
export type SaveResult = { ok: true } | { ok: false; error: string }

const failure = (error: unknown, fallback: string): SaveResult => ({
  ok: false,
  error: error instanceof SpecValidationError ? error.message : fallback,
})

/**
 * Owns the canvas's local state. Edits apply optimistically and are persisted
 * through the existing mutation paths (see lib/spec-canvas/mutations.ts); a
 * failed save restores the previous value. Creates add the returned row once the
 * server has it, so counts and the traceability rail stay live without a reload.
 */
export function useSpecEditor(initial: SpecCanvas, ctx: SpecContext) {
  const [spec, dispatch] = useReducer(specReducer, initial)
  const latest = useRef(spec)
  useEffect(() => { latest.current = spec }, [spec])
  const [save, setSave] = useState<SaveState>({ pending: 0, error: null, savedAt: null })

  const track = useCallback(async (work: () => Promise<void>, fallback: string): Promise<SaveResult> => {
    setSave((s) => ({ ...s, pending: s.pending + 1, error: null }))
    try {
      await work()
      setSave((s) => ({ pending: s.pending - 1, error: s.error, savedAt: Date.now() }))
      return { ok: true }
    } catch (error) {
      const result = failure(error, fallback)
      setSave((s) => ({ ...s, pending: s.pending - 1, error: result.ok ? null : result.error }))
      return result
    }
  }, [])

  const saveField = useCallback(
    async (entity: EditableEntity, id: string, field: EditableField, value: string | null): Promise<SaveResult> => {
      const previous = currentValue(latest.current, entity, id, field)
      if (previous === value) return { ok: true }
      dispatch({ type: "patch", entity, id, field, value })
      const result = await track(() => saveSpecField(ctx, entity, id, field, value), "Could not save that change. It was reverted.")
      if (!result.ok && previous !== undefined) dispatch({ type: "patch", entity, id, field, value: previous })
      return result
    },
    [ctx, track],
  )

  const addSolution = useCallback(
    async (title: string): Promise<SaveResult> => {
      let created: SpecSolution | null = null
      const result = await track(async () => { created = await createSpecSolution(ctx, title) }, "Could not add that. Try again.")
      if (result.ok && created) dispatch({ type: "addSolution", solution: created })
      return result
    },
    [ctx, track],
  )

  const addAssumption = useCallback(
    async (solution: { id: string; title: string }, title: string): Promise<SaveResult> => {
      let created: SpecAssumption | null = null
      const result = await track(async () => { created = await createSpecAssumption(ctx, solution, title) }, "Could not add that. Try again.")
      if (result.ok && created) dispatch({ type: "addAssumption", assumption: created })
      return result
    },
    [ctx, track],
  )

  const addExperiment = useCallback(
    async (assumption: { id: string; title: string }, title: string): Promise<SaveResult> => {
      let created: SpecExperiment | null = null
      const result = await track(async () => { created = await createSpecExperiment(ctx, assumption, title) }, "Could not add that. Try again.")
      if (result.ok && created) dispatch({ type: "addExperiment", experiment: created })
      return result
    },
    [ctx, track],
  )

  return { spec, save, saveField, addSolution, addAssumption, addExperiment }
}
