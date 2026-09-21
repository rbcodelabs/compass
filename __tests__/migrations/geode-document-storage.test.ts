import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { assertGeodeDocumentStorageMigration } from "@/lib/migrations/geode-document-storage"

const columns = ["docs.storage_provider", "docs.content_ref", "docs.revision", "doc_versions.storage_provider", "doc_versions.content_ref", "doc_operations.id", "doc_operations.workspace_id", "doc_operations.operation_id", "doc_operations.doc_id", "doc_operations.payload_digest", "doc_operations.result", "doc_operations.created_at", "doc_storage_objects.id", "doc_storage_objects.workspace_id", "doc_storage_objects.pathname", "doc_storage_objects.created_at"].map(key => {
  const [table_name, column_name] = key.split(".")
  return { table_name, column_name, is_nullable: "YES", column_default: null }
})
const client = (rows = columns, indexes = [{ valid: true, unique: true }]) => ({ query: vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: indexes }) }) as unknown as PoolClient
describe("Geode migration postconditions", () => {
  it("accepts complete additive columns and valid unique receipt index", async () => {
    await expect(assertGeodeDocumentStorageMigration(client(), "compass_dev")).resolves.toBeUndefined()
  })
  it("refuses a missing column", async () => {
    await expect(assertGeodeDocumentStorageMigration(client(columns.slice(1)), "compass_dev")).rejects.toThrow("docs.storage_provider")
  })
  it("refuses a legacy storage default or non-null constraint", async () => {
    await expect(assertGeodeDocumentStorageMigration(client(columns.map(c => c.table_name === "docs" ? { ...c, is_nullable: "NO" } : c)), "compass_dev")).rejects.toThrow("nullable")
  })
  it("refuses receipt completion until the unique index is valid", async () => {
    await expect(assertGeodeDocumentStorageMigration(client(columns, [{ valid: false, unique: true }]), "compass_dev")).rejects.toThrow("index")
  })
})
