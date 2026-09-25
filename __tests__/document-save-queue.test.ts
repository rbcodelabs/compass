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
