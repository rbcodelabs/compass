import type { Page, Response } from "@playwright/test";

/**
 * Resolves once `count` responses matching `matches` have arrived, registered BEFORE the action that causes them.
 *
 * `[1, 2, 3].map(() => page.waitForResponse(...))` looks like "wait for three saves" but is not: each of those three waiters
 * resolves on the SAME first matching response, so `Promise.all` returns after one. The next step then runs while two saves
 * are still in flight, and a later waiter can be satisfied by a stale response from the step before it.
 */
export function waitForResponses(page: Page, matches: (response: Response) => boolean, count: number): Promise<Response[]> {
  return new Promise((resolve) => {
    const seen: Response[] = [];
    const onResponse = (response: Response) => {
      if (!matches(response)) return;
      seen.push(response);
      if (seen.length < count) return;
      page.off("response", onResponse);
      resolve(seen);
    };
    page.on("response", onResponse);
  });
}
