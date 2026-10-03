/**
 * Minimal immutable-snapshot undo/redo stack for the canvas editor. Snapshots
 * are compared by reference; callers push a new object per committed change.
 */
export function createHistory<T>(initial: T, options: { limit?: number } = {}) {
  const limit = options.limit ?? 100
  let states: T[] = [initial]
  let index = 0

  return {
    current: (): T => states[index],
    /** Record a new committed state; drops any redo branch. No-op when unchanged. */
    push(state: T) {
      if (Object.is(states[index], state)) return
      states = [...states.slice(0, index + 1), state]
      if (states.length > limit) states = states.slice(states.length - limit)
      index = states.length - 1
    },
    undo(): T | undefined {
      if (index === 0) return undefined
      index -= 1
      return states[index]
    },
    redo(): T | undefined {
      if (index >= states.length - 1) return undefined
      index += 1
      return states[index]
    },
    canUndo: () => index > 0,
    canRedo: () => index < states.length - 1,
  }
}
