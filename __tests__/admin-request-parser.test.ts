import { describe, expect, it } from "vitest";
import { parseMigratePostBody } from "@/lib/migrations/admin-request";

const bad = (text: string) => parseMigratePostBody(text);

describe("parseMigratePostBody", () => {
  it("treats only a truly empty body as the legitimate untargeted apply", () => {
    for (const text of ["", "   ", "\n\t", "{}", " { } "]) expect(parseMigratePostBody(text), JSON.stringify(text)).toEqual({ ok: true, kind: "apply" });
  });

  it("accepts a named script and the one action", () => {
    expect(parseMigratePostBody('{"script":"068_workspace_id_on_solution_objective"}')).toEqual({ ok: true, kind: "apply", script: "068_workspace_id_on_solution_objective" });
    expect(parseMigratePostBody('{"action":"backfill-workspace-id"}')).toEqual({ ok: true, kind: "backfill-workspace-id" });
  });

  it("rejects malformed JSON", () => {
    for (const text of ["{", "nope", '{"a":', "'x'"]) expect(bad(text)).toEqual({ ok: false, error: "Request body is not valid JSON." });
  });

  it("rejects valid JSON that is not an object", () => {
    for (const text of ["[]", "[1]", '"068"', "123", "true", "false", "null"]) expect(bad(text), text).toMatchObject({ ok: false, error: expect.stringContaining("JSON object") });
  });

  it("rejects unknown keys, listing them", () => {
    expect(bad('{"scrpt":"x"}')).toEqual({ ok: false, error: 'Unknown field: "scrpt". Allowed: "script" or "action".' });
    expect(bad('{"script":"x","a":1,"b":2}')).toMatchObject({ ok: false, error: expect.stringContaining('"a", "b"') });
  });

  it("rejects action together with script, and any other action", () => {
    expect(bad('{"action":"backfill-workspace-id","script":"x"}')).toMatchObject({ ok: false, error: expect.stringContaining("not both") });
    for (const action of ['"backfill-workspaceid"', '""', "null", "1", "[]", "{}", "true"]) expect(bad(`{"action":${action}}`), action).toMatchObject({ ok: false, error: expect.stringContaining("Unknown action") });
  });

  it("rejects a script that is not a non-empty string", () => {
    for (const script of ["123", "[]", '""', "null", "{}", "true", "false", "0", '["068"]']) expect(bad(`{"script":${script}}`), script).toMatchObject({ ok: false, error: expect.stringContaining("non-empty string") });
  });
});
