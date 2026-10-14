import { describe, it, expect, vi, afterEach } from "vitest";
import {
  indexOperations,
  searchOperations,
  resolveSchema,
  schemaSummary,
  examples,
  buildReadUrl,
  runRead,
  MAX_RESPONSE_BYTES,
} from "@/lib/rest-explorer";
import { buildOpenApiDocument } from "@/lib/rest/openapi";
import { safeBrowserPageUrl } from "@/lib/analytics/activity-policy";

const origin = "https://compass.example.test";
const document = {
  openapi: "3.1.0",
  paths: {
    "/api/v1/workspaces/{workspaceId}/tasks": {
      get: {
        operationId: "listTasks",
        summary: "List tasks",
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Task" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createTask",
        summary: "Create task",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {},
      },
    },
    "/api/v1/me": {
      get: { operationId: "getMe", summary: "Your identity", responses: {} },
    },
  },
  components: {
    schemas: {
      Task: {
        type: "object",
        properties: {
          title: { type: "string" },
          parent: { $ref: "#/components/schemas/Task" },
        },
      },
    },
  },
};
const catalog = () => indexOperations(document);
const task = () => catalog().find((op) => op.id === "listTasks")!;

afterEach(() => vi.useRealTimers());
describe("explorer contract catalog", () => {
  it("keeps the public explorer out of browser page analytics", () => {
    expect(
      safeBrowserPageUrl(
        origin + "/help/api-explorer#operation=listTasks",
        "",
        null,
        false,
      ),
    ).toBeNull();
  });
  it("matches the real generated operation inventory dynamically", () => {
    const live = buildOpenApiDocument();
    const ids = Object.values(live.paths)
      .flatMap((path) => Object.values(path).map((op) => op.operationId))
      .sort();
    expect(
      indexOperations(live)
        .map((op) => op.id)
        .sort(),
    ).toEqual(ids);
  });
  it("supports escaped local JSON pointers and recursive references", () => {
    const value = {
      components: {
        schemas: {
          "a/b~c": { type: "string" },
          Recursive: { $ref: "#/components/schemas/Recursive" },
        },
      },
    };
    expect(
      resolveSchema({ $ref: "#/components/schemas/a~1b~0c" }, value),
    ).toEqual({ type: "string" });
    expect(
      resolveSchema({ $ref: "#/components/schemas/Recursive" }, value),
    ).toEqual({ $ref: "#/components/schemas/Recursive" });
  });
  it("indexes every documented method deterministically without depending on the server registry", () => {
    expect(catalog().map((op) => op.id)).toEqual([
      "getMe",
      "listTasks",
      "createTask",
    ]);
    expect(task().group).toBe("Tasks");
  });
  it("searches method, resource, path, summary and operation ID with multiple terms", () => {
    expect(searchOperations(catalog(), "get tasks").map((op) => op.id)).toEqual(
      ["listTasks"],
    );
    expect(
      searchOperations(catalog(), "createTask").map((op) => op.id),
    ).toEqual(["createTask"]);
    expect(searchOperations(catalog(), "not present")).toEqual([]);
  });
  it("groups nested subresources under their parent resource", () => {
    const value = {
      ...document,
      paths: {
        "/api/v1/workspaces/{workspaceId}/tasks/{taskId}/links": {
          get: { operationId: "listTaskLinks" },
        },
      },
    };
    expect(indexOperations(value)[0].group).toBe("Tasks");
  });
  it("rejects malformed contracts and duplicate operation IDs", () => {
    expect(() => indexOperations({ paths: {} })).toThrow(/OpenAPI/);
    expect(() =>
      indexOperations({
        ...document,
        paths: {
          "/api/v1/a": { get: { operationId: "same" } },
          "/api/v1/b": { get: { operationId: "same" } },
        },
      }),
    ).toThrow(/duplicate/i);
  });
  it("resolves local refs without fetching external references", () => {
    expect(
      resolveSchema({ $ref: "#/components/schemas/Task" }, document),
    ).toMatchObject({ type: "object" });
    expect(
      resolveSchema({ $ref: "https://evil.example/schema" }, document),
    ).toEqual({ $ref: "https://evil.example/schema" });
  });
  it("summarizes unions, nullable, enum and constraints", () => {
    expect(
      schemaSummary({
        type: ["string", "null"],
        enum: ["PENDING", null],
        minLength: 1,
      }),
    ).toContain("string | null");
    expect(
      schemaSummary({ anyOf: [{ type: "string" }, { type: "integer" }] }),
    ).toContain("string | integer");
    expect(
      schemaSummary({ type: "integer", minimum: 1, maximum: 100 }),
    ).toContain("1");
  });
  it("creates shell-safe examples from synthetic values only", () => {
    const result = examples(task(), document, origin);
    expect(result.curl).toContain("<token>");
    expect(result.javascript).toContain("<token>");
    expect(result.curl).toContain("00000000-0000-4000-8000-000000000001");
    expect(result.javascript).toContain('credentials: "omit"');
    expect(result.curl).not.toContain("\n+");
  });
  it("includes a synthetic request body for write examples without supplied examples", () => {
    const value = {
      ...document,
      paths: {
        "/api/v1/tasks": {
          post: {
            operationId: "createTask",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title"],
                    properties: {
                      title: { type: "string", example: "private" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const sample = examples(indexOperations(value)[0], value, origin);
    expect(sample.curl).toContain("--data");
    expect(sample.javascript).toContain("body:");
    expect(sample.javascript).toContain('"Content-Type": "application/json"');
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    expect(() => new AsyncFunction(sample.javascript)).not.toThrow();
    expect(sample.javascript).not.toContain("private");
  });
  it("uses schema-valid enum const and format values without private defaults", () => {
    const properties = {
      horizon: { type: "string", enum: ["NOW", "NEXT", "LATER", "SHIPPED"] },
      flag: { type: "boolean", const: false },
      count: { type: "integer", enum: [0, 2] },
      date: { type: "string", format: "date", default: "private" },
      time: { type: "string", format: "date-time", example: "private" },
      email: { type: "string", format: "email" },
      uri: { type: "string", format: "uri" },
    };
    const value = {
      ...document,
      paths: {
        "/api/v1/roadmap": {
          post: {
            operationId: "roadmapCreate",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: Object.keys(properties),
                    properties,
                  },
                },
              },
            },
          },
        },
      },
    };
    const sample = examples(indexOperations(value)[0], value, origin);
    expect(sample.curl).toContain('"horizon":"NOW"');
    expect(sample.curl).toContain('"flag":false');
    expect(sample.curl).toContain('"count":0');
    expect(sample.curl).toContain('"date":"2000-01-01"');
    expect(sample.curl).toContain('"time":"2000-01-01T00:00:00Z"');
    expect(sample.curl).toContain('"email":"developer@example.test"');
    expect(sample.curl).toContain('"uri":"https://example.test/"');
    expect(sample.curl).not.toContain("private");
  });
});
describe("explorer request boundary", () => {
  it.each(["post", "patch", "delete", "head", "put", "options"])(
    "rejects documented %s before fetch",
    async (method) => {
      const fetcher = vi.fn();
      const value = {
        ...document,
        paths: {
          "/api/v1/me": { [method]: { operationId: "other", responses: {} } },
        },
      };
      await expect(
        runRead({
          document: value,
          operationId: "other",
          origin,
          values: {},
          token: "synthetic",
          fetcher,
        }),
      ).rejects.toThrow(/GET/);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["/api/v10/me", "/api/v1/\\evil", "/api/v1/me#fragment"])(
    "rejects boundary-confusing path %s",
    (path) => {
      expect(() =>
        buildReadUrl(
          {
            ...document,
            paths: { [path]: { get: { operationId: "unsafe" } } },
          },
          "unsafe",
          origin,
          {},
        ),
      ).toThrow(/target/);
    },
  );
  it("retains false and zero query values, omits optional empty values and ignores spec servers", () => {
    const value = {
      ...document,
      servers: [{ url: "https://evil.example" }],
      paths: {
        "/api/v1/me": {
          get: {
            operationId: "getMe",
            parameters: [
              { name: "enabled", in: "query", schema: { type: "boolean" } },
              { name: "offset", in: "query", schema: { type: "integer" } },
              { name: "empty", in: "query", schema: { type: "string" } },
            ],
          },
        },
      },
    };
    const url = buildReadUrl(value, "getMe", origin, {
      "query:enabled": "false",
      "query:offset": "0",
      "query:empty": "",
    });
    expect(url.origin).toBe(origin);
    expect(url.search).toBe("?enabled=false&offset=0");
  });
  it("cancels after headers even when the response has no body", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await expect(
      runRead({
        document,
        operationId: "getMe",
        origin,
        values: {},
        token: "synthetic",
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/i);
  });
  it("includes stalled body reading in the 30 second deadline", async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(stream));
    let settled = false;
    const promise = runRead({
      document,
      operationId: "getMe",
      origin,
      values: {},
      token: "synthetic",
      fetcher,
    }).catch((error) => {
      settled = true;
      return error.message;
    });
    await vi.advanceTimersByTimeAsync(30_001);
    try {
      expect(settled).toBe(true);
    } finally {
      if (!settled) streamController.close();
    }
    expect(await promise).toMatch(/30 seconds/);
  });
  it("preserves boolean JSON schema semantics", () => {
    expect(schemaSummary(false)).toBe("never (no values allowed)");
    expect(schemaSummary(true)).toBe("any");
  });
  it("encodes path and query independently", () => {
    const url = buildReadUrl(document, task().id, origin, {
      "path:workspaceId": "a/b?c",
      "query:cursor": "x+y/z=",
      "query:limit": "2",
    });
    expect(url.pathname).toContain("a%2Fb%3Fc");
    expect(url.searchParams.get("cursor")).toBe("x+y/z=");
  });
  it("rejects missing required parameters, writes and undocumented IDs", () => {
    expect(() => buildReadUrl(document, "listTasks", origin, {})).toThrow(
      /workspaceId/,
    );
    expect(() => buildReadUrl(document, "createTask", origin, {})).toThrow(
      /GET/,
    );
    expect(() => buildReadUrl(document, "invented", origin, {})).toThrow(
      /documented/,
    );
  });
  it.each([
    "https://evil.example/api/v1/me",
    "//evil.example/api/v1/me",
    "/api/v1/../admin",
    "/api/v1/me?redirect=https://evil.example",
    "/api/v1/%2e%2e/admin",
  ])("rejects an unsafe documented target %s", (path) => {
    const unsafe = {
      ...document,
      paths: { [path]: { get: { operationId: "unsafe" } } },
    };
    expect(() => buildReadUrl(unsafe, "unsafe", origin, {})).toThrow(/target/);
  });
  it.each([".", "..", "%2e%2e"])("rejects traversal parameter %s", (value) => {
    expect(() =>
      buildReadUrl(document, "listTasks", origin, {
        "path:workspaceId": value,
      }),
    ).toThrow(/parameter/);
  });
  it("sends bearer only to a documented current-origin GET with no cookies/cache/redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('{"id":"synthetic"}', {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await runRead({
      document,
      operationId: "getMe",
      origin,
      values: {},
      token: "synthetic-token",
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(
      origin + "/api/v1/me",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          Authorization: "Bearer synthetic-token",
          Accept: "application/json",
        },
      }),
    );
    expect(result).toMatchObject({
      status: 200,
      body: '{\n  "id": "synthetic"\n}',
      truncated: false,
    });
  });
  it("retains application errors as safe text and rejects redirects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("<script>evil()</script>", { status: 401 }),
      );
    expect(
      (
        await runRead({
          document,
          operationId: "getMe",
          origin,
          values: {},
          token: "x",
          fetcher,
        })
      ).body,
    ).toContain("<script>");
    fetcher.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example" },
      }),
    );
    await expect(
      runRead({
        document,
        operationId: "getMe",
        origin,
        values: {},
        token: "x",
        fetcher,
      }),
    ).rejects.toThrow(/redirect/i);
  });
  it("bounds streamed response bytes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("a".repeat(MAX_RESPONSE_BYTES + 100)));
    const result = await runRead({
      document,
      operationId: "getMe",
      origin,
      values: {},
      token: "x",
      fetcher,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
  it("cancels a request without exposing the token in an error", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      runRead({
        document,
        operationId: "getMe",
        origin,
        values: {},
        token: "secret-value",
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("times out at 30 seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    const promise = runRead({
      document,
      operationId: "getMe",
      origin,
      values: {},
      token: "secret-value",
      fetcher,
    });
    const rejected = expect(promise).rejects.toThrow(/30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });
});
