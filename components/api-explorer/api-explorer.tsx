"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  asObject,
  buildReadUrl,
  examples,
  indexOperations,
  runRead,
  resolveSchema,
  schemaSummary,
  searchOperations,
  type ExplorerOperation,
  type ReadResult,
} from "@/lib/rest-explorer";
import { SchemaTree } from "./schema-tree";

const codeClass =
  "rounded-lg border border-border-default bg-surface-inset p-4 text-xs overflow-auto max-h-96 whitespace-pre max-w-full";
const linkedOperation = () =>
  new URLSearchParams(window.location.hash.slice(1)).get("operation");

export function ApiExplorer() {
  const [document, setDocument] = useState<unknown>(null);
  const [catalog, setCatalog] = useState<ExplorerOperation[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ReadResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("request");
  const [drawer, setDrawer] = useState(false);
  const [origin, setOrigin] = useState("");
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0),
    request = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    sequence.current++;
    request.current?.abort();
    request.current = null;
  }, []);
  const clearRequest = useCallback(() => {
    invalidate();
    setBusy(false);
    setResult(null);
    setError("");
  }, [invalidate]);
  const reset = useCallback(() => {
    clearRequest();
    setToken("");
    setValues({});
  }, [clearRequest]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    fetch("/api/v1/openapi.json", {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok || response.redirected)
          throw new Error("Contract unavailable");
        return response.json();
      })
      .then((value) => {
        const operations = indexOperations(value);
        if (!alive) return;
        setOrigin(window.location.origin);
        setDocument(value);
        setCatalog(operations);
        setLoadError(false);
        setOperationId(linkedOperation() ?? operations[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
      controller.abort();
      invalidate();
    };
  }, [attempt, invalidate]);

  useEffect(() => {
    const change = () => {
      clearRequest();
      setValues({});
      setOperationId(linkedOperation() ?? catalog[0]?.id ?? null);
      setTab("request");
    };
    window.addEventListener("hashchange", change);
    // bfcache can preserve React state; clear private state before the page is cached.
    const leaving = () => reset();
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("pagehide", leaving);
    };
  }, [catalog, clearRequest, reset]);

  const operation = catalog.find((op) => op.id === operationId);
  const filtered = useMemo(
    () => searchOperations(catalog, query),
    [catalog, query],
  );
  const groups = [...new Set(filtered.map((op) => op.group))].sort((a, b) =>
    a.localeCompare(b),
  );
  const sample =
    operation && origin ? examples(operation, document, origin) : null;
  const choose = (op: ExplorerOperation) => {
    clearRequest();
    setValues({});
    setOperationId(op.id);
    setTab("request");
    setDrawer(false);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}#operation=${encodeURIComponent(op.id)}`,
    );
  };
  const send = async () => {
    if (!operation || operation.method !== "GET" || request.current) return;
    const controller = new AbortController(),
      id = ++sequence.current;
    request.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    setTab("response");
    try {
      // Utility independently rechecks documentation, method, origin and parameters.
      buildReadUrl(document, operation.id, origin, values);
      const next = await runRead({
        document,
        operationId: operation.id,
        origin,
        values,
        token,
        signal: controller.signal,
      });
      if (sequence.current === id) setResult(next);
    } catch (failure) {
      if (sequence.current === id)
        setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      if (sequence.current === id) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const navigation = (
    <>
      <label
        htmlFor={drawer ? "operation-search-mobile" : "operation-search"}
        className="text-xs font-medium"
      >
        Find an operation
      </label>
      <Input
        id={drawer ? "operation-search-mobile" : "operation-search"}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search paths, names, methods…"
        className="mt-2 mb-4"
      />
      <nav aria-label="API operations" className="space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="text-xs text-text-subtle mb-2">{group}</p>
            {filtered
              .filter((op) => op.group === group)
              .map((op) => (
                <Button
                  key={op.id}
                  variant={op.id === operationId ? "secondary" : "ghost"}
                  className="w-full justify-start h-auto py-2 whitespace-normal text-left"
                  aria-label={`${op.method} ${op.summary}`}
                  onClick={() => choose(op)}
                  aria-current={op.id === operationId ? "true" : undefined}
                >
                  <span
                    className={
                      op.method === "GET"
                        ? "font-mono text-[10px] text-primary"
                        : "font-mono text-[10px] text-text-subtle"
                    }
                  >
                    {op.method}
                  </span>
                  <span
                    title={op.summary}
                    className="min-w-0 break-words text-xs line-clamp-2"
                  >
                    {op.summary}
                  </span>
                </Button>
              ))}
          </div>
        ))}
      </nav>
      {!filtered.length && (
        <p className="text-sm text-text-subtle">
          No operations match your search.
        </p>
      )}
      <p className="text-xs text-text-subtle mt-8">
        One contract, always current.
        <br />
        Generated from Compass OpenAPI.
      </p>
    </>
  );

  return (
    <section className="text-text-primary min-w-0" aria-label="API explorer">
      <div className="flex flex-wrap justify-between gap-4 mb-5">
        <div>
          <p className="text-xs text-text-subtle uppercase tracking-wider">
            Developer tools
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">
            Explore the Compass API
          </h1>
          <p className="text-sm text-text-secondary mt-2">
            Inspect the contract. Try a read. Build with confidence.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="xs" onClick={reset}>
            Reset session
          </Button>
          <p className="text-xs text-text-subtle self-center">
            OpenAPI {String(asObject(document).openapi ?? "3.1")} ·{" "}
            {catalog.length} operations
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-border-default bg-surface-inset p-3 mb-5 flex flex-wrap items-center gap-3 text-xs">
        <strong>Current deployment</strong>
        <code className="break-all">{origin || "This Compass deployment"}</code>
        <span className="text-primary">Reads only</span>
        <p className="text-text-secondary sm:ml-auto">
          Requests access real private data. Your token’s permissions apply.
        </p>
      </div>
      {loadError ? (
        <div
          role="alert"
          className="p-6 border border-border-default rounded-lg"
        >
          <p>Unable to load the OpenAPI contract.</p>
          <Button
            className="mt-3"
            onClick={() => {
              setLoadError(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : !document ? (
        <p role="status">Loading API contract…</p>
      ) : (
        <>
          <Sheet open={drawer} onOpenChange={setDrawer}>
            <SheetTrigger
              render={
                <Button variant="outline" className="md:hidden mb-4 w-full" />
              }
            >
              Browse operations
            </SheetTrigger>
            <SheetContent side="left" className="overflow-y-auto p-5">
              <SheetHeader>
                <SheetTitle>Browse operations</SheetTitle>
                <SheetDescription>
                  Search the generated API contract.
                </SheetDescription>
              </SheetHeader>
              {drawer && navigation}
            </SheetContent>
          </Sheet>
          <div className="grid md:grid-cols-[260px_minmax(0,1fr)] rounded-xl border border-border-default bg-surface-panel overflow-hidden">
            <aside className="hidden md:block bg-surface-navigation border-r border-border-default p-5 max-h-[850px] overflow-y-auto">
              {!drawer && navigation}
            </aside>
            <div className="min-w-0 p-4 sm:p-7">
              {!operation ? (
                <p role="status">
                  The linked operation is not in this deployment’s contract.
                  Choose an operation to continue.
                </p>
              ) : (
                <>
                  <p className="text-xs text-text-subtle uppercase tracking-wider">
                    {operation.group}
                  </p>
                  <h2 className="text-2xl font-semibold mt-1">
                    {operation.summary}
                  </h2>
                  <div className="flex items-start gap-3 mt-4">
                    <span className="text-primary font-mono text-xs pt-1">
                      {operation.method}
                    </span>
                    <code className="text-sm break-all min-w-0">
                      {operation.path}
                    </code>
                    <a
                      href={`#operation=${encodeURIComponent(operation.id)}`}
                      aria-label="Operation deep link"
                      className="ml-auto text-primary shrink-0"
                    >
                      ↗
                    </a>
                  </div>
                  <p className="text-sm text-text-secondary mt-3">
                    {operation.description ||
                      "Parameters, schemas and examples below are generated from the current API contract."}
                  </p>
                  <Tabs
                    value={tab}
                    onValueChange={(value) => setTab(String(value))}
                    className="mt-6"
                  >
                    <TabsList variant="line" className="max-w-full">
                      <TabsTrigger value="request">Request</TabsTrigger>
                      <TabsTrigger value="schema">Schema</TabsTrigger>
                      <TabsTrigger value="examples">Examples</TabsTrigger>
                      <TabsTrigger value="response">Response</TabsTrigger>
                    </TabsList>
                    <TabsContent value="request" className="mt-5">
                      <h3 className="font-medium mb-3">Parameters</h3>
                      {!operation.parameters.length && (
                        <p className="text-text-subtle">
                          No path or query parameters.
                        </p>
                      )}
                      {operation.parameters.map((param) => (
                        <div
                          key={`${param.in}:${param.name}`}
                          className="grid sm:grid-cols-[180px_minmax(0,1fr)] gap-2 sm:gap-4 my-4"
                        >
                          <label
                            htmlFor={`param-${param.in}-${param.name}`}
                            className="text-xs"
                          >
                            {param.name}
                            {param.required ? " *" : ""}
                            <span className="block text-text-subtle mt-1 break-words">
                              {param.in} · {schemaSummary(param.schema)}
                            </span>
                            {param.description && (
                              <span className="block text-text-secondary">
                                {param.description}
                              </span>
                            )}
                          </label>
                          <Input
                            id={`param-${param.in}-${param.name}`}
                            value={values[`${param.in}:${param.name}`] ?? ""}
                            autoComplete="off"
                            onChange={(event) => {
                              clearRequest();
                              setValues((current) => ({
                                ...current,
                                [`${param.in}:${param.name}`]:
                                  event.target.value,
                              }));
                            }}
                            aria-required={param.required}
                          />
                        </div>
                      ))}
                      {resolveSchema(operation.definition.requestBody, document)
                        .content !== undefined && (
                        <div className="mt-5">
                          <h3 className="font-medium">
                            Request body · documentation only
                          </h3>
                          {Object.entries(
                            asObject(
                              resolveSchema(
                                operation.definition.requestBody,
                                document,
                              ).content,
                            ),
                          ).map(([type, content]) => (
                            <div key={type}>
                              <p className="text-text-subtle text-xs mt-2">
                                {type}
                              </p>
                              <SchemaTree
                                value={asObject(content).schema}
                                document={document}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                      {operation.method === "GET" ? (
                        <div className="border-t border-border-default pt-5 mt-6">
                          <div className="flex justify-between gap-3">
                            <h3 className="font-medium">Authorization</h3>
                          </div>
                          <label
                            htmlFor="explorer-token"
                            className="text-xs block mt-3 mb-2"
                          >
                            API key or OAuth bearer token
                          </label>
                          <Input
                            id="explorer-token"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={token}
                            onChange={(event) => {
                              clearRequest();
                              setToken(event.target.value);
                            }}
                            placeholder="Paste your token"
                          />
                          <p className="text-xs text-text-subtle mt-2">
                            Kept in this page’s memory only. Never included in
                            examples. Browser sign-in does not authenticate API
                            requests.
                          </p>
                          <div className="flex flex-wrap items-center gap-3 mt-5">
                            <Button onClick={send} disabled={busy}>
                              Send GET request
                            </Button>
                            <p className="text-xs text-text-subtle">
                              No requests run automatically.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="border border-border-default rounded-lg p-4 mt-5 text-text-secondary">
                          Write operation · inspect schemas and examples only.
                          Execution is disabled in this explorer.
                        </p>
                      )}
                    </TabsContent>
                    <TabsContent value="schema" className="mt-5">
                      <h3 className="font-medium">Response schemas</h3>
                      {Object.entries(
                        asObject(operation.definition.responses),
                      ).map(([status, response]) => (
                        <div key={status} className="mt-4">
                          <h4 className="font-medium">
                            {status} ·{" "}
                            {String(
                              resolveSchema(response, document).description ??
                                "Response",
                            )}
                          </h4>
                          {Object.entries(
                            asObject(resolveSchema(response, document).content),
                          ).map(([type, content]) => (
                            <div key={type}>
                              <p className="text-xs text-text-subtle">{type}</p>
                              <SchemaTree
                                value={asObject(content).schema}
                                document={document}
                              />
                            </div>
                          ))}
                        </div>
                      ))}
                      <h3 className="font-medium mt-5">Raw operation schema</h3>
                      <pre className={`${codeClass} mt-3`}>
                        {JSON.stringify(operation.definition, null, 2)}
                      </pre>
                    </TabsContent>
                    <TabsContent value="examples" className="mt-5">
                      <h3 className="font-medium">cURL</h3>
                      <pre className={`${codeClass} mt-3`}>{sample?.curl}</pre>
                      <p className="text-xs text-text-subtle my-4">
                        Replace synthetic values and &lt;token&gt; with your own
                        values. Entered credentials and parameters are never
                        included here.
                      </p>
                      <h3 className="font-medium">JavaScript · fetch</h3>
                      <pre className={`${codeClass} mt-3`}>
                        {sample?.javascript}
                      </pre>
                    </TabsContent>
                    <TabsContent value="response" className="mt-5">
                      <div className="flex flex-wrap justify-between gap-3">
                        <h3 className="font-medium">Response</h3>
                      </div>
                      <div
                        role="status"
                        className="my-3 text-xs text-text-secondary"
                      >
                        {busy
                          ? "Sending GET request…"
                          : result
                            ? `${result.status} · ${result.duration} ms · ${result.contentType}`
                            : "No request sent."}
                      </div>
                      {busy && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            invalidate();
                            setBusy(false);
                            setError("Request cancelled");
                          }}
                        >
                          Cancel request
                        </Button>
                      )}
                      {error && (
                        <p role="alert" className="text-status-danger">
                          {error}
                        </p>
                      )}
                      {result && (
                        <>
                          <pre className={codeClass}>
                            {result.body || "(Empty response body)"}
                          </pre>
                          {result.truncated && (
                            <p className="text-xs text-status-warning mt-2">
                              Response truncated after 128 KiB. The remaining
                              response was not retained.
                            </p>
                          )}
                        </>
                      )}
                    </TabsContent>
                  </Tabs>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
