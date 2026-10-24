import { expect, it, vi } from "vitest";
import { createDocumentSaveQueue } from "@/lib/document-save-queue";
it("serializes concurrent edits and sends the returned revision with the next edit", async () => {
  let finish!: (value: { revision: string }) => void;
  const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ revision: "r3" });
  const queue = createDocumentSaveQueue({ revision: "r1", execute, onState: vi.fn(), operationId: () => "op" });
  const first = queue.enqueue({ content: "one" });
  const second = queue.enqueue({ title: "two" });
  expect(execute).toHaveBeenCalledTimes(1);
  finish({ revision: "r2" });
  await Promise.all([first, second]);
  expect(execute.mock.calls[1]).toEqual([{ title: "two" }, { operationId: "op", expectedRevision: "r2" }]);
});
it("retains a failed operation and reuses its exact token before saving later edits", async () => {
  const execute = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ revision: "r2" }).mockResolvedValueOnce({ revision: "r3" });
  const onState = vi.fn(); let n = 0;
  const queue = createDocumentSaveQueue({ revision: "r1", execute, onState, operationId: () => `op${++n}` });
  await expect(queue.enqueue({ content: "draft" })).rejects.toThrow("offline");
  const later = queue.enqueue({ content: "new draft" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(queue.pending()).toBe(true);
  await queue.retry(); await later;
  expect(execute.mock.calls[1]).toEqual(execute.mock.calls[0]);
  expect(execute.mock.calls[2][1]).toEqual({ expectedRevision: "r2", operationId: "op2" });
  expect(onState).toHaveBeenCalledWith("error", expect.any(Error));
  expect(queue.pending()).toBe(false);
});

const conflict = () => Object.assign(new Error("revision-conflict"), { code: "revision-conflict" });
it("setRevision makes the next save expect the adopted revision and records it as seen", async () => {
  const execute = vi.fn().mockResolvedValue({ revision: "r3" });
  const queue = createDocumentSaveQueue({ revision: "r1", execute, onState: vi.fn(), operationId: () => "op" });
  expect(queue.hasSeen("r2")).toBe(false);
  queue.setRevision("r2");
  expect(queue.revision()).toBe("r2");
  expect(queue.hasSeen("r1")).toBe(true);
  expect(queue.hasSeen("r2")).toBe(true);
  await queue.enqueue({ content: "mine" });
  expect(execute.mock.calls[0][1]).toEqual({ expectedRevision: "r2", operationId: "op" });
  expect(queue.hasSeen("r3")).toBe(true);
});
it("rebase unsticks a revision-conflict retry: the parked save is re-sent against the new revision with a fresh token", async () => {
  const execute = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ revision: "r3" });
  const onState = vi.fn(); let n = 0;
  const queue = createDocumentSaveQueue({ revision: "r1", execute, onState, operationId: () => `op${++n}` });
  await expect(queue.enqueue({ content: "draft" })).rejects.toThrow("revision-conflict");
  expect(queue.pending()).toBe(true);
  // Without rebase, retry() would replay { expectedRevision: "r1", operationId: "op1" } forever.
  await queue.rebase("r2");
  expect(execute.mock.calls[1]).toEqual([{ content: "draft" }, { expectedRevision: "r2", operationId: "op2" }]);
  expect(queue.pending()).toBe(false);
  expect(queue.revision()).toBe("r3");
  expect(onState).toHaveBeenLastCalledWith("saved");
});
it("discard drops the parked draft and expects the new revision for later saves", async () => {
  const execute = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ revision: "r4" });
  const queue = createDocumentSaveQueue({ revision: "r1", execute, onState: vi.fn(), operationId: () => "op" });
  await expect(queue.enqueue({ content: "draft" })).rejects.toThrow();
  const queuedBehind = queue.enqueue({ title: "later" });
  queue.discard("r2");
  await queuedBehind; // resolved, not rejected
  expect(queue.pending()).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  await queue.enqueue({ content: "fresh" });
  expect(execute.mock.calls[1]).toEqual([{ content: "fresh" }, { expectedRevision: "r2", operationId: "op" }]);
});
