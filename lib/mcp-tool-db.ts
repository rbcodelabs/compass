import { AsyncLocalStorage } from "node:async_hooks"
import getPrisma, { type AppTransactionClient } from "@/lib/db"

const store = new AsyncLocalStorage<{ tx: AppTransactionClient; expectedWhere: Record<string, string | Date | null> }>()
export const getToolPrisma = (): AppTransactionClient => store.getStore()?.tx ?? getPrisma()
export const getToolExpectedWhere = () => store.getStore()?.expectedWhere ?? {}
export const withToolTransaction = <T>(tx: AppTransactionClient, fn: () => T, expectedWhere: Record<string, string | Date | null> = {}) => store.run({ tx, expectedWhere }, fn)
