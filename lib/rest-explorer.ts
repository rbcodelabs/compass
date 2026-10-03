/** Browser-safe OpenAPI utilities: never import the server route registry here. */
export type JsonObject = Record<string, unknown>;
export type ExplorerParameter = {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JsonObject;
  description: string;
};
export type ExplorerOperation = {
  id: string;
  method: string;
  path: string;
  group: string;
  summary: string;
  description: string;
  parameters: ExplorerParameter[];
  definition: JsonObject;
};
export type ReadResult = {
  status: number;
  duration: number;
  contentType: string;
  body: string;
  truncated: boolean;
};
export const MAX_RESPONSE_BYTES = 131072;
const methods = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];
export const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const asString = (value: unknown) => (typeof value === "string" ? value : "");

export function resolveSchema(
  value: unknown,
  document: unknown,
  seen = new Set<string>(),
): JsonObject {
  const schema = asObject(value),
    ref = asString(schema.$ref);
  if (!ref.startsWith("#/") || seen.has(ref)) return schema;
  let target: unknown = document;
  for (const part of ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    const object = asObject(target);
    if (!Object.hasOwn(object, part)) return schema;
    target = object[part];
  }
  return {
    ...resolveSchema(target, document, new Set([...seen, ref])),
    ...Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "$ref"),
    ),
  };
}

export function indexOperations(value: unknown): ExplorerOperation[] {
  const document = asObject(value);
  if (
    !asString(document.openapi).startsWith("3.") ||
    !document.paths ||
    Array.isArray(document.paths)
  )
    throw new Error("Expected an OpenAPI 3 document");
  const operations: ExplorerOperation[] = [],
    ids = new Set<string>();
  for (const [path, rawPath] of Object.entries(asObject(document.paths)).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const pathItem = resolveSchema(rawPath, document);
    for (const method of methods) {
      if (!pathItem[method]) continue;
      const definition = asObject(pathItem[method]),
        id = asString(definition.operationId);
      if (!id) throw new Error("Documented operation is missing operationId");
      if (ids.has(id)) throw new Error("Duplicate operationId in OpenAPI");
      ids.add(id);
      const resource =
        path
          .split("/")
          .find(
            (part) =>
              part &&
              !part.startsWith("{") &&
              !["api", "v1", "workspaces"].includes(part),
          ) ?? "workspaces";
      const parameters = new Map<string, ExplorerParameter>();
      for (const raw of [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(definition.parameters) ? definition.parameters : []),
      ]) {
        const param = resolveSchema(raw, document);
        if (
          (param.in !== "path" && param.in !== "query") ||
          typeof param.name !== "string"
        )
          continue;
        parameters.set(`${param.in}:${param.name}`, {
          name: param.name,
          in: param.in,
          required: param.in === "path" || param.required === true,
          schema: resolveSchema(param.schema, document),
          description: asString(param.description),
        });
      }
      operations.push({
        id,
        method: method.toUpperCase(),
        path,
        group: resource.replace(
          /(^|-)([a-z])/g,
          (_, dash, letter) => (dash ? " " : "") + letter.toUpperCase(),
        ),
        summary: asString(definition.summary) || id,
        description: asString(definition.description),
        parameters: [...parameters.values()],
        definition,
      });
    }
  }
  return operations;
}

export function searchOperations(
  operations: ExplorerOperation[],
  query: string,
): ExplorerOperation[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return operations.filter((op) =>
    terms.every((term) =>
      `${op.method} ${op.path} ${op.id} ${op.summary} ${op.group}`
        .toLowerCase()
        .includes(term),
    ),
  );
}

