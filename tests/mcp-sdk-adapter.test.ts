import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  JsonRpcFailure,
  unwrapDispatchResponse,
} from "../src/mcp-sdk-adapter.ts";

// `unwrapDispatchResponse` reads a dispatch response's error through GUARDS
// rather than asserting it (#11339).
//
// It used to return `unknown`, which forced `... as never` at the SDK handler
// and read `error.code as number` / `error.message as string` on the way. This
// unwraps whatever `dispatchMessage` produced, so a malformed error object must
// not become a JsonRpcFailure carrying `undefined` as its code -- a JSON-RPC
// reply with a null code is not a reply a client can act on.
describe("unwrapDispatchResponse error narrowing (#11339)", () => {
  test("a numeric code and string message pass through", () => {
    assert.throws(
      () =>
        unwrapDispatchResponse({
          error: { code: -32001, message: "nope", data: { x: 1 } },
        }),
      (err: JsonRpcFailure) => err.code === -32001 && err.message === "nope",
    );
  });

  test("a NON-NUMERIC code degrades to the internal-error code", () => {
    assert.throws(
      () => unwrapDispatchResponse({ error: { code: "-32001", message: "x" } }),
      (err: JsonRpcFailure) => typeof err.code === "number",
    );
  });

  test("a MISSING message degrades to a usable one", () => {
    assert.throws(
      () => unwrapDispatchResponse({ error: { code: -1 } }),
      (err: JsonRpcFailure) => err.message === "Internal error.",
    );
  });

  test("a non-object `error` is not an error -- it falls through to result", () => {
    // `typeof null === "object"` is the hole; `recordOrNull` closes it, so a
    // response carrying `error: null` is a SUCCESS, which is what JSON-RPC says
    // it is.
    assert.deepEqual(
      unwrapDispatchResponse({ error: null, result: { ok: 1 } }),
      {
        ok: 1,
      },
    );
  });

  test("a response with neither result nor error throws rather than replying", () => {
    // Unreachable through dispatchMessage, and deliberately loud: an SDK
    // handler returning undefined publishes `{"result":undefined}`, which
    // JSON.stringify drops -- a reply with neither half.
    assert.throws(() => unwrapDispatchResponse({}));
    assert.throws(() => unwrapDispatchResponse(null));
  });
});
