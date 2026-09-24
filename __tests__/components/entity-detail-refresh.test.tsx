// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEntityDetail } from "@/components/panels/panel-parts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function pendingResponse() {
  let resolve!: (response: { ok: boolean; json: () => Promise<{ data: { title: string } }> }) => void;
  const promise = new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; });
  return { promise, finish: (title: string, ok = true) => resolve({ ok, json: async () => ({ data: { title } }) }) };
}

it("does not let an older load overwrite a successful inline edit", async () => {
  const load = pendingResponse();
  vi.stubGlobal("fetch", vi.fn(() => load.promise));
  const { result } = renderHook(() => useEntityDetail<{ title: string }>("opportunity", "opp", "org", "ws"));
  act(() => result.current.mutate({ title: "Saved edit" }));
  await act(async () => { load.finish("Before edit"); await load.promise; });
  expect(result.current.data?.title).toBe("Saved edit");
  act(() => result.current.mutate((current) => ({ title: `${current?.title}!` })));
  expect(result.current.data?.title).toBe("Saved edit!");
});

it("keeps the newest refresh when responses complete in reverse order", async () => {
  const first = pendingResponse();
  const second = pendingResponse();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const { result } = renderHook(() => useEntityDetail<{ title: string }>("opportunity", "opp", "org", "ws"));
  let refreshed!: Promise<void>;
  act(() => { refreshed = result.current.refresh(); });
  await act(async () => { second.finish("Newest"); await refreshed; });
  await act(async () => { first.finish("Oldest"); await first.promise; });
  expect(result.current.data?.title).toBe("Newest");
});

it("ignores an old entity load failure after navigation", async () => {
  const first = pendingResponse();
  const second = pendingResponse();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const { result, rerender } = renderHook(({ id }) => useEntityDetail<{ title: string }>("opportunity", id, "org", "ws"), { initialProps: { id: "first" } });
  rerender({ id: "second" });
  await act(async () => { second.finish("Second entity"); await second.promise; });
  await act(async () => { first.finish("Old error", false); await first.promise; });
  expect(result.current.data?.title).toBe("Second entity");
  expect(result.current.error).toBe(false);
});

it("keeps loaded opportunity content on refresh failure and clears the error on retry", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: { title: "Current" } }) })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { title: "Updated" } }) });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useEntityDetail<{ title: string }>("opportunity", "opp", "org", "ws"));
  await waitFor(() => expect(result.current.data?.title).toBe("Current"));
  await act(() => result.current.refresh());
  expect(result.current.data?.title).toBe("Current");
  expect(result.current.error).toBe(true);
  await act(() => result.current.refresh());
  expect(result.current.data?.title).toBe("Updated");
  expect(result.current.error).toBe(false);
});