export function schemaSummary(value: unknown, depth = 0): string {
  if (value === false) return "never (no values allowed)";
  if (value === true) return "any";
  const schema = asObject(value);
  if (depth > 8) return "recursive schema";
  const union = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  let type = Array.isArray(union)
    ? union
        .map((member) => schemaSummary(member, depth + 1))
        .join(schema.allOf ? " & " : " | ")
    : Array.isArray(schema.type)
      ? schema.type.join(" | ")
      : asString(schema.type) ||
        (schema.$ref ? asString(schema.$ref).split("/").at(-1) : "any");
  if (schema.nullable === true) type += " | null";
  if (schema.format) type += ` · ${schema.format}`;
  if (schema.enum) type += ` · enum ${JSON.stringify(schema.enum)}`;
  if (schema.const !== undefined)
    type += ` · constant ${JSON.stringify(schema.const)}`;
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
  ])
    if (schema[key] !== undefined) type += ` · ${key} ${String(schema[key])}`;
  return type ?? "any";
}

function syntheticValue(schema: JsonObject): string {
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (schema.type === "boolean") return "false";
  if (schema.type === "integer" || schema.type === "number")
    return String(typeof schema.minimum === "number" ? schema.minimum : 1);
  return "example";
}

function syntheticBody(value: unknown, document: unknown, depth = 0): unknown {
  if (depth > 5 || value === false) return null;
  const schema = resolveSchema(value, document);
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union))
    return syntheticBody(
      union.find((member) => asObject(member).type !== "null") ?? union[0],
      document,
      depth + 1,
    );
  if (schema.type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(asObject(schema.properties))
        .filter(
          ([key]) =>
            Array.isArray(schema.required) && schema.required.includes(key),
        )
        .map(([key, child]) => [
          key,
          syntheticBody(child, document, depth + 1),
        ]),
    );
  if (schema.type === "array")
    return [syntheticBody(schema.items, document, depth + 1)];
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  if (schema.type === "number" || schema.type === "integer")
    return Number(syntheticValue(schema));
  return syntheticValue(schema);
}

