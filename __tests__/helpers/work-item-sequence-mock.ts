/**
 * Test double for lib/work-item-sequence.ts, for suites that exercise a create path with a hand-rolled
 * Prisma fake that has no `workspaceSequence` delegate. The allocator itself is covered by
 * __tests__/work-item-sequence.test.ts and the bypass guard by __tests__/work-item-ids-guard.test.ts.
 *
 * Use it with:
 *   vi.mock("@/lib/work-item-sequence", async () => (await import("<relative>/helpers/work-item-sequence-mock")).workItemSequenceMock())
 *
 * `withSequenceTransaction` goes through `prisma.$transaction` when the fake has one (so "uses one
 * transaction" assertions still hold) and otherwise runs the callback on the fake itself. Numbers count up per
 * (workspace, type) so tests can assert them.
 */
export function workItemSequenceMock() {
  const counters = new Map<string, number>()
  const next = (workspaceId: string, type: string, count: number) => {
    const key = `${workspaceId}:${type}`
    const first = (counters.get(key) ?? 0) + 1
    counters.set(key, first + count - 1)
    return first
  }
  const prefixes: Record<string, string> = {
    objective: "OBJ", keyResult: "KR", opportunity: "OPP", solution: "SOL", assumption: "ASM", experiment: "EXP", task: "TASK",
    roadmapItem: "RM", feedback: "FB", reviewRequest: "DEC", doc: "DOC", artifact: "ART", researchStudy: "STUDY", metric: "MET",
  }
  const allocateSeq = async (_tx: unknown, workspaceId: string, type: string, count = 1) => {
    if (!workspaceId) throw new Error("allocateSeq requires a workspaceId")
    const first = next(workspaceId, type, count)
    return { seqPrefix: prefixes[type], seqNumbers: Array.from({ length: count }, (_, index) => first + index) }
  }
  return {
    allocateSeq,
    allocateOneSeq: async (tx: unknown, workspaceId: string, type: string) => {
      const { seqPrefix, seqNumbers } = await allocateSeq(tx, workspaceId, type, 1)
      return { seqPrefix, seqNumber: seqNumbers[0] }
    },
    withSeq: <T extends object>(range: { seqPrefix: string; seqNumbers: number[] }, rows: readonly T[]) =>
      rows.map((row, index) => ({ ...row, seqPrefix: range.seqPrefix, seqNumber: range.seqNumbers[index] })),
    withSequenceTransaction: async <T>(prisma: unknown, callback: (tx: unknown) => Promise<T>) => {
      const client = prisma as { $transaction?: (work: (tx: unknown) => Promise<T>) => Promise<T> }
      return typeof client.$transaction === "function" ? client.$transaction(callback) : callback(prisma)
    },
  }
}
