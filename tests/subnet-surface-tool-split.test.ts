// #11568: the surface-call tool was a catch-all whose `method` argument spanned
// GET/HEAD and POST/PUT/PATCH/DELETE. The Connectors Directory review criteria
// name that exact shape as an automatic rejection -- "do not ship a catch-all
// `api_request` tool with a `method` parameter" -- and say outright that
// documenting the split inside one description does not satisfy it.
//
// The split is enforced in the HANDLER, not by the published schema: MCP
// dispatch does not validate arguments against the Zod schema, so a narrowed
// enum is advertisement. These tests exercise the enforcement.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import {
  CALL_SURFACE_METHODS,
  CALL_SURFACE_READ_METHODS,
  CALL_SURFACE_WRITE_METHODS,
} from "../schemas-src/mcp-tools/ai-integration.ts";
import { mockEnv, type Row } from "./row-type.ts";

const READ = "call_subnet_surface";
const WRITE = "write_subnet_surface";

async function call(name: string, args: Row) {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    mockEnv({}) as Env,
    {},
  );
  return ((await response.json()) as Row).result as Row;
}

const errorOf = (result: Row) =>
  ((result?.structuredContent as Row)?.error ?? {}) as Row;

describe("the verb sets partition CALL_SURFACE_METHODS", () => {
  test("every method belongs to exactly one tool", () => {
    // Derived, not restated: a verb added to CALL_SURFACE_METHODS lands in one
    // set or the other and cannot silently appear in neither.
    const union = [
      ...CALL_SURFACE_READ_METHODS,
      ...CALL_SURFACE_WRITE_METHODS,
    ].sort();
    assert.deepEqual(union, [...CALL_SURFACE_METHODS].sort());
    for (const method of CALL_SURFACE_READ_METHODS) {
      assert.ok(
        !(CALL_SURFACE_WRITE_METHODS as readonly string[]).includes(method),
        method,
      );
    }
  });

  test("the read set is exactly the HTTP-safe verbs", () => {
    // What makes `readOnlyHint: true` truthful, and therefore what lets a
    // client run the read tool without a per-call confirmation.
    assert.deepEqual([...CALL_SURFACE_READ_METHODS], ["GET", "HEAD"]);
  });
});

describe("both tools are registered and published distinctly", () => {
  const byName = new Map(
    (listToolDefinitions() as Row[]).map((def) => [def.name as string, def]),
  );

  test("each exists", () => {
    assert.ok(byName.get(READ), `${READ} must be registered`);
    assert.ok(byName.get(WRITE), `${WRITE} must be registered`);
  });

  test("the read tool publishes no request body at all", () => {
    // A read tool advertising a `body` invites an agent to attempt a write
    // through it and be refused -- the confusion the split exists to remove.
    const props = ((byName.get(READ)!.inputSchema as Row).properties ??
      {}) as Row;
    assert.ok(!("body" in props), "read tool must not advertise a body");
    assert.ok(!("content_type" in props));
    assert.deepEqual((props.method as Row).enum, [
      ...CALL_SURFACE_READ_METHODS,
    ]);
  });

  test("the write tool requires the operation to be named", () => {
    // There is no curated write: a write always names a declared operation,
    // and making that structural stops an agent discovering it by refusal.
    const schema = byName.get(WRITE)!.inputSchema as Row;
    const required = (schema.required ?? []) as string[];
    assert.ok(required.includes("path"), "path must be required");
    assert.ok(required.includes("method"), "method must be required");
    assert.deepEqual(((schema.properties as Row).method as Row).enum, [
      ...CALL_SURFACE_WRITE_METHODS,
    ]);
  });

  test("both names are within the directory's 64-character limit", () => {
    for (const name of [READ, WRITE]) assert.ok(name.length <= 64, name);
  });
});