export function examples(
  operation: ExplorerOperation,
  document: unknown,
  origin: string,
): { curl: string; javascript: string } {
  let path = operation.path;
  for (const param of operation.parameters.filter(
    (param) => param.in === "path",
  ))
    path = path.replace(
      `{${param.name}}`,
      encodeURIComponent(syntheticValue(param.schema)),
    );
  // Only generated values: form values and credentials never enter examples.
  const url = new URL(path, origin);
  for (const param of operation.parameters.filter(
    (param) => param.in === "query" && param.required,
  ))
    url.searchParams.set(param.name, syntheticValue(param.schema));
  const safeUrl = url.toString().replace(/'/g, "'\\''");
  const requestBody = resolveSchema(operation.definition.requestBody, document);
  const media = asObject(asObject(requestBody.content)["application/json"]);
  const body =
    media.schema !== undefined
      ? JSON.stringify(syntheticBody(media.schema, document))
      : undefined;
  const headers =
    body === undefined ? "" : ', "Content-Type": "application/json"';
  return {
    curl: [
      `curl --request ${operation.method} '${safeUrl}'`,
      "  --header 'Authorization: Bearer <token>'",
      "  --header 'Accept: application/json'",
      ...(body === undefined
        ? []
        : [
            "  --header 'Content-Type: application/json'",
            `  --data '${body.replace(/'/g, "'\\''")}'`,
          ]),
    ].join(" \\\n"),
    javascript: [
      `const response = await fetch(${JSON.stringify(url.toString())}, {`,
      `  method: ${JSON.stringify(operation.method)},`,
      `  headers: { Authorization: "Bearer <token>", Accept: "application/json"${headers} },`,
      ...(body === undefined ? [] : [`  body: ${JSON.stringify(body)},`]),
      '  credentials: "omit",',
      '  cache: "no-store",',
      '  redirect: "error",',
      "});",
      "const data = await response.json();",
    ].join("\n"),
  };
}

export function buildReadUrl(
  document: unknown,
  operationId: string,
  origin: string,
  values: Record<string, string>,
): URL {
  const operation = indexOperations(document).find(
    (op) => op.id === operationId,
  );
  if (!operation) throw new Error("Select a documented operation");
  if (operation.method !== "GET")
    throw new Error("Only documented GET operations can execute");
  if (
    !operation.path.startsWith("/api/v1/") ||
    /[\\?#%]/.test(operation.path) ||
    operation.path
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Unsafe API target");
  const current = new URL(origin);
  if (
    !["https:", "http:"].includes(current.protocol) ||
    current.username ||
    current.password ||
    current.pathname !== "/" ||
    current.search ||
    current.hash
  )
    throw new Error("Unsafe API target origin");
  let path = operation.path;
  for (const param of operation.parameters) {
    const value = values[`${param.in}:${param.name}`] ?? "";
    if (param.required && value.trim() === "")
      throw new Error(`Required parameter: ${param.name}`);
    if (param.in === "path") {
      if (value === "." || value === ".." || /%2e/i.test(value))
        throw new Error(`Unsafe path parameter: ${param.name}`);
      path = path.replaceAll(`{${param.name}}`, encodeURIComponent(value));
    }
  }
  if (/[{}]/.test(path)) throw new Error("Missing path parameter");
  const target = new URL(path, current.origin);
  if (
    target.origin !== current.origin ||
    !target.pathname.startsWith("/api/v1/")
  )
    throw new Error("Unsafe API target");
  for (const param of operation.parameters.filter(
    (param) => param.in === "query",
  )) {
    const value = values[`query:${param.name}`];
    if (value !== undefined && value !== "")
      target.searchParams.set(param.name, value);
  }
  return target;
}

export async function runRead(options: {
  document: unknown;
  operationId: string;
  origin: string;
  values: Record<string, string>;
  token: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<ReadResult> {
  const url = buildReadUrl(
    options.document,
    options.operationId,
    options.origin,
    options.values,
  );
  if (!options.token.trim() || /[\r\n]/.test(options.token))
    throw new Error("Enter an API key or OAuth bearer token");
  if (options.signal?.aborted) throw new Error("Request cancelled");
  const controller = new AbortController();
  let timeout = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, 30_000);
  const start = performance.now();
  try {
    const response = await (options.fetcher ?? fetch)(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.token.trim()}`,
        Accept: "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error("Request aborted");
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      throw new Error("Redirects are not allowed");
    if (response.url && new URL(response.url).origin !== url.origin)
      throw new Error("Redirects are not allowed");
    const reader = response.body?.getReader(),
      decoder = new TextDecoder();
    let bytes = 0,
      body = "",
      truncated = false;
    if (reader) {
      const abortReader = () => {
        void reader.cancel().catch(() => {
          /* Abort is reported by the owning request. */
        });
      };
      controller.signal.addEventListener("abort", abortReader, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new Error("Request aborted");
          if (chunk.done) break;
          const remaining = MAX_RESPONSE_BYTES - bytes;
          body += decoder.decode(chunk.value.subarray(0, remaining), {
            stream: true,
          });
          bytes += chunk.value.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
        body += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", abortReader);
        reader.releaseLock();
      }
    }
    const contentType = response.headers.get("Content-Type") ?? "unknown";
    if (!truncated && contentType.includes("json")) {
      try {
        const formatted = JSON.stringify(JSON.parse(body), null, 2);
        if (formatted.length <= MAX_RESPONSE_BYTES) body = formatted;
      } catch {
        /* Preserve malformed JSON as plain text. */
      }
    }
    return {
      status: response.status,
      duration: Math.round(performance.now() - start),
      contentType,
      body,
      truncated,
    };
  } catch (error) {
    if (timeout) throw new Error("Request timed out after 30 seconds");
    if (controller.signal.aborted) throw new Error("Request cancelled");
    if (error instanceof Error && error.message === "Redirects are not allowed")
      throw error;
    // Raw network errors may include URLs or credentials; never render or log them.
    throw new Error(
      "Request failed. Check connectivity, token permissions and request parameters.",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
