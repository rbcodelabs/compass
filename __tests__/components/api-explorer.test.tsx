// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiExplorer } from "@/components/api-explorer/api-explorer";

const document = {
  openapi: "3.1.0",
  info: { version: "1.0.0" },
  paths: {
    "/api/v1/me": {
      get: {
        operationId: "getMe",
        summary: "Your identity",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/tasks": {
      post: {
        operationId: "createTask",
        summary: "Create a task",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          },
        },
        responses: {},
      },
    },
  },
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/help/api-explorer");
  localStorage.clear();
  sessionStorage.clear();
});
async function setup(second = jsonResponse({ id: "synthetic" })) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(document))
    .mockResolvedValue(second);
  vi.stubGlobal("fetch", fetcher);
  render(<ApiExplorer />);
  await screen.findByRole("heading", { name: "Your identity" });
  return fetcher;
}
describe("custom API explorer", () => {
  it("loads the public contract with deployment cookies but keeps API reads cookie-free", async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (url === "/api/v1/openapi.json") {
        if (options.credentials !== "same-origin")
          throw new TypeError("Deployment protection redirect");
        expect(options.redirect).toBe("error");
        expect(options.headers).toBeUndefined();
        return jsonResponse(document);
      }
      expect(options.credentials).toBe("omit");
      expect(options.redirect).toBe("error");
      throw new TypeError("Deployment protection redirect");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ApiExplorer />);
    await screen.findByRole("heading", { name: "Your identity" });
    fireEvent.change(screen.getByLabelText("API key or OAuth bearer token"), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
    await screen.findByText(/Request failed\. Check connectivity/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(/Deployment protection redirect/),
    ).not.toBeInTheDocument();
  });
  it.each(["token", "parameter", "pagehide"])(
    "suppresses pending response after %s changes",
    async (change) => {
      let resolve!: (response: Response) => void;
      const value = {
        ...document,
        paths: {
          "/api/v1/me": {
            get: {
              ...document.paths["/api/v1/me"].get,
              parameters: [
                { in: "query", name: "limit", schema: { type: "integer" } },
              ],
            },
          },
        },
      };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(value))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((done) => {
              resolve = done;
            }),
        );
      vi.stubGlobal("fetch", fetcher);
      render(<ApiExplorer />);
      await screen.findByRole("heading", { name: "Your identity" });
      const token = screen.getByLabelText("API key or OAuth bearer token");
      fireEvent.change(token, { target: { value: "synthetic" } });
      fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
      const signal = fetcher.mock.calls[1][1].signal;
      fireEvent.click(screen.getByRole("tab", { name: "Request" }));
      if (change === "token")
        fireEvent.change(
          screen.getByLabelText("API key or OAuth bearer token"),
          { target: { value: "replacement" } },
        );
      else if (change === "parameter")
        fireEvent.change(screen.getByLabelText(/limit/), {
          target: { value: "2" },
        });
      else fireEvent(window, new Event("pagehide"));
      expect(signal.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolve(jsonResponse({ result: "stale-sentinel" }));
      });
      expect(screen.queryByText(/stale-sentinel/)).not.toBeInTheDocument();
      if (change === "pagehide") {
        expect(
          screen.getByLabelText("API key or OAuth bearer token"),
        ).toHaveValue("");
        expect(screen.getByLabelText(/limit/)).toHaveValue("");
      }
    },
  );
  it("prevents duplicate sends and suppresses an old response after switching operations", async () => {
    let oldResponse!: (response: Response) => void;
    const value = {
      ...document,
      paths: {
        ...document.paths,
        "/api/v1/workspaces": {
          get: {
            operationId: "listWorkspaces",
            summary: "List workspaces",
            responses: {},
          },
        },
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            oldResponse = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: "new-response" }));
    vi.stubGlobal("fetch", fetcher);
    render(<ApiExplorer />);
    await screen.findByRole("heading", { name: "Your identity" });
    fireEvent.change(screen.getByLabelText("API key or OAuth bearer token"), {
      target: { value: "synthetic" },
    });
    const send = screen.getByRole("button", { name: "Send GET request" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "GET List workspaces" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
    await screen.findByText(/new-response/);
    await act(async () => {
      oldResponse(jsonResponse({ result: "old-response" }));
    });
    expect(screen.queryByText(/old-response/)).not.toBeInTheDocument();
    expect(screen.getByText(/new-response/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("resolves response-level local refs in schema documentation", async () => {
    const value = {
      ...document,
      components: {
        responses: {
          Success: {
            description: "Resolved response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { resolvedField: { type: "string" } },
                },
              },
            },
          },
        },
      },
      paths: {
        "/api/v1/me": {
          get: {
            operationId: "getMe",
            summary: "Your identity",
            responses: { "200": { $ref: "#/components/responses/Success" } },
          },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(value)));
    render(<ApiExplorer />);
    await screen.findByRole("heading", { name: "Your identity" });
    fireEvent.click(screen.getByRole("tab", { name: "Schema" }));
    expect(screen.getByText("resolvedField")).toBeInTheDocument();
  });
  it("loads its contract once and does not request API data while browsing", async () => {
    const fetcher = await setup();
    fireEvent.change(screen.getByLabelText("Find an operation"), {
      target: { value: "POST" },
    });
    fireEvent.click(screen.getByRole("button", { name: /POST Create a task/ }));
    expect(
      screen.queryByRole("button", { name: "Send GET request" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Execution is disabled/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends only explicitly and clears credentials/results on reset", async () => {
    const fetcher = await setup();
    const token = screen.getByLabelText("API key or OAuth bearer token");
    fireEvent.change(token, {
      target: { value: "synthetic-private-sentinel" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
    await screen.findByText(/200 ·/);
    expect(screen.getByText(/"synthetic"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Examples" }));
    for (const example of screen.getAllByText(/Bearer <token>/, {
      selector: "pre",
    }))
      expect(example).not.toHaveTextContent("synthetic-private-sentinel");
    expect(window.location.href).not.toContain("sentinel");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Reset session" }));
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    expect(screen.getByLabelText("API key or OAuth bearer token")).toHaveValue(
      "",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByText("No request sent.")).toBeInTheDocument();
  });
  it("renders HTML-looking responses as text only", async () => {
    await setup(
      new Response('<img src=x onerror="window.hacked=true">', {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
    );
    fireEvent.change(screen.getByLabelText("API key or OAuth bearer token"), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
    await screen.findByText(/401 ·/);
    expect(screen.getByText(/onerror/).tagName).toBe("PRE");
    expect(documentNodeImages()).toBe(0);
  });
  it("does not restore a credential after teardown and remount", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("API key or OAuth bearer token"), {
      target: { value: "synthetic" },
    });
    cleanup();
    await setup();
    expect(screen.getByLabelText("API key or OAuth bearer token")).toHaveValue(
      "",
    );
  });
  it("suppresses a late response after reset", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(document))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<ApiExplorer />);
    await screen.findByRole("heading", { name: "Your identity" });
    fireEvent.change(screen.getByLabelText("API key or OAuth bearer token"), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send GET request" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset session" }));
    await act(async () => {
      resolve(jsonResponse({ private: "late-result" }));
    });
    expect(screen.queryByText(/late-result/)).not.toBeInTheDocument();
  });
  it("reports invalid operation links without sending data requests", async () => {
    window.history.replaceState({}, "", "/help/api-explorer#operation=unknown");
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(document));
    vi.stubGlobal("fetch", fetcher);
    render(<ApiExplorer />);
    await screen.findByText(/linked operation is not/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("shows contract load failure with a retry", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(jsonResponse(document));
    vi.stubGlobal("fetch", fetcher);
    render(<ApiExplorer />);
    await screen.findByText(/Unable to load/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Your identity" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
const documentNodeImages = () =>
  globalThis.document.querySelectorAll("img").length;
