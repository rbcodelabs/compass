// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let search = "";
let pathname = "/acme/main/okrs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));

import { LegacyRailLinkRedirect } from "@/components/panels/legacy-rail-link-redirect";

beforeEach(() => {
  replace.mockClear();
  pathname = "/acme/main/okrs";
});
afterEach(() => {
  window.location.hash = "";
});

function mount(qs: string) {
  search = qs;
  return render(<LegacyRailLinkRedirect />);
}

describe("LegacyRailLinkRedirect", () => {
  it("replaces a valid rc with detail=conversation:<id>", () => {
    mount("rc=abc-123");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/acme/main/okrs?detail=conversation%3Aabc-123", { scroll: false });
  });

  it("keeps unrelated params and rail=help/ra untouched", () => {
    mount("foo=bar&rail=help&ra=04-roadmap&rc=c1");
    const url = replace.mock.calls[0]![0] as string;
    const next = new URLSearchParams(url.split("?")[1]);
    expect(next.get("foo")).toBe("bar");
    expect(next.get("rail")).toBe("help");
    expect(next.get("ra")).toBe("04-roadmap");
    expect(next.get("detail")).toBe("conversation:c1");
    expect(next.has("rc")).toBe(false);
  });

  it("lets an existing detail win and just drops rc", () => {
    mount("detail=task%3A1&rc=c1");
    expect(replace).toHaveBeenCalledWith("/acme/main/okrs?detail=task%3A1", { scroll: false });
  });

  it("ignores an invalid rc", () => {
    mount("rc=../../etc");
    expect(replace).not.toHaveBeenCalled();
  });

  it("does nothing without rc", () => {
    mount("detail=task%3A1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects a client-side navigation to an rc URL after mount", () => {
    const { rerender } = mount("foo=bar");
    expect(replace).not.toHaveBeenCalled();
    search = "foo=bar&rc=c2";
    rerender(<LegacyRailLinkRedirect />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/acme/main/okrs?foo=bar&detail=conversation%3Ac2", { scroll: false });
  });

  it("preserves the hash", () => {
    window.location.hash = "#section";
    mount("rc=c1");
    expect(replace).toHaveBeenCalledWith("/acme/main/okrs?detail=conversation%3Ac1#section", { scroll: false });
  });

  it("ignores a bare rc=", () => {
    mount("rc=&foo=bar");
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects once: re-render does not loop", () => {
    const { rerender } = mount("rc=c1");
    rerender(<LegacyRailLinkRedirect />);
    search = "detail=conversation%3Ac1";
    rerender(<LegacyRailLinkRedirect />);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