describe("the handler enforces the split", () => {
  test("the read tool refuses every write verb and names the sibling", async () => {
    for (const method of CALL_SURFACE_WRITE_METHODS) {
      const error = errorOf(
        await call(READ, { surface_id: "sn-1-example", path: "/x", method }),
      );
      assert.equal(error.code, "invalid_params", method);
      assert.match(String(error.message), new RegExp(WRITE), method);
      // An agent that guessed wrong has a correct intent and a wrong address;
      // being told only "no" turns a one-step correction into a dead end.
      assert.match(String(error.message), /GET, HEAD/, method);
    }
  });

  test("the write tool refuses every read verb and names the sibling", async () => {
    for (const method of CALL_SURFACE_READ_METHODS) {
      const error = errorOf(
        await call(WRITE, { surface_id: "sn-1-example", path: "/x", method }),
      );
      assert.equal(error.code, "invalid_params", method);
      assert.match(String(error.message), new RegExp(READ), method);
    }
  });

  test("a verb in neither set still gets the enum message, not the sibling one", async () => {
    // The sibling hint is only correct when the verb exists somewhere. Telling
    // a caller who sent TRACE to "use write_subnet_surface" would be a lie.
    const error = errorOf(
      await call(READ, {
        surface_id: "sn-1-example",
        path: "/x",
        method: "TRACE",
      }),
    );
    assert.equal(error.code, "invalid_params");
    assert.doesNotMatch(String(error.message), new RegExp(WRITE));
  });

  test("the verb check runs before any schema fetch", async () => {
    // A caller that reached the wrong tool has not earned the work. An
    // unknown surface_id would otherwise be the first complaint, which would
    // hide the actual mistake.
    const error = errorOf(
      await call(READ, {
        surface_id: "sn-999-does-not-exist",
        path: "/x",
        method: "DELETE",
      }),
    );
    assert.match(String(error.message), new RegExp(WRITE));
  });

  test("case is normalised, so a lowercase verb is routed the same way", async () => {
    const error = errorOf(
      await call(READ, {
        surface_id: "sn-1-example",
        path: "/x",
        method: "post",
      }),
    );
    assert.match(String(error.message), new RegExp(WRITE));
  });
});

// Argument-shape refusals that run BEFORE any surface is resolved. They moved
// with the extraction in #11568 and were never exercised; each one exists to
// stop a malformed call reaching the outbound fetch path, so leaving them
// unproven would mean trusting a guard nothing has ever fired.
describe("body-argument guards", () => {
  test("a body that is neither string nor object is refused", async () => {
    for (const body of [42, true, ["a"], null]) {
      const args: Row = {
        surface_id: "sn-1-example",
        path: "/x",
        method: "POST",
        body,
      };
      const error = errorOf(await call(WRITE, args));
      // `null` reads as "no body supplied" rather than a malformed one, so it
      // is the one value here that must NOT be refused for its shape.
      if (body === null) {
        assert.notEqual(
          String(error.message ?? ""),
          "`body` must be a string or object.",
        );
        continue;
      }
      assert.equal(error.code, "invalid_params", String(body));
      assert.match(String(error.message), /`body` must be a string or object/);
    }
  });

  test("content_type without a body is refused", async () => {
    // A content type describes a body. Accepting one without it would send a
    // header that describes nothing, which is the kind of quiet wrongness that
    // surfaces later as an unexplained 415 from someone else's host.
    const error = errorOf(
      await call(WRITE, {
        surface_id: "sn-1-example",
        path: "/x",
        method: "POST",
        content_type: "application/json",
      }),
    );
    assert.equal(error.code, "invalid_params");
    assert.match(String(error.message), /`content_type` requires `body`/);
  });

  test("the READ tool rejects a body at dispatch, before the handler sees it", async () => {
    // Dispatch DOES reject unknown argument names against the published
    // schema, so dropping `body` from the read tool's schema is enforcement
    // and not merely advertisement. (Enum VALUES are a different matter --
    // see the verb tests above, which is why the handler still checks those.)
    const error = errorOf(
      await call(READ, { surface_id: "sn-1-example", body: { a: 1 } }),
    );
    assert.match(String(error.message), /Unknown argument for tool/);
    assert.match(String(error.message), /`body`/);
  });

  test("a body with no operation is refused on the write tool", async () => {
    // `path` is required by the write schema, but required-ness is not what
    // dispatch enforces -- so the handler is what stops a body with nowhere
    // to go.
    const error = errorOf(
      await call(WRITE, { surface_id: "sn-1-example", body: { a: 1 } }),
    );
    assert.equal(error.code, "invalid_params");
    assert.match(String(error.message), /`body` requires `path` and `method`/);
  });
});
